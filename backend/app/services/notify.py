import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_maker
from app.models.rca import RCA, RCASeverity, RCAStatus
from app.models.user import User
from app.services.slack_service import slack_service

logger = logging.getLogger(__name__)

_background_tasks: set[asyncio.Task] = set()

STATUS_EMOJI = {
    RCAStatus.OPEN: ":eyes:",
    RCAStatus.IN_PROGRESS: ":hammer_and_wrench:",
    RCAStatus.RCA_DONE: ":memo:",
    RCAStatus.CLOSED: ":lock:",
}

STATUS_LABELS = {
    RCAStatus.OPEN: "Open",
    RCAStatus.IN_PROGRESS: "In Progress",
    RCAStatus.RCA_DONE: "RCA Done",
    RCAStatus.CLOSED: "Closed",
}

STATUS_COLOR = {
    RCAStatus.OPEN: "#3B82F6",
    RCAStatus.IN_PROGRESS: "#F59E0B",
    RCAStatus.RCA_DONE: "#8B5CF6",
    RCAStatus.CLOSED: "#6B7280",
}

SEVERITY_EMOJI = {
    RCASeverity.SEV1: ":red_circle:",
    RCASeverity.SEV2: ":large_orange_circle:",
    RCASeverity.SEV3: ":large_yellow_circle:",
}

SEVERITY_LABELS = {
    RCASeverity.SEV1: "SEV1",
    RCASeverity.SEV2: "SEV2",
    RCASeverity.SEV3: "SEV3",
}

SEVERITY_COLOR = {
    RCASeverity.SEV1: "#DC2626",
    RCASeverity.SEV2: "#EA580C",
    RCASeverity.SEV3: "#EAB308",
}


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _rca_url(rca_id: int) -> str:
    return f"{settings.app_base_url.rstrip('/')}/rcas/{rca_id}"


def _mention(slack_id: str | None, name: str) -> str:
    return f"<@{slack_id}>" if slack_id else name


async def _resolve_slack_id(db: AsyncSession, email: str) -> str | None:
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user and user.slack_id:
        return user.slack_id
    info = await slack_service.lookup_by_email(email)
    if not info or not info.get("id"):
        return None
    if user:
        user.slack_id = info["id"]
        await db.commit()
    return info["id"]


def _open_button_block(url: str) -> dict:
    return {
        "type": "actions",
        "elements": [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Open RCA"},
                "url": url,
                "style": "primary",
            }
        ],
    }


def _assignment_attachment(
    rca: RCA, actor_mention: str, recipient_mention: str
) -> tuple[str, list[dict]]:
    url = _rca_url(rca.id)
    status_label = STATUS_LABELS.get(rca.status, str(rca.status))
    fallback = rca.title
    attachments = [
        {
            "color": "#3B82F6",
            "blocks": [
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": ":bust_in_silhouette: *You've been assigned an RCA*"},
                },
                {"type": "section", "text": {"type": "mrkdwn", "text": f">{rca.title}"}},
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Status:* `{status_label}`"},
                        {"type": "mrkdwn", "text": f"*Assigned to:* {recipient_mention}"},
                        {"type": "mrkdwn", "text": f"*Assigned by:* {actor_mention}"},
                    ],
                },
                _open_button_block(url),
            ],
        }
    ]
    return fallback, attachments


def _assignment_broadcast_attachment(
    rca: RCA, actor_mention: str, added_text: str
) -> tuple[str, list[dict]]:
    url = _rca_url(rca.id)
    status_label = STATUS_LABELS.get(rca.status, str(rca.status))
    fallback = rca.title
    attachments = [
        {
            "color": "#3B82F6",
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": ":bust_in_silhouette: *Assignment update*"}},
                {"type": "section", "text": {"type": "mrkdwn", "text": f">{rca.title}"}},
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Status:* `{status_label}`"},
                        {"type": "mrkdwn", "text": f"*Newly assigned:* {added_text}"},
                        {"type": "mrkdwn", "text": f"*Changed by:* {actor_mention}"},
                    ],
                },
                _open_button_block(url),
            ],
        }
    ]
    return fallback, attachments


