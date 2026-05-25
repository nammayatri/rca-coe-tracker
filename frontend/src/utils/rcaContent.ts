// Single source of truth for the RCA structured form payload.
//
// The create AND edit flows both hold an `RCAContent`. On save we persist it
// verbatim (the `content` JSONB column, via `serializeContent`) and ALSO render
// it to markdown (`body`) via `composeBody`, so the AI summary, Slack
// notifications, and link extraction — all of which read `body` — keep working.
//
// Editing reuses the same form: we hydrate it from the stored `content` when
// present (lossless), or fall back to parsing the markdown `body` for legacy
// RCAs that predate the column (`contentFromRCA`).

import type { RCA, User } from '../api/types';
import { parseRCABody } from './parseRCABody';

export const ACTION_CATEGORIES = [
  'Immediate Fixes',
  'Monitoring & Alerts',
  'Operational Excellence',
  'Fundamental Long-Term Investments',
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

// Suggested statuses for the dropdown. NOTE: status is a free string (not a
// closed union) so legacy/custom values like "Blocked" or "Won't Fix" survive
// a parse -> edit -> save round-trip instead of collapsing to "Open"/"Closed".
export const ACTION_STATUS_PRESETS = ['Open', 'In Progress', 'To Be Tested', 'Closed'] as const;
export type ActionStatus = string;

// Stable per-row id, used only as a React key during an editing session. It is
// NOT persisted (stripped by serializeContent) and never rendered to markdown.
let _ridSeq = 0;
export const rid = (): string => `r${Date.now().toString(36)}${(_ridSeq++).toString(36)}`;

export interface ActionItemRow {
  id: string;
  action: string;
  status: ActionStatus;
  owner: User | null;
}

export interface TimelineRow {
  id: string;
  time: string;
  event: string;
}

export interface RCAContent {
  tldr: string;
  summary: string;
  impact: string;
  consequence: string;
  fiveWhys: string;
  immediateResolution: string;
  wentWell: string;
  couldBeBetter: string;
  gotLucky: string;
  actions: Record<ActionCategory, ActionItemRow[]>;
  timeline: TimelineRow[];
  // Any markdown the structured form doesn't model (custom H2 sections, a
  // "## Pull requests" block appended on close, free-text someone added via the
  // raw editor). Carried verbatim and re-appended by composeBody so editing
  // through the structured form NEVER drops content. Surfaces in the
  // "Advanced: edit raw markdown" view.
  extra: string;
}

export const emptyActionRow = (): ActionItemRow => ({ id: rid(), action: '', status: 'Open', owner: null });
export const emptyTimelineRow = (): TimelineRow => ({ id: rid(), time: '', event: '' });

function emptyActions(seedRow = false): Record<ActionCategory, ActionItemRow[]> {
  const out = {} as Record<ActionCategory, ActionItemRow[]>;
  for (const cat of ACTION_CATEGORIES) out[cat] = seedRow ? [emptyActionRow()] : [];
  return out;
}

// A blank content object with one empty row per action category + one empty
// timeline row, ready to drive an empty form.
export function emptyContent(): RCAContent {
  return {
    tldr: '',
    summary: '',
    impact: '',
    consequence: '',
    fiveWhys: '',
    immediateResolution: '',
    wentWell: '',
    couldBeBetter: '',
    gotLucky: '',
    actions: emptyActions(true),
    timeline: [emptyTimelineRow()],
    extra: '',
  };
}

const ACTION_TIP =
  '_Tip: file each item in your tracker (Jira / Linear / GitHub) and paste the link in the action column._';

const escCell = (s: string) => s.trim().replace(/\|/g, '\\|');

// ───── content → markdown ─────

export function composeBody(content: RCAContent): string {
  const blocks: string[] = [];

  const addText = (heading: string, text: string) => {
    const t = (text || '').trim();
    if (!t) return;
    blocks.push(`## ${heading}\n\n${t}`);
  };

  addText('TL;DR', content.tldr);
  addText('Summary', content.summary);
  addText('What was the impact?', content.impact);
  addText('What is the consequence of impact?', content.consequence);
  addText('Root cause — Five Whys', content.fiveWhys);
  addText('Immediate Resolution', content.immediateResolution);

  const wellTrim = (content.wentWell || '').trim();
  const betterTrim = (content.couldBeBetter || '').trim();
  const luckyTrim = (content.gotLucky || '').trim();
  if (wellTrim || betterTrim || luckyTrim) {
    const sub: string[] = ['## Takeaways'];
    if (wellTrim) sub.push(`### What went well?\n\n${wellTrim}`);
    if (betterTrim) sub.push(`### What could have been better?\n\n${betterTrim}`);
    if (luckyTrim) sub.push(`### Where did we get lucky?\n\n${luckyTrim}`);
    blocks.push(sub.join('\n\n'));
  }

  const actionCategoryBlocks: string[] = [];
  for (const cat of ACTION_CATEGORIES) {
    const rows = (content.actions[cat] || []).filter((r) => r.action.trim() || r.owner);
    if (rows.length === 0) continue;
    const lines: string[] = [`### ${cat}`, '', '| Action Item | Status | Owner |', '|---|---|---|'];
    for (const r of rows) {
      const ownerText = r.owner ? r.owner.name : '';
      const status = (r.status || '').trim() || 'Open';
      lines.push(`| ${escCell(r.action)} | ${escCell(status)} | ${escCell(ownerText)} |`);
    }
    lines.push('', ACTION_TIP);
    actionCategoryBlocks.push(lines.join('\n'));
  }
  if (actionCategoryBlocks.length > 0) {
    blocks.push(['## Action Items', '', ...actionCategoryBlocks].join('\n'));
  }

  const tlRows = (content.timeline || []).filter((r) => r.time.trim() || r.event.trim());
  if (tlRows.length > 0) {
    const lines: string[] = ['## Timeline', '', '| Time | Event |', '|---|---|'];
    for (const r of tlRows) lines.push(`| ${escCell(r.time)} | ${escCell(r.event)} |`);
    blocks.push(lines.join('\n'));
  }

  if (content.extra && content.extra.trim()) {
    blocks.push(content.extra.trim());
  }

  return blocks.join('\n\n');
}

// Does this RCA contain any structured signal? Used to decide whether the
// editor opens populated or empty.
export function contentIsEmpty(c: RCAContent): boolean {
  const proseEmpty =
    !c.tldr.trim() &&
    !c.summary.trim() &&
    !c.impact.trim() &&
    !c.consequence.trim() &&
    !c.fiveWhys.trim() &&
    !c.immediateResolution.trim() &&
    !c.wentWell.trim() &&
    !c.couldBeBetter.trim() &&
    !c.gotLucky.trim();
  const actionsEmpty = ACTION_CATEGORIES.every((cat) =>
    (c.actions[cat] || []).every((r) => !r.action.trim() && !r.owner),
  );
  const timelineEmpty = (c.timeline || []).every((r) => !r.time.trim() && !r.event.trim());
  return proseEmpty && actionsEmpty && timelineEmpty && !c.extra.trim();
}

// ───── markdown / stored JSON → content ─────

// Keep the status string as authored; only default a blank one to "Open".
function cleanStatus(raw: string): ActionStatus {
  const t = (raw || '').trim();
  return t || 'Open';
}

function mapCategory(raw: string): ActionCategory {
  const t = (raw || '').toLowerCase();
  if (t.includes('monitor') || t.includes('alert')) return 'Monitoring & Alerts';
  if (t.includes('operational') || t.includes('excellence') || t.includes('process')) {
    return 'Operational Excellence';
  }
  if (t.includes('fundamental') || t.includes('long')) return 'Fundamental Long-Term Investments';
  return 'Immediate Fixes';
}

function coerceOwner(raw: unknown): User | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { email: '', name } : null;
  }
  if (typeof raw === 'object') {
    const o = raw as Partial<User>;
    const name = (o.name ?? '').trim();
    const email = (o.email ?? '').trim();
    if (!name && !email) return null;
    return { email, name: name || email };
  }
  return null;
}

