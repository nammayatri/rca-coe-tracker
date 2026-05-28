import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import UserCtx, get_current_user, require_admin, can_edit_rca, can_delete_rca
from app.database import get_db
from app.models.rca import RCA, RCASeverity, RCAStatus
from app.models.rca_assignee import RCAAssignee
from app.models.rca_history import RCAHistory
from app.models.user import User
from app.schemas.rca import (
    RCACreate,
    RCAListOut,
    RCAOut,
    RCAPatch,
    StatusChange,
    HistoryEntryOut,
)
from app.schemas.user import UserOut
from app.services import notify, ai_summary

router = APIRouter(prefix="/api/rcas", tags=["rcas"])

# `content` is a free-form client-supplied JSON blob; cap its serialized size so
# a buggy/malicious client can't store an unbounded document.
_MAX_CONTENT_BYTES = 500 * 1024


# Human labels for the structured content sections, used to describe a body
# edit in the activity timeline ("edited TL;DR, Summary, Action Items" instead
# of an opaque "edited the content"). Order matches the form's section order.
_CONTENT_SECTION_LABELS: list[tuple[str, str]] = [
    ("tldr", "TL;DR"),
    ("summary", "Summary"),
    ("impact", "Impact"),
    ("consequence", "Consequence"),
    ("fiveWhys", "Five Whys"),
    ("immediateResolution", "Resolution"),
    ("wentWell", "What went well"),
    ("couldBeBetter", "What could be better"),
    ("gotLucky", "Got lucky"),
    ("actions", "Action Items"),
    ("timeline", "Timeline"),
    ("extra", "Other notes"),
]


def _describe_actions_diff(old_actions, new_actions) -> str | None:
    """Describe how action items changed. Special-cases the common case where
    only row statuses were toggled (e.g. marking an item Done in the dropdown)
    so the timeline reads 'marked "..." as Closed' instead of a generic
    'Action Items'. Falls back to that generic label for structural changes
    (add/remove/edit-text/owners/reorder)."""
    o = old_actions or {}
    n = new_actions or {}
    if o == n:
        return None
    if set(o.keys()) != set(n.keys()):
        return "Action Items"

    status_changes: list[tuple[str, str]] = []  # (action text, new status)
    other_change = False

    for cat in n.keys():
        old_rows = o.get(cat) or []
        new_rows = n.get(cat) or []
        if len(old_rows) != len(new_rows):
            other_change = True
            continue
        for old_r, new_r in zip(old_rows, new_rows):
            old_r = old_r if isinstance(old_r, dict) else {}
            new_r = new_r if isinstance(new_r, dict) else {}
            if old_r == new_r:
                continue
            old_strip = {k: v for k, v in old_r.items() if k != "status"}
            new_strip = {k: v for k, v in new_r.items() if k != "status"}
            if old_strip == new_strip and old_r.get("status") != new_r.get("status"):
                action_text = (new_r.get("action") or old_r.get("action") or "").strip()
                status_changes.append((action_text, str(new_r.get("status") or "Open")))
            else:
                other_change = True

    if status_changes and not other_change:
        if len(status_changes) == 1:
            text, new_status = status_changes[0]
            short = (text[:50] + "…") if len(text) > 50 else text
            return f'marked "{short}" as {new_status}' if short else f"marked an action item as {new_status}"
        return f"updated {len(status_changes)} action item statuses"

    return "Action Items"


def _diff_content_sections(old: dict | None, new: dict | None) -> list[str]:
    """Return the human labels of structured content sections whose value
    differs between old and new. Special-cases `actions` to surface status-only
    toggles (e.g. 'marked "..." as Closed') instead of just "Action Items"."""
    o, n = old or {}, new or {}
    out: list[str] = []
    for key, label in _CONTENT_SECTION_LABELS:
        if key == "actions":
            desc = _describe_actions_diff(o.get(key), n.get(key))
            if desc:
                out.append(desc)
        else:
            if o.get(key) != n.get(key):
                out.append(label)
    return out