def _status_attachment(
    rca: RCA, old: RCAStatus, new: RCAStatus, actor_mention: str
) -> tuple[str, list[dict]]:
    url = _rca_url(rca.id)
    old_label = STATUS_LABELS.get(old, str(old))
    new_label = STATUS_LABELS.get(new, str(new))
    new_emoji = STATUS_EMOJI.get(new, ":grey_question:")
    color = STATUS_COLOR.get(new, "#6B7280")
    fallback = rca.title
    attachments = [
        {
            "color": color,
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"{new_emoji} *Status Updated*  ·  ~{old_label}~ → *{new_label}*  ·  by {actor_mention}",
                    },
                },
                {"type": "section", "text": {"type": "mrkdwn", "text": f">{rca.title}"}},
                _open_button_block(url),
            ],
        }
    ]
    return fallback, attachments


async def _send_assigned(
    rca_id: int, actor_email: str, actor_name: str, added_emails: list[str]
) -> None:
    try:
        added_set = set(added_emails)
        async with async_session_maker() as db:
            rca = (await db.execute(select(RCA).where(RCA.id == rca_id))).scalar_one_or_none()
            if not rca:
                return
            actor_slack_id = await _resolve_slack_id(db, actor_email)
            actor_mention = _mention(actor_slack_id, actor_name)

            all_involved = (
                {rca.creator_email} | {a.user_email for a in rca.assignees} | added_set
            )
            if not all_involved:
                return

            added_mentions: list[str] = []
            for added_email in added_emails:
                if added_email == actor_email:
                    continue
                added_slack = await _resolve_slack_id(db, added_email)
                added_row = (
                    await db.execute(select(User).where(User.email == added_email))
                ).scalar_one_or_none()
                added_name_str = added_row.name if added_row else added_email
                added_mentions.append(_mention(added_slack, added_name_str))
            added_text = ", ".join(added_mentions) if added_mentions else "(none)"

            for email in all_involved:
                # Isolate each recipient: one failed DM must not abort the rest.
                try:
                    slack_id = await _resolve_slack_id(db, email)
                    if not slack_id:
                        logger.info("No slack id for %s; skipping DM", email)
                        continue
                    row = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
                    recipient_name = row.name if row else email
                    recipient_mention = _mention(slack_id, recipient_name)

                    if email in added_set:
                        fallback, attachments = _assignment_attachment(rca, actor_mention, recipient_mention)
                    else:
                        fallback, attachments = _assignment_broadcast_attachment(rca, actor_mention, added_text)
                    await slack_service.post_dm(slack_id, text=fallback, attachments=attachments)
                except Exception:
                    logger.exception("notify_assigned: failed to DM %s for rca=%s", email, rca_id)
    except Exception:
        logger.exception("notify_assigned failed for rca=%s", rca_id)


async def _send_status_changed(
    rca_id: int, actor_email: str, actor_name: str, old: RCAStatus, new: RCAStatus
) -> None:
    try:
        logger.info("notify_status_changed firing rca=%s %s->%s by=%s", rca_id, old, new, actor_email)
        async with async_session_maker() as db:
            rca = (await db.execute(select(RCA).where(RCA.id == rca_id))).scalar_one_or_none()
            if not rca:
                logger.warning("notify_status_changed: rca %s not found", rca_id)
                return
            recipients = {rca.creator_email} | {a.user_email for a in rca.assignees}
            logger.info("notify_status_changed recipients=%s", recipients)
            if not recipients:
                return
            actor_slack_id = await _resolve_slack_id(db, actor_email)
            actor_mention = _mention(actor_slack_id, actor_name)
            fallback, attachments = _status_attachment(rca, old, new, actor_mention)
            for email in recipients:
                # Isolate each recipient: one failed DM must not abort the rest.
                try:
                    slack_id = await _resolve_slack_id(db, email)
                    if not slack_id:
                        logger.info("notify_status_changed: no slack_id for %s", email)
                        continue
                    logger.info("notify_status_changed: posting DM to %s (slack_id=%s)", email, slack_id)
                    resp = await slack_service.post_dm(slack_id, text=fallback, attachments=attachments)
                    logger.info("notify_status_changed: post_dm returned %s", "ok" if resp else "None")
                except Exception:
                    logger.exception("notify_status_changed: failed to DM %s for rca=%s", email, rca_id)
    except Exception:
        logger.exception("notify_status_changed failed for rca=%s", rca_id)


_DM_ITEM_MAX_LEN = 140
_DM_ITEMS_SHOWN = 5


def _dm_item_text(s: str) -> str:
    """Collapse newlines/whitespace and cap length so an action item renders
    as a single tidy bullet in Slack, even if the underlying text was multi-
    line or very long."""
    collapsed = " ".join((s or "").split())
    if len(collapsed) <= _DM_ITEM_MAX_LEN:
        return collapsed
    return collapsed[: _DM_ITEM_MAX_LEN - 1].rstrip() + "…"


