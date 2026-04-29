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


def _looks_like_real_name(value: str | None) -> bool:
    """A real human name has at least one non-digit, non-`@` character. The
    `User-Name` header in some Pomerium versions carries the IdP subject id
    (a long numeric string) rather than a display name — reject those."""
    if not value:
        return False
    s = value.strip()
    if not s or "@" in s:
        return False
    return any(not ch.isdigit() for ch in s)


def _read_pomerium_identity(request: Request) -> tuple[str, str] | None:
    headers = request.headers

    # 1. Prefer the signed JWT assertion when present — it carries the full
    #    claim set (email, name, given_name, family_name, hd, …) and can't be
    #    confused with a stand-alone "X-Pomerium-User-Name" header that some
    #    versions populate with the IdP subject id (a numeric sub).
    jwt = headers.get("x-pomerium-jwt-assertion") or headers.get("x-pomerium-assertion")
    if jwt:
        claims = _decode_jwt_claims(jwt) or {}
        email = (
            claims.get("email")
            or claims.get("preferred_username")
            or claims.get("upn")
        )
        if isinstance(email, str) and "@" in email:
            given = claims.get("given_name") or ""
            family = claims.get("family_name") or ""
            full = f"{given} {family}".strip()
            name_candidate = (
                claims.get("name")
                or (full if _looks_like_real_name(full) else None)
                or claims.get("given_name")
                or email.split("@")[0]
            )
            return email.lower(), name_candidate

    # 2. Legacy / oauth2-proxy-style claim headers.
    email = (
        headers.get("x-pomerium-claim-email")
        or headers.get("x-pomerium-user-email")
        or headers.get("x-forwarded-email")
        or headers.get("x-auth-request-email")
    )
    if email:
        # Build the name candidate list, then pick the first that actually
        # looks like a name (rejecting numeric subject ids).
        candidates = [
            headers.get("x-pomerium-claim-name"),
            headers.get("x-pomerium-claim-given-name"),
            headers.get("x-forwarded-user"),
            headers.get("x-auth-request-user"),
            headers.get("x-pomerium-user-name"),
        ]
        name = next((c for c in candidates if _looks_like_real_name(c)), email.split("@")[0])
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

    # Never overwrite a real name with a fallback. Pomerium doesn't always
    # forward a `name` claim; when it doesn't, our resolver falls back to
    # the email's local-part. That fallback should NOT clobber a real name
    # in the DB on every login (otherwise it ping-pongs with user_enrich
    # which keeps re-resolving the proper name from Slack).
    local = email.split("@", 1)[0]
    name_is_fallback = (not name) or name == local or name == email
    update_set: dict = {"last_seen_at": datetime.now(timezone.utc)}
    if not name_is_fallback:
        update_set["name"] = name

    stmt = (
        pg_insert(User)
        .values(email=email, name=name, is_admin=seed_admin)
        .on_conflict_do_update(index_elements=[User.email], set_=update_set)
    )
    await db.execute(stmt)

    if seed_admin:
        await db.execute(
            User.__table__.update().where(User.email == email).values(is_admin=True)
        )

    user_row = (await db.execute(select(User).where(User.email == email))).scalar_one()

    # Auto-enrich whenever we don't have a Slack id yet, OR the stored name
    # looks like the email-prefix fallback (i.e. Pomerium's JWT didn't carry
    # a `name` claim and we ended up using the local part). Fire-and-forget.
    local = email.split("@", 1)[0]
    name_is_fallback = (not user_row.name) or user_row.name == local or user_row.name == email
    if not user_row.slack_id or name_is_fallback:
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