def _owner_emails(raw) -> set[str]:
    """Normalize an action-item owner field (User | None | User[] | comma string)
    into a set of lowercased emails. Owners without an email (e.g. parsed from a
    name-only markdown table cell) are skipped because we can't DM them."""
    if not raw:
        return set()
    if isinstance(raw, dict):
        e = (raw.get("email") or "").strip().lower()
        return {e} if e else set()
    if isinstance(raw, list):
        out: set[str] = set()
        for o in raw:
            if isinstance(o, dict):
                e = (o.get("email") or "").strip().lower()
                if e:
                    out.add(e)
        return out
    return set()


def _action_item_owner_assignments(
    old_actions, new_actions
) -> list[tuple[str, str]]:
    """Return (owner_email, action_text) tuples for owners that were newly
    added to action items in this save (compared to old). One tuple per
    (newly-assigned owner, item) pair. Used to DM each new assignee."""
    o = old_actions if isinstance(old_actions, dict) else {}
    n = new_actions if isinstance(new_actions, dict) else {}
    added: list[tuple[str, str]] = []
    for cat, new_rows in n.items():
        if not isinstance(new_rows, list):
            continue
        old_rows = o.get(cat) or []
        for i, new_r in enumerate(new_rows):
            if not isinstance(new_r, dict):
                continue
            old_r = old_rows[i] if i < len(old_rows) and isinstance(old_rows[i], dict) else {}
            new_emails = _owner_emails(new_r.get("owners") if "owners" in new_r else new_r.get("owner"))
            old_emails = _owner_emails(old_r.get("owners") if "owners" in old_r else old_r.get("owner"))
            action_text = (new_r.get("action") or "").strip()
            if not action_text:
                continue
            for email in new_emails - old_emails:
                added.append((email, action_text))
    return added


def _check_content_size(content: dict | None) -> None:
    if content is None:
        return
    try:
        size = len(json.dumps(content, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="content is not JSON-serializable")
    if size > _MAX_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail="content too large (max 500KB)")


async def _get_rca_or_404(db: AsyncSession, rca_id: int) -> RCA:
    rca = (await db.execute(select(RCA).where(RCA.id == rca_id))).scalar_one_or_none()
    if not rca:
        raise HTTPException(status_code=404, detail="rca not found")
    return rca


async def _serialize(
    db: AsyncSession,
    rca: RCA,
    user: UserCtx,
    users_by_email: dict[str, User] | None = None,
) -> RCAOut:
    """Serialize an RCA. Pass `users_by_email` (a prefetched email->User map) to
    avoid a per-RCA user query when serializing a list (see list_rcas)."""
    assignee_emails = [a.user_email for a in rca.assignees]
    if users_by_email is None:
        all_emails = list({*assignee_emails, rca.creator_email})
        rows = (
            await db.execute(select(User).where(User.email.in_(all_emails)))
        ).scalars().all()
        users_by_email = {u.email: u for u in rows}

    user_rows = [users_by_email[e] for e in assignee_emails if e in users_by_email]
    creator_name = (
        users_by_email[rca.creator_email].name
        if rca.creator_email in users_by_email
        else rca.creator_email
    )

    return RCAOut(
        id=rca.id,
        title=rca.title,
        body=rca.body,
        content=rca.content,
        status=rca.status,
        severity=rca.severity,
        environment=rca.environment,
        services_affected=rca.services_affected or [],
        incident_started_at=rca.incident_started_at,
        incident_detected_at=rca.incident_detected_at,
        incident_mitigated_at=rca.incident_mitigated_at,
        incident_resolved_at=rca.incident_resolved_at,
        creator_email=rca.creator_email,
        creator_name=creator_name,
        assignees=[UserOut(email=u.email, name=u.name) for u in user_rows],
        created_at=rca.created_at,
        updated_at=rca.updated_at,
        closed_at=rca.closed_at,
        ai_summary=rca.ai_summary,
        ai_summary_at=rca.ai_summary_at,
        ai_summary_model=rca.ai_summary_model,
        can_edit=can_edit_rca(user, rca.creator_email, set(assignee_emails)),
        can_delete=can_delete_rca(user, rca.creator_email),
    )