def _action_items_assigned_attachment(
    rca: RCA, actor_mention: str, items: list[str]
) -> tuple[str, list[dict]]:
    """Slack attachment for the 'you've been assigned an action item' DM.
    Mirrors the look of the RCA-assignment / status-change attachments."""
    url = _rca_url(rca.id)
    status_label = STATUS_LABELS.get(rca.status, str(rca.status))
    n = len(items)
    header = (
        f":clipboard: *You've been assigned {n} action item{'s' if n != 1 else ''}*"
    )
    shown = [_dm_item_text(it) for it in items[:_DM_ITEMS_SHOWN]]
    items_md = "\n".join(f"• {it}" for it in shown)
    if n > len(shown):
        items_md += f"\n• …and {n - len(shown)} more"
    fallback = f"Action items assigned to you in: {rca.title}"
    attachments = [
        {
            "color": "#10B981",  # emerald, distinct from the blue assignment DM
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": header}},
                {"type": "section", "text": {"type": "mrkdwn", "text": f">{rca.title}"}},
                {"type": "section", "text": {"type": "mrkdwn", "text": items_md}},
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*RCA status:* `{status_label}`"},
                        {"type": "mrkdwn", "text": f"*Assigned by:* {actor_mention}"},
                    ],
                },
                _open_button_block(url),
            ],
        }
    ]
    return fallback, attachments


async def _send_action_items_assigned(
    rca_id: int,
    actor_email: str,
    actor_name: str,
    assignments: list[tuple[str, str]],
) -> None:
    try:
        # Group items by recipient email so one person gets one consolidated DM
        # even if they were newly assigned to several items in the same save.
        by_owner: dict[str, list[str]] = {}
        for email, action_text in assignments:
            by_owner.setdefault(email, []).append(action_text)

        logger.info(
            "notify_action_items_assigned firing rca=%s actor=%s recipients=%s",
            rca_id, actor_email, sorted(by_owner.keys()),
        )

        async with async_session_maker() as db:
            rca = (
                await db.execute(select(RCA).where(RCA.id == rca_id))
            ).scalar_one_or_none()
            if not rca:
                return
            actor_slack_id = await _resolve_slack_id(db, actor_email)
            actor_mention = _mention(actor_slack_id, actor_name)

            for owner_email, items in by_owner.items():
                # Isolate per recipient: one failure must not abort the batch.
                # NOTE: self-assignment IS DM'd here (unlike RCA-level notify_assigned),
                # because action items are personal todos and the DM is a useful
                # "you took this on" reminder + a one-click link back to the RCA.
                try:
                    slack_id = await _resolve_slack_id(db, owner_email)
                    if not slack_id:
                        logger.info(
                            "No slack id for %s; skipping action-item DM", owner_email
                        )
                        continue
                    fallback, attachments = _action_items_assigned_attachment(
                        rca, actor_mention, items
                    )
                    logger.info(
                        "notify_action_items_assigned: posting DM to %s (slack_id=%s, items=%d)",
                        owner_email, slack_id, len(items),
                    )
                    resp = await slack_service.post_dm(
                        slack_id, text=fallback, attachments=attachments
                    )
                    logger.info(
                        "notify_action_items_assigned: post_dm to %s returned %s",
                        owner_email, "ok" if resp else "None",
                    )
                except Exception:
                    logger.exception(
                        "notify_action_items_assigned: failed to DM %s for rca=%s",
                        owner_email,
                        rca_id,
                    )
    except Exception:
        logger.exception("notify_action_items_assigned failed for rca=%s", rca_id)


def notify_assigned(
    rca_id: int, actor_email: str, actor_name: str, added_emails: list[str]
) -> None:
    if not added_emails:
        return
    _spawn(_send_assigned(rca_id, actor_email, actor_name, added_emails))


def notify_status_changed(
    rca_id: int, actor_email: str, actor_name: str, old: RCAStatus, new: RCAStatus
) -> None:
    _spawn(_send_status_changed(rca_id, actor_email, actor_name, old, new))


def notify_action_items_assigned(
    rca_id: int,
    actor_email: str,
    actor_name: str,
    assignments: list[tuple[str, str]],
) -> None:
    if not assignments:
        return
    _spawn(_send_action_items_assigned(rca_id, actor_email, actor_name, assignments))
