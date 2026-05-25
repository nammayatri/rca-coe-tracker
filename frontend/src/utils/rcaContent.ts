// Single source of truth for the RCA structured form payload.
//
// The create AND edit flows both hold an `RCAContent`. On save we persist it
// verbatim (the `content` JSONB column) and ALSO render it to markdown (`body`)
// via `composeBody`, so the AI summary, Slack notifications, and link
// extraction — all of which read `body` — keep working unchanged.
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

export const ACTION_STATUSES = ['Open', 'In Progress', 'To Be Tested', 'Closed'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionItemRow {
  action: string;
  status: ActionStatus;
  owner: User | null;
}

export interface TimelineRow {
  time: string;
  event: string;
}

export interface RCAContent {
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
  // through the structured form NEVER drops content. Not shown as a field; it
  // surfaces in the "Advanced: edit raw markdown" view.
  extra: string;
}

export const emptyActionRow = (): ActionItemRow => ({ action: '', status: 'Open', owner: null });
export const emptyTimelineRow = (): TimelineRow => ({ time: '', event: '' });

function emptyActions(seedRow = false): Record<ActionCategory, ActionItemRow[]> {
  const out = {} as Record<ActionCategory, ActionItemRow[]>;
  for (const cat of ACTION_CATEGORIES) out[cat] = seedRow ? [emptyActionRow()] : [];
  return out;
}

// A blank content object with one empty row per action category + one empty
// timeline row, ready to drive an empty form.
export function emptyContent(): RCAContent {
  return {
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

// ───── content → markdown ─────

export function composeBody(content: RCAContent): string {
  const blocks: string[] = [];

  const addText = (heading: string, text: string) => {
    const t = (text || '').trim();
    if (!t) return;
    blocks.push(`## ${heading}\n\n${t}`);
  };

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
    const lines: string[] = [];
    lines.push(`### ${cat}`);
    lines.push('');
    lines.push('| Action Item | Status | Owner |');
    lines.push('|---|---|---|');
    for (const r of rows) {
      const ownerText = r.owner ? r.owner.name : '';
      // Guard against pipes in free text breaking the markdown table.
      const action = r.action.trim().replace(/\|/g, '\\|');
      lines.push(`| ${action} | ${r.status} | ${ownerText.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    lines.push(ACTION_TIP);
    actionCategoryBlocks.push(lines.join('\n'));
  }
  if (actionCategoryBlocks.length > 0) {
    blocks.push(['## Action Items', '', ...actionCategoryBlocks].join('\n'));
  }

  const tlRows = (content.timeline || []).filter((r) => r.time.trim() || r.event.trim());
  if (tlRows.length > 0) {
    const lines: string[] = ['## Timeline', '', '| Time | Event |', '|---|---|'];
    for (const r of tlRows) {
      lines.push(`| ${r.time.trim().replace(/\|/g, '\\|')} | ${r.event.trim().replace(/\|/g, '\\|')} |`);
    }
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

function normalizeStatus(raw: string): ActionStatus {
  const t = (raw || '').toLowerCase();
  if (t.includes('progress')) return 'In Progress';
  if (t.includes('test')) return 'To Be Tested';
  if (t.includes('close') || t.includes('done') || t.includes('resolved') || t.includes('fixed')) {
    return 'Closed';
  }
  return 'Open';
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
      actions[cat].push({
        action: r.action,
        status: normalizeStatus(r.status),
        owner: coerceOwner(r.owner),
      });
    }
  }

  // The form has a single "Root cause — Five Whys" box; fold any prose that
  // preceded the numbered list back in front of it.
  const fiveWhys = [parsed.rootCauseProse, parsed.fiveWhys].filter(Boolean).join('\n\n');

  return {
    summary: parsed.summary ?? '',
    impact: parsed.impact ?? '',
    consequence: parsed.consequence ?? '',
    fiveWhys,
    immediateResolution: parsed.immediateResolution ?? '',
    wentWell: parsed.wentWell ?? '',
    couldBeBetter: parsed.couldBeBetter ?? '',
    gotLucky: parsed.gotLucky ?? '',
    actions,
    timeline: parsed.timeline.map((t) => ({ time: t.time, event: t.event })),
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
        action,
        status: normalizeStatus(typeof row.status === 'string' ? row.status : 'Open'),
        owner: coerceOwner(row.owner),
      });
    }
  }
  const rawTimeline = Array.isArray(raw.timeline) ? (raw.timeline as unknown[]) : [];
  const timeline: TimelineRow[] = rawTimeline.map((t) => {
    const row = (t ?? {}) as Record<string, unknown>;
    return {
      time: typeof row.time === 'string' ? row.time : '',
      event: typeof row.event === 'string' ? row.event : '',
    };
  });

  return {
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
    const rows = c.actions[cat] && c.actions[cat].length > 0 ? c.actions[cat] : [emptyActionRow()];
    actions[cat] = rows;
  }
  return {
    ...c,
    actions,
    timeline: c.timeline && c.timeline.length > 0 ? c.timeline : [emptyTimelineRow()],
  };
}

// Strip fully-empty rows before persisting, so the stored JSON stays clean.
export function compactContent(c: RCAContent): RCAContent {
  const actions = {} as Record<ActionCategory, ActionItemRow[]>;
  for (const cat of ACTION_CATEGORIES) {
    actions[cat] = (c.actions[cat] || []).filter((r) => r.action.trim() || r.owner);
  }
  return {
    ...c,
    actions,
    timeline: (c.timeline || []).filter((r) => r.time.trim() || r.event.trim()),
  };
}