// Hydrate from the forgiving markdown parser (legacy rows / raw-markdown edits).
function contentFromParsed(parsed: ReturnType<typeof parseRCABody>): RCAContent {
  const actions = emptyActions(false);
  for (const g of parsed.actionItems) {
    const cat = mapCategory(g.category);
    for (const r of g.rows) {
      if (!r.action.trim()) continue;
      actions[cat].push({ id: rid(), action: r.action, status: cleanStatus(r.status), owner: coerceOwner(r.owner) });
    }
  }

  // The form has a single "Root cause — Five Whys" box; fold any prose that
  // preceded the numbered list back in front of it.
  const fiveWhys = [parsed.rootCauseProse, parsed.fiveWhys].filter(Boolean).join('\n\n');

  return {
    tldr: parsed.tldr ?? '',
    summary: parsed.summary ?? '',
    impact: parsed.impact ?? '',
    consequence: parsed.consequence ?? '',
    fiveWhys,
    immediateResolution: parsed.immediateResolution ?? '',
    wentWell: parsed.wentWell ?? '',
    couldBeBetter: parsed.couldBeBetter ?? '',
    gotLucky: parsed.gotLucky ?? '',
    actions,
    timeline: parsed.timeline.map((t) => ({ id: rid(), time: t.time, event: t.event })),
    extra: parsed.unstructured ?? '',
  };
}

export function contentFromMarkdown(body: string): RCAContent {
  return contentFromParsed(parseRCABody(body));
}

