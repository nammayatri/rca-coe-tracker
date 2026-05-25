import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

# IST = UTC+5:30. The whole org operates in IST so the AI summary's
# Timeline + Metadata sections render times in IST to match the human-
# authored Timeline section in the body.
IST = timezone(timedelta(hours=5, minutes=30))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_maker
from app.models.rca import RCA, RCAStatus
from app.models.rca_history import RCAHistory

logger = logging.getLogger(__name__)

_background_tasks: set[asyncio.Task] = set()

# One lock per RCA so an auto-generate (on close) and a force-regenerate can't
# run concurrently and clobber each other's write.
_locks: dict[int, asyncio.Lock] = {}


def _lock_for(rca_id: int) -> asyncio.Lock:
    lock = _locks.get(rca_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[rca_id] = lock
    return lock


PROMPT = """You are writing a clean, professional post-mortem summary for an RCA/COE document. The output goes into a markdown viewer in an internal tool, so formatting matters.

CRITICAL: Output ONLY the finished markdown post-mortem. Begin your response directly with the line `## TL;DR`. Do NOT include any of the following anywhere in your response:
- Analysis or planning ("Let me analyze...", "I need to...")
- Restating the rules
- Word counts or self-checks ("Word count check:", "Formatting check:")
- Drafts followed by revisions
- Commentary about what you included or omitted
- Trailing notes or sign-offs
The very first characters of your response must be the literal string `## TL;DR` and the last characters must be the final bullet of the last section. Nothing before, nothing after.

OUTPUT RULES (strict)

Use only these markdown elements:
- ## for top-level section headings
- ### for sub-section headings (sparingly)
- - (a single ASCII hyphen and a space) for bullets
- **bold** for emphasis (sparingly)
- backticks `like_this` for service names, identifiers, paths
- > for blockquote callouts (sparingly)

Forbidden characters and patterns:
- No em dashes or en dashes. Use a plain hyphen with spaces, like " - ".
- No smart quotes. Use straight " and '.
- No ellipsis character. Use three dots: ...
- No decorative bullets, arrows, or symbols (no bullet "*", no arrow, no checkmark, no fancy dots).
- No emoji.
- No AI disclaimers, no preamble like "Here is the summary" or "Based on the data".
- No "N/A" or "None" filler. Omit a section entirely if there is nothing to say.

Tone: factual, blameless, concise. If the source is sparse, write less. Never invent details.

SECTIONS (in this order, omit any with no signal):

## TL;DR
One or two short sentences. What happened and the impact.

## Impact
Customer/business impact. Quantify when possible (riders, drivers, bookings, percent of traffic, duration). Reference severity and environment.

## Timeline
Bulleted, chronological. Each line: time then a brief event. Use **IST** times in the format `HH:MM IST` (e.g. `12:00 IST`); never UTC, never raw ISO with `+00:00`. Pull from the BODY where it has timestamps; otherwise from STATUS HISTORY (those are already supplied in IST below).

## Root Cause
One or two short paragraphs or a small bullet list. Underlying cause plus contributing factors. Stay grounded in the body text.

## Resolution
What was done to mitigate and resolve. Reference MTTD and MTTR if computable.

## What Went Well
Short bullet list. Skip if nothing.

## What Went Wrong
Short bullet list. Skip if nothing.

## Action Items
Pull from the body. One bullet per item. If owner or priority is mentioned, include them in parentheses. Preserve any tracker issue links (Jira / Linear / GitHub Issues / etc.) verbatim.

## Metadata
A compact bullet list with these labels (only include rows that have a value).
Render every timestamp in IST in the format `YYYY-MM-DD HH:MM IST` (e.g. `2026-04-29 12:00 IST`). Never use UTC.
- Severity
- Environment
- Services affected
- Started
- Detected
- Mitigated
- Resolved
- MTTD
- MTTR

Hard limit: 350 words total.

---

RCA DATA

Title: {title}
Severity: {severity}
Environment: {environment}
Services affected: {services}
Created by: {creator}
Created at: {created_at}
Closed at: {closed_at}
Open duration: {open_duration}
Incident started:  {incident_started_at}
Incident detected: {incident_detected_at}
Incident mitigated:{incident_mitigated_at}
Incident resolved: {incident_resolved_at}
MTTD (detected - started): {mttd}
MTTR (resolved - started): {mttr}
Assignees: {assignees}

---

BODY (verbatim, do not modify identifiers or links):

{body}

---

STATUS HISTORY (oldest first):

{history}
"""


def _format_duration(start: datetime | None, end: datetime | None) -> str:
    if not start or not end:
        return "not recorded"
    delta = end - start
    total = int(delta.total_seconds())
    if total < 0:
        return "not recorded"
    if total < 60:
        return f"{total}s"
    minutes, _ = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m"
    hours, mins = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {mins}m" if mins else f"{hours}h"
    days, h = divmod(hours, 24)
    return f"{days}d {h}h" if h else f"{days}d"


def _fmt_ts(ts: datetime | None) -> str:
    """Render a timestamp for the LLM in IST. The model is told to emit
    `HH:MM IST` / `YYYY-MM-DD HH:MM IST` in its output."""
    if not ts:
        return "not recorded"
    return ts.astimezone(IST).strftime("%Y-%m-%d %H:%M IST")


async def _build_prompt(db: AsyncSession, rca: RCA) -> str:
    history_rows = (
        await db.execute(
            select(RCAHistory).where(RCAHistory.rca_id == rca.id).order_by(RCAHistory.at)
        )
    ).scalars().all()
    history_lines = [
        f"- {h.at.astimezone(IST).strftime('%Y-%m-%d %H:%M IST')} - {h.actor_email} - {h.action}"
        + (f" ({h.from_value} -> {h.to_value})" if h.from_value or h.to_value else "")
        for h in history_rows
    ]
    closed_at = rca.closed_at or datetime.now(timezone.utc)

    return PROMPT.format(
        title=rca.title,
        severity=(rca.severity.value if rca.severity else "not set"),
        environment=(rca.environment or "not set"),
        services=", ".join(rca.services_affected or []) or "not set",
        creator=rca.creator_email,
        created_at=rca.created_at.astimezone(IST).strftime("%Y-%m-%d %H:%M IST"),
        closed_at=closed_at.astimezone(IST).strftime("%Y-%m-%d %H:%M IST"),
        open_duration=_format_duration(rca.created_at, closed_at),
        incident_started_at=_fmt_ts(rca.incident_started_at),
        incident_detected_at=_fmt_ts(rca.incident_detected_at),
        incident_mitigated_at=_fmt_ts(rca.incident_mitigated_at),
        incident_resolved_at=_fmt_ts(rca.incident_resolved_at),
        mttd=_format_duration(rca.incident_started_at, rca.incident_detected_at),
        mttr=_format_duration(rca.incident_started_at, rca.incident_resolved_at),
        assignees=", ".join(a.user_email for a in rca.assignees) or "(none)",
        body=rca.body or "(no body provided)",
        history="\n".join(history_lines) or "(no history)",
    )


_REPLACEMENTS = {
    "—": " - ",   # em dash
    "–": "-",     # en dash
    "−": "-",     # minus
    "‘": "'",     # left single quote
    "’": "'",     # right single quote
    "“": '"',     # left double quote
    "”": '"',     # right double quote
    "…": "...",   # ellipsis
    "•": "-",     # bullet
    "·": "-",     # middle dot
    "→": "->",    # right arrow
    "←": "<-",    # left arrow
    "✓": "",      # check
    "✗": "",      # cross
    "✅": "",      # white heavy check
    "❌": "",      # cross mark
    " ": " ",     # nbsp
}

_LEADING_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$")
_THINK_TAG_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_PRE_TL_DR_RE = re.compile(r"^[\s\S]*?(?=## TL;DR)", re.IGNORECASE)
_FIRST_H2_RE = re.compile(r"^##\s+\S", re.MULTILINE)
_TRAILING_COMMENTARY_RE = re.compile(
    r"\n\n+(?:"
    r"Wait\b|Note\b|Notes\b|Now\b|Also\b|Total\b|Check(?:ing)?\b|Double[\- ]?check\b"
    r"|Word\s*count\b|Format(?:ting)?\s*check\b|Forbidden\s*checks?\b"
    r"|Let me\b|To be safe\b|Hmm\b|Actually\b"
    r"|I\s+(?:need|should|will|am|have|'ll|'m|ll|m)\b"
    r")[\s\S]*$",
    re.IGNORECASE,
)


def _strip_preamble(text: str) -> str:
    m = _FIRST_H2_RE.search(text)
    if not m:
        return text
    return text[m.start():]


def _strip_trailing_commentary(text: str) -> str:
    return _TRAILING_COMMENTARY_RE.sub("", text)


def _sanitize(text: str) -> str:
    text = text.strip()
    text = _THINK_TAG_RE.sub("", text)
    fence = _LEADING_FENCE_RE.match(text)
    if fence:
        text = fence.group(1).strip()
    text = _PRE_TL_DR_RE.sub("", text, count=1)
    text = _strip_preamble(text)
    text = _strip_trailing_commentary(text)
    for needle, repl in _REPLACEMENTS.items():
        text = text.replace(needle, repl)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_SYSTEM_MSG = (
    "You are a precise technical writer producing post-mortem summaries. "
    "Output only the finished markdown post-mortem. Begin directly with `## TL;DR`. "
    "Never narrate your reasoning, never list rules back, never count words, "
    "never add a trailing 'Wait...' or 'Note:' or 'I should...' commentary. "
    "When the last section's last bullet is written, STOP. "
    "No emoji, no smart quotes, no em dashes, no preamble, no AI disclaimers."
)


async def _try_model(model: str, prompt: str) -> str | None:
    from litellm import acompletion

    kwargs: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_MSG},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": min(settings.ai_max_tokens, 1800),
        "temperature": settings.ai_temperature,
        "api_key": settings.ai_api_key,
    }
    if settings.ai_api_base:
        kwargs["api_base"] = settings.ai_api_base
    try:
        resp = await acompletion(**kwargs)
        raw = (resp.choices[0].message.content or "").strip()
        if not raw:
            logger.warning("Model %s returned empty content", model)
            return None
        cleaned = _sanitize(raw)
        if not cleaned or "## " not in cleaned:
            logger.warning("Model %s output had no structured sections; len=%d", model, len(cleaned))
            return None
        return cleaned
    except Exception:
        logger.exception("LLM call failed for model=%s", model)
        return None