async def _ensure_users_exist(db: AsyncSession, emails: list[str]) -> list[str]:
    if not emails:
        return []
    seen = (
        await db.execute(select(User.email).where(User.email.in_(emails)))
    ).scalars().all()
    missing = [e for e in emails if e not in set(seen)]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"unknown user(s): {', '.join(missing)}. They must log in once first.",
        )
    return emails


def _record_history(
    db: AsyncSession,
    rca_id: int,
    actor: UserCtx,
    action: str,
    from_value: str | None = None,
    to_value: str | None = None,
) -> None:
    db.add(
        RCAHistory(
            rca_id=rca_id,
            actor_email=actor.email,
            action=action,
            from_value=from_value,
            to_value=to_value,
        )
    )


@router.get("", response_model=RCAListOut)
async def list_rcas(
    status: RCAStatus | None = Query(None),
    severity: RCASeverity | None = Query(None),
    environment: str | None = Query(None, max_length=64),
    mine: bool = Query(False),
    q: str | None = Query(None, max_length=200),
    from_date: datetime | None = Query(None, alias="from"),
    to_date: datetime | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> RCAListOut:
    stmt = select(RCA)
    conds = []
    if status is not None:
        conds.append(RCA.status == status)
    if severity is not None:
        conds.append(RCA.severity == severity)
    if environment:
        conds.append(func.lower(RCA.environment) == environment.lower())
    if from_date is not None:
        conds.append(RCA.created_at >= from_date)
    if to_date is not None:
        conds.append(RCA.created_at <= to_date)
    if q:
        like = f"%{q.lower()}%"
        conds.append(or_(func.lower(RCA.title).like(like), func.lower(RCA.body).like(like)))
    if mine:
        sub = select(RCAAssignee.rca_id).where(RCAAssignee.user_email == user.email)
        conds.append(or_(RCA.creator_email == user.email, RCA.id.in_(sub)))
    if conds:
        stmt = stmt.where(and_(*conds))

    total = (
        await db.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()

    stmt = stmt.order_by(RCA.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    rcas = (await db.execute(stmt)).scalars().all()

    # Batch the creator+assignee name lookups into ONE query for the whole page
    # (assignees are already eager-loaded via selectin), instead of one query
    # per RCA inside _serialize.
    page_emails: set[str] = set()
    for r in rcas:
        page_emails.add(r.creator_email)
        for a in r.assignees:
            page_emails.add(a.user_email)
    user_rows = (
        (await db.execute(select(User).where(User.email.in_(page_emails)))).scalars().all()
        if page_emails
        else []
    )
    users_by_email = {u.email: u for u in user_rows}

    items = [await _serialize(db, r, user, users_by_email) for r in rcas]
    return RCAListOut(items=items, total=total)


@router.get("/{rca_id}", response_model=RCAOut)
async def get_rca(
    rca_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> RCAOut:
    rca = await _get_rca_or_404(db, rca_id)
    return await _serialize(db, rca, user)


@router.post("", response_model=RCAOut, status_code=201)
async def create_rca(
    payload: RCACreate,
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> RCAOut:
    _check_content_size(payload.content)
    cleaned_emails = list(dict.fromkeys(e.lower().strip() for e in payload.assignee_emails if e.strip()))
    await _ensure_users_exist(db, cleaned_emails)

    rca = RCA(
        title=payload.title.strip(),
        body=payload.body or "",
        content=payload.content,
        status=RCAStatus.OPEN,
        creator_email=user.email,
        severity=payload.severity,
        environment=(payload.environment.strip() or None) if payload.environment else None,
        services_affected=[s.strip() for s in payload.services_affected if s.strip()],
        incident_started_at=payload.incident_started_at,
        incident_detected_at=payload.incident_detected_at,
        incident_mitigated_at=payload.incident_mitigated_at,
        incident_resolved_at=payload.incident_resolved_at,
    )
    db.add(rca)
    await db.flush()

    for email in cleaned_emails:
        db.add(RCAAssignee(rca_id=rca.id, user_email=email))
    _record_history(db, rca.id, user, "created", to_value=rca.title)
    await db.commit()
    await db.refresh(rca)

    if cleaned_emails:
        notify.notify_assigned(rca.id, user.email, user.name, cleaned_emails)
    # DM each owner newly assigned to any action item (old is empty on create).
    ai_assignments = _action_item_owner_assignments(
        None, (payload.content or {}).get("actions") if isinstance(payload.content, dict) else None
    )
    if ai_assignments:
        notify.notify_action_items_assigned(rca.id, user.email, user.name, ai_assignments)
    return await _serialize(db, rca, user)


async def _change_status(
    db: AsyncSession, rca: RCA, new: RCAStatus, user: UserCtx
) -> RCAStatus:
    old = rca.status
    if old == new:
        return old
    rca.status = new
    if new == RCAStatus.CLOSED:
        rca.closed_at = datetime.now(timezone.utc)
    elif old == RCAStatus.CLOSED and new != RCAStatus.CLOSED:
        rca.closed_at = None
    _record_history(db, rca.id, user, "status_changed", from_value=old.value, to_value=new.value)
    return old


@router.patch("/{rca_id}", response_model=RCAOut)
async def patch_rca(
    rca_id: int,
    payload: RCAPatch,
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> RCAOut:
    rca = await _get_rca_or_404(db, rca_id)
    assignee_emails = {a.user_email for a in rca.assignees}
    if not can_edit_rca(user, rca.creator_email, assignee_emails):
        raise HTTPException(status_code=403, detail="not allowed")

    # Capture pre-patch action items so we can DM whoever gets newly assigned.
    pre_action_items = (
        rca.content.get("actions") if isinstance(rca.content, dict) else None
    )

    status_transition: tuple[RCAStatus, RCAStatus] | None = None

    if payload.title is not None:
        new_title = payload.title.strip()
        if new_title != rca.title:
            _record_history(db, rca.id, user, "edited", from_value="title", to_value=new_title)
            rca.title = new_title

    if payload.body is not None and payload.body != rca.body:
        # If the client also sent `content` (the structured payload, normal for
        # form saves), figure out which named sections actually changed and
        # stash them in to_value so the activity timeline can name them.
        # Read rca.content BEFORE the later block overwrites it.
        old_content = rca.content if isinstance(rca.content, dict) else None
        new_content = payload.content if isinstance(payload.content, dict) else None
        sections = _diff_content_sections(old_content, new_content) if new_content else []
        _record_history(
            db, rca.id, user, "edited",
            from_value="body",
            to_value=(", ".join(sections) if sections else None),
        )
        rca.body = payload.body

    set_fields = payload.model_fields_set

    # Structured payload is the source the editor re-hydrates from; `body` (above)
    # is its rendered form. Persist it whenever sent; no separate history row —
    # the body edit recorded above already captures "the content changed".
    if "content" in set_fields:
        _check_content_size(payload.content)
        rca.content = payload.content

    if "severity" in set_fields and payload.severity != rca.severity:
        _record_history(
            db, rca.id, user, "edited",
            from_value="severity",
            to_value=payload.severity.value if payload.severity else None,
        )
        rca.severity = payload.severity

    if "environment" in set_fields:
        new_env = payload.environment.strip() if payload.environment else None
        if (new_env or None) != (rca.environment or None):
            _record_history(db, rca.id, user, "edited", from_value="environment", to_value=new_env)
            rca.environment = new_env or None

    if "services_affected" in set_fields and payload.services_affected is not None:
        cleaned = [s.strip() for s in payload.services_affected if s.strip()]
        if cleaned != (rca.services_affected or []):
            _record_history(db, rca.id, user, "edited", from_value="services_affected", to_value=", ".join(cleaned))
            rca.services_affected = cleaned

    for ts_field in ("incident_started_at", "incident_detected_at", "incident_mitigated_at", "incident_resolved_at"):
        if ts_field in set_fields:
            new_ts = getattr(payload, ts_field)
            if new_ts != getattr(rca, ts_field):
                _record_history(
                    db, rca.id, user, "edited",
                    from_value=ts_field,
                    to_value=new_ts.isoformat() if new_ts else None,
                )
                setattr(rca, ts_field, new_ts)

    added: list[str] = []
    if payload.assignee_emails is not None:
        new_set = set(dict.fromkeys(e.lower().strip() for e in payload.assignee_emails if e.strip()))
        await _ensure_users_exist(db, list(new_set))
        added = sorted(new_set - assignee_emails)
        removed = sorted(assignee_emails - new_set)
        for email in removed:
            await db.execute(
                RCAAssignee.__table__.delete().where(
                    (RCAAssignee.rca_id == rca.id) & (RCAAssignee.user_email == email)
                )
            )
            _record_history(db, rca.id, user, "unassigned", from_value=email)
        for email in added:
            db.add(RCAAssignee(rca_id=rca.id, user_email=email))
            _record_history(db, rca.id, user, "assigned", to_value=email)

    if payload.status is not None and payload.status != rca.status:
        old_status = await _change_status(db, rca, payload.status, user)
        status_transition = (old_status, payload.status)

    await db.commit()
    await db.refresh(rca)

    if added:
        notify.notify_assigned(rca.id, user.email, user.name, added)
    if status_transition:
        old, new = status_transition
        notify.notify_status_changed(rca.id, user.email, user.name, old, new)
        if new in (RCAStatus.RCA_DONE, RCAStatus.CLOSED):
            ai_summary.maybe_generate_on_close(rca.id)

    # DM whoever was newly assigned to an action item in this save.
    post_action_items = (
        payload.content.get("actions") if isinstance(payload.content, dict) else None
    )
    ai_assignments = _action_item_owner_assignments(pre_action_items, post_action_items)
    if ai_assignments:
        notify.notify_action_items_assigned(rca.id, user.email, user.name, ai_assignments)

    return await _serialize(db, rca, user)


@router.post("/{rca_id}/status", response_model=RCAOut)
async def change_status(
    rca_id: int,
    payload: StatusChange,
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> RCAOut:
    rca = await _get_rca_or_404(db, rca_id)
    assignee_emails = {a.user_email for a in rca.assignees}
    if not can_edit_rca(user, rca.creator_email, assignee_emails):
        raise HTTPException(status_code=403, detail="not allowed")

    if payload.status == rca.status:
        return await _serialize(db, rca, user)

    old = await _change_status(db, rca, payload.status, user)
    await db.commit()
    await db.refresh(rca)

    notify.notify_status_changed(rca.id, user.email, user.name, old, payload.status)
    if payload.status in (RCAStatus.RCA_DONE, RCAStatus.CLOSED):
        ai_summary.maybe_generate_on_close(rca.id)

    return await _serialize(db, rca, user)


@router.delete("/{rca_id}", status_code=204)
async def delete_rca(
    rca_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserCtx = Depends(get_current_user),
) -> None:
    rca = await _get_rca_or_404(db, rca_id)
    if not can_delete_rca(user, rca.creator_email):
        raise HTTPException(status_code=403, detail="not allowed")
    await db.delete(rca)
    await db.commit()


@router.get("/{rca_id}/history", response_model=list[HistoryEntryOut])
async def get_history(
    rca_id: int,
    db: AsyncSession = Depends(get_db),
    _: UserCtx = Depends(get_current_user),
) -> list[HistoryEntryOut]:
    await _get_rca_or_404(db, rca_id)
    rows = (
        await db.execute(
            select(RCAHistory).where(RCAHistory.rca_id == rca_id).order_by(RCAHistory.at.desc())
        )
    ).scalars().all()
    return [HistoryEntryOut.model_validate(r) for r in rows]


@router.post("/{rca_id}/regenerate-summary", response_model=RCAOut)
async def regenerate_summary(
    rca_id: int,
    db: AsyncSession = Depends(get_db),
    admin: UserCtx = Depends(require_admin),
) -> RCAOut:
    rca = await _get_rca_or_404(db, rca_id)
    if rca.status not in (RCAStatus.RCA_DONE, RCAStatus.CLOSED):
        raise HTTPException(status_code=400, detail="rca must be at least 'rca_done' to summarize")
    ai_summary.force_regenerate(rca.id)
    return await _serialize(db, rca, admin)