// Coerce a stored JSONB blob (whose shape we trust but want to harden against
// nulls/missing keys) into a full RCAContent.
function normalizeStored(raw: Record<string, unknown>): RCAContent {
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const actions = emptyActions(false);
  const rawActions = (raw.actions ?? {}) as Record<string, unknown>;
  for (const cat of ACTION_CATEGORIES) {
    const rows = Array.isArray(rawActions[cat]) ? (rawActions[cat] as unknown[]) : [];
    for (const r of rows) {
      const row = (r ?? {}) as Record<string, unknown>;
      const action = typeof row.action === 'string' ? row.action : '';
      if (!action.trim() && !row.owner) continue;
      actions[cat].push({
        id: rid(),
        action,
        status: cleanStatus(typeof row.status === 'string' ? row.status : ''),
        owner: coerceOwner(row.owner),
      });
    }
  }
  const rawTimeline = Array.isArray(raw.timeline) ? (raw.timeline as unknown[]) : [];
  const timeline: TimelineRow[] = rawTimeline.map((t) => {
    const row = (t ?? {}) as Record<string, unknown>;
    return {
      id: rid(),
      time: typeof row.time === 'string' ? row.time : '',
      event: typeof row.event === 'string' ? row.event : '',
    };
  });

  return {
    tldr: str('tldr'),
    summary: str('summary'),
    impact: str('impact'),
    consequence: str('consequence'),
    fiveWhys: str('fiveWhys'),
    immediateResolution: str('immediateResolution'),
    wentWell: str('wentWell'),
    couldBeBetter: str('couldBeBetter'),
    gotLucky: str('gotLucky'),
    actions,
    timeline,
    extra: str('extra'),
  };
}

function looksLikeStoredContent(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  // Our payload always carries these scalar keys (even if empty strings).
  return 'summary' in raw && 'actions' in raw;
}

// Build the content used to seed the editor: prefer the stored structured
// payload, else derive from the markdown body. Always returns a form-ready
// object with at least one empty row per action category and one timeline row.
export function contentFromRCA(rca: RCA): RCAContent {
  const base = looksLikeStoredContent(rca.content)
    ? normalizeStored(rca.content)
    : contentFromMarkdown(rca.body || '');
  return ensureEditable(base);
}

// Guarantee the form always has a trailing empty row to type into.
export function ensureEditable(c: RCAContent): RCAContent {
  const actions = {} as Record<ActionCategory, ActionItemRow[]>;
  for (const cat of ACTION_CATEGORIES) {
    actions[cat] = c.actions[cat] && c.actions[cat].length > 0 ? c.actions[cat] : [emptyActionRow()];
  }
  return {
    ...c,
    actions,
    timeline: c.timeline && c.timeline.length > 0 ? c.timeline : [emptyTimelineRow()],
  };
}

// After a DIRECT body edit outside the structured editor (checklist toggle,
// PR-link on close), compute the `content` to persist alongside the new body:
//   - legacy row (no stored content) -> null, so body stays the source of truth
//     and the row lazy-migrates losslessly on its first structured edit.
//   - structured row -> keep the existing structured fields untouched and only
//     refresh the freeform `extra` from the new body (the edit lives there), so
//     we never downgrade structured data into a re-parsed/lossy blob.
export function contentAfterBodyEdit(rca: RCA, newBody: string): Record<string, unknown> | null {
  if (!looksLikeStoredContent(rca.content)) return null;
  const base = normalizeStored(rca.content);
  base.extra = contentFromMarkdown(newBody).extra;
  return serializeContent(base);
}

// Serialize for storage: drop fully-empty rows and the transient `id`, returning
// a plain JSON object. Typed as Record<string, unknown> so call sites need no
// casts when assigning to the API's `content` field.
export function serializeContent(c: RCAContent): Record<string, unknown> {
  const actions: Record<string, { action: string; status: string; owner: User | null }[]> = {};
  for (const cat of ACTION_CATEGORIES) {
    actions[cat] = (c.actions[cat] || [])
      .filter((r) => r.action.trim() || r.owner)
      .map((r) => ({ action: r.action, status: (r.status || '').trim() || 'Open', owner: r.owner }));
  }
  return {
    tldr: c.tldr,
    summary: c.summary,
    impact: c.impact,
    consequence: c.consequence,
    fiveWhys: c.fiveWhys,
    immediateResolution: c.immediateResolution,
    wentWell: c.wentWell,
    couldBeBetter: c.couldBeBetter,
    gotLucky: c.gotLucky,
    actions,
    timeline: (c.timeline || [])
      .filter((r) => r.time.trim() || r.event.trim())
      .map((r) => ({ time: r.time, event: r.event })),
    extra: c.extra,
  };
}
