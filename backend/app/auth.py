import base64
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.services import user_enrich

logger = logging.getLogger(__name__)


@dataclass
class UserCtx:
    email: str
    name: str
    is_admin: bool


def _b64url_pad(s: str) -> bytes:
    # JWT base64url segments are unpadded; restore = padding to a multiple of 4.
    return (s + "=" * (-len(s) % 4)).encode("ascii")


def _decode_jwt_claims(token: str) -> dict | None:
    """Decode a JWT *without* verifying its signature. The request already
    passed the trusted upstream proxy, so we only need the claims for identity.
    """
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = base64.urlsafe_b64decode(_b64url_pad(parts[1]))
        return json.loads(payload)
    except Exception:
        return None


def _read_pomerium_identity(request: Request) -> tuple[str, str] | None:
    headers = request.headers

    # 1. Direct claim headers (older Pomerium, oauth2-proxy, custom proxies).
    email = (
        headers.get("x-pomerium-claim-email")
        or headers.get("x-pomerium-user-email")
        or headers.get("x-forwarded-email")
        or headers.get("x-auth-request-email")
    )
    if email:
        name = (
            headers.get("x-pomerium-claim-name")
            or headers.get("x-pomerium-user-name")
            or headers.get("x-forwarded-user")
            or headers.get("x-auth-request-user")
            or email.split("@")[0]
        )
        return email.lower(), name

    # 2. Newer Pomerium: a single signed JWT assertion carries every claim.
    jwt = headers.get("x-pomerium-jwt-assertion") or headers.get("x-pomerium-assertion")
    if jwt:
        claims = _decode_jwt_claims(jwt) or {}
        # Look for email in the standard places. NEVER fall back to sub — that's
        # a numeric IdP user id, not an email.
        email = (
            claims.get("email")
            or claims.get("preferred_username")
            or claims.get("upn")
        )
        if email and "@" in email:
            name = (
                claims.get("name")
                or claims.get("given_name")
                or claims.get("user")
                or email.split("@")[0]
            )
            return email.lower(), name

    return None


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> UserCtx:
    identity = _read_pomerium_identity(request)
    if identity is None and settings.dev_fake_email:
        identity = (
            settings.dev_fake_email.lower(),
            settings.dev_fake_name or settings.dev_fake_email.split("@")[0],
        )
    if identity is None:
        # Help future debugging by surfacing which proxy headers we DID see.
        seen = sorted(
            k for k in request.headers.keys()
            if k.lower().startswith(("x-pomerium", "x-forwarded", "x-auth-request"))
        )
        logger.warning("missing pomerium identity; saw proxy headers: %s", seen or "(none)")
        raise HTTPException(
            status_code=401,
            detail={"error": "missing pomerium identity", "proxy_headers_seen": seen},
        )

    email, name = identity
    seed_admin = email in settings.admin_email_list

    stmt = (
        pg_insert(User)
        .values(email=email, name=name, is_admin=seed_admin)
        .on_conflict_do_update(
            index_elements=[User.email],
            set_={
                "name": name,
                "last_seen_at": datetime.now(timezone.utc),
            },
        )
    )
    await db.execute(stmt)

    if seed_admin:
        await db.execute(
            User.__table__.update().where(User.email == email).values(is_admin=True)
        )

    user_row = (await db.execute(select(User).where(User.email == email))).scalar_one()

    # First-login enrichment: if we don't have a Slack id for this user yet,
    # async-resolve their real name + slack_id from Slack. Fire-and-forget
    # so the request isn't blocked on the Slack round-trip.
    if not user_row.slack_id:
        user_enrich.maybe_enrich(email)

    return UserCtx(email=email, name=name, is_admin=bool(user_row.is_admin))


async def require_admin(user: UserCtx = Depends(get_current_user)) -> UserCtx:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin required")
    return user


def can_edit_rca(user: UserCtx, creator_email: str, assignee_emails: set[str]) -> bool:
    if user.is_admin:
        return True
    if user.email == creator_email:
        return True
    return user.email in assignee_emails


def can_delete_rca(user: UserCtx, creator_email: str) -> bool:
    return user.is_admin or user.email == creator_email
