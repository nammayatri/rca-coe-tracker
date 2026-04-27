"""Fire-and-forget enrichment of a user record from Slack.

When someone logs in for the first time we typically only have their email
(and a name fallback derived from the email's local-part). If the Slack bot
has `users:read.email`, we can resolve the user's real Slack profile and
fill in `slack_id` + their proper display name.

This runs as a background task so the request returns immediately. Failures
are logged and swallowed — the user can always be enriched later via the
`scripts/enrich_user_names.py` one-shot.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_maker
from app.models.user import User
from app.services.slack_service import slack_service

logger = logging.getLogger(__name__)

# Hold strong refs to background tasks so the GC doesn't kill them mid-flight.
_background_tasks: set[asyncio.Task] = set()


def _name_looks_like_fallback(email: str, name: str | None) -> bool:
    """True if `name` is just the email or its local-part — i.e., we never
    got a real display name. Real names like 'Vijay Gupta' won't match."""
    if not name:
        return True
    local = email.split("@", 1)[0]
    return name == email or name == local


async def _enrich(email: str) -> None:
    try:
        info = await slack_service.lookup_by_email(email)
        if not info or not info.get("id"):
            return

        slack_id = info["id"]
        slack_name = (info.get("name") or "").strip() or None

        async with async_session_maker() as db:  # type: AsyncSession
            user = (
                await db.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if not user:
                return

            updates: dict = {}
            if user.slack_id != slack_id:
                updates["slack_id"] = slack_id
            if slack_name and _name_looks_like_fallback(user.email, user.name):
                updates["name"] = slack_name
            if not updates:
                return

            await db.execute(
                update(User).where(User.email == email).values(**updates)
            )
            await db.commit()
            logger.info(
                "enriched %s from Slack: %s",
                email,
                ", ".join(f"{k}={v}" for k, v in updates.items()),
            )
    except Exception:
        logger.exception("enrich failed for %s", email)


def maybe_enrich(email: str) -> None:
    """Schedule a Slack enrichment for `email` if the Slack client is wired."""
    if slack_service.client is None:
        return
    task = asyncio.create_task(_enrich(email))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