async def _call_llm(prompt: str) -> tuple[str, str] | None:
    if not settings.ai_api_key:
        logger.warning("AI_API_KEY not configured; skipping summary generation")
        return None
    candidates: list[str] = []
    if settings.ai_fast_model:
        candidates.append(settings.ai_fast_model)
    if "open-fast" not in (settings.ai_fast_model or ""):
        candidates.append("openai/open-fast")
    seen: set[str] = set()
    for model in candidates:
        if model in seen:
            continue
        seen.add(model)
        result = await _try_model(model, prompt)
        if result:
            return result, model
    return None


async def _generate_and_persist(rca_id: int, force: bool = False) -> None:
    # Serialize per-RCA so concurrent auto-generate + regenerate don't clobber.
    async with _lock_for(rca_id):
        try:
            async with async_session_maker() as db:
                rca = (await db.execute(select(RCA).where(RCA.id == rca_id))).scalar_one_or_none()
                if not rca:
                    return
                if rca.ai_summary and not force:
                    return
                if rca.status not in (RCAStatus.RCA_DONE, RCAStatus.CLOSED) and not force:
                    return
                prompt = await _build_prompt(db, rca)

            result = await _call_llm(prompt)
            if not result:
                return
            summary, model_used = result

            async with async_session_maker() as db:
                rca = (await db.execute(select(RCA).where(RCA.id == rca_id))).scalar_one_or_none()
                if not rca:
                    return
                rca.ai_summary = summary
                rca.ai_summary_at = datetime.now(timezone.utc)
                rca.ai_summary_model = model_used
                await db.commit()
        except Exception:
            logger.exception("generate_and_persist failed for rca=%s", rca_id)
        # NB: intentionally do NOT remove the lock from `_locks` here — popping it
        # while another coroutine is awaiting the same Lock would let a third
        # caller create a *new* Lock and run concurrently. One small Lock per RCA
        # id is negligible.


def maybe_generate_on_close(rca_id: int) -> None:
    task = asyncio.create_task(_generate_and_persist(rca_id, force=False))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def force_regenerate(rca_id: int) -> None:
    task = asyncio.create_task(_generate_and_persist(rca_id, force=True))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
