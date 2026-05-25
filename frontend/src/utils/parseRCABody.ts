// Forgiving markdown parser for RCA bodies. Splits on H2/H3 headings and
// turns recognized sections into structured pieces; everything else falls
// through to `unstructured` so it can be rendered raw.

export interface ActionItemRow {
  action: string;
  status: string;
  owner: string;
}

export interface ActionItemGroup {
  category: string;
  rows: ActionItemRow[];
}

export interface TimelineRow {
  time: string;
  event: string;
}

export interface ParsedRCABody {
  tldr: string | null;
  summary: string | null;
  impact: string | null;
  consequence: string | null;
  fiveWhys: string | null;
  rootCauseProse: string | null;
  immediateResolution: string | null;
  wentWell: string | null;
  couldBeBetter: string | null;
  gotLucky: string | null;
  actionItems: ActionItemGroup[];
  timeline: TimelineRow[];
  unstructured: string | null;
}

const EMPTY: ParsedRCABody = {
  tldr: null,
  summary: null,
  impact: null,
  consequence: null,
  fiveWhys: null,
  rootCauseProse: null,
  immediateResolution: null,
  wentWell: null,
  couldBeBetter: null,
  gotLucky: null,
  actionItems: [],
  timeline: [],
  unstructured: null,
};

interface RawSection {
  level: 2 | 3;
  heading: string;
  body: string;
}

// Parses out a leading TL;DR blockquote (`> **TL;DR** — ...`) if present,
// returning the extracted text and the body with that block stripped.
function extractLeadingTldrBlockquote(body: string): { tldr: string | null; rest: string } {
  const lines = body.split('\n');
  let i = 0;
  // Skip leading blank lines.
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !lines[i].startsWith('>')) return { tldr: null, rest: body };

  const blockLines: string[] = [];
  while (i < lines.length && lines[i].startsWith('>')) {
    blockLines.push(lines[i].replace(/^>\s?/, ''));
    i++;
  }
  const blockText = blockLines.join('\n').trim();
  // Match `**TL;DR** — content` (em dash or hyphen).
  const m = blockText.match(/^\*\*\s*TL[;:]?DR\s*\*\*\s*[—–-]?\s*([\s\S]+)$/i);
  if (!m) return { tldr: null, rest: body };
  const rest = lines.slice(i).join('\n');
  return { tldr: m[1].trim(), rest };
}

// Split the body into H2 sections; each section may contain H3 sub-sections.
function splitH2Sections(body: string): { preamble: string; sections: RawSection[] } {
  const lines = body.split('\n');
  const preambleLines: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;

  for (const ln of lines) {
    if (/^```/.test(ln.trim())) inFence = !inFence;
    if (!inFence) {
      const h2 = ln.match(/^##\s+(.+?)\s*$/);
      const h3 = ln.match(/^###\s+(.+?)\s*$/);
      if (h2 && !ln.startsWith('### ')) {
        if (current) sections.push(current);
        current = { level: 2, heading: h2[1].trim(), body: '' };
        continue;
      }
      if (h3 && current) {
        current.body += ln + '\n';
        continue;
      }
    }
    if (current) current.body += ln + '\n';
    else preambleLines.push(ln);
  }
  if (current) sections.push(current);
  return { preamble: preambleLines.join('\n'), sections };
}

// Inside a section body, split further on H3 headings.
function splitH3(body: string): { preamble: string; sections: RawSection[] } {
  const lines = body.split('\n');
  const preambleLines: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;

  for (const ln of lines) {
    if (/^```/.test(ln.trim())) inFence = !inFence;
    if (!inFence) {
      const h3 = ln.match(/^###\s+(.+?)\s*$/);
      if (h3) {
        if (current) sections.push(current);
        current = { level: 3, heading: h3[1].trim(), body: '' };
        continue;
      }
    }
    if (current) current.body += ln + '\n';
    else preambleLines.push(ln);
  }
  if (current) sections.push(current);
  return { preamble: preambleLines.join('\n'), sections };
}

// Strip italic placeholder lines (e.g. `_(short description)_`) used in templates.
function isPlaceholder(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^_+.*_+$/.test(t)) return true;
  if (/^\*+.*\*+$/.test(t) && !/\w/.test(t.replace(/[*_]/g, ''))) return true;
  return false;
}

// Pull rows out of a markdown pipe-table. Returns null if no table is found.
function parseMarkdownTable(body: string): { headers: string[]; rows: string[][] } | null {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/\|/.test(ln) && lines[i + 1] && /^\s*\|?\s*[-:]/.test(lines[i + 1])) {
      const headerCells = splitTableRow(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      return { headers: headerCells, rows };
    }
    i++;
  }
  return null;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

// "Action Item" → "action", "Owner" → "owner", "Status" → "status".
function classifyHeader(h: string): 'action' | 'status' | 'owner' | 'other' {
  const t = h.toLowerCase();
  if (t.includes('action') || t.includes('item') || t.includes('description')) return 'action';
  if (t.includes('status')) return 'status';
  if (t.includes('owner') || t.includes('assignee')) return 'owner';
  return 'other';
}

function parseActionItemTable(body: string): ActionItemRow[] {
  const tbl = parseMarkdownTable(body);
  if (!tbl) return [];
  const colMap = tbl.headers.map(classifyHeader);
  const rows: ActionItemRow[] = [];
  for (const r of tbl.rows) {
    let action = '';
    let status = '';
    let owner = '';
    r.forEach((cell, idx) => {
      const kind = colMap[idx];
      if (kind === 'action') action = cell;
      else if (kind === 'status') status = cell;
      else if (kind === 'owner') owner = cell;
    });
    if (!action || isPlaceholder(action)) continue;
    // Action cells encode multi-line text as <br> (see composeBody); restore it.
    action = action.replace(/<br\s*\/?>/gi, '\n');
    rows.push({ action, status: status || 'Open', owner });
  }
  return rows;
}

function parseTimelineTable(body: string): TimelineRow[] {
  const tbl = parseMarkdownTable(body);
  if (!tbl) return [];
  const headers = tbl.headers.map((h) => h.toLowerCase());
  const timeIdx = headers.findIndex((h) => h.includes('time'));
  const eventIdx = headers.findIndex((h) => h.includes('event') || h.includes('description'));
  const rows: TimelineRow[] = [];
  for (const r of tbl.rows) {
    const time = (timeIdx >= 0 ? r[timeIdx] : r[0]) ?? '';
    const event = (eventIdx >= 0 ? r[eventIdx] : r[1]) ?? '';
    if (!time && !event) continue;
    if (isPlaceholder(time) && isPlaceholder(event)) continue;
    rows.push({ time, event });
  }
  return rows;
}

function trimSection(s: string): string | null {
  const t = s.replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return null;
  // If the whole content is a single italic placeholder line, drop it.
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length === 1 && isPlaceholder(lines[0])) return null;
  return t;
}

function headingMatches(h: string, ...needles: string[]): boolean {
  const t = h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return needles.some((n) => t === n || t.startsWith(n));
}

export function parseRCABody(body: string): ParsedRCABody {
  if (!body || !body.trim()) return { ...EMPTY, unstructured: null };

  const { tldr: blockTldr, rest } = extractLeadingTldrBlockquote(body);
  const { preamble, sections } = splitH2Sections(rest);

  const out: ParsedRCABody = { ...EMPTY, actionItems: [], timeline: [] };
  if (blockTldr) out.tldr = blockTldr;

  const unmatched: string[] = [];
  if (preamble.trim()) unmatched.push(preamble.trim());

  for (const sec of sections) {
    const h = sec.heading;
    const b = sec.body;

    if (headingMatches(h, 'tl dr', 'tldr')) {
      out.tldr = trimSection(b) ?? out.tldr;
    } else if (headingMatches(h, 'summary')) {
      out.summary = trimSection(b);
    } else if (headingMatches(h, 'what was the impact', 'impact')) {
      // `## Impact` and `## What was the impact?` both land here.
      out.impact = trimSection(b);
    } else if (headingMatches(h, 'what is the consequence', 'consequence')) {
      out.consequence = trimSection(b);
    } else if (headingMatches(h, 'root cause five whys', 'root cause   five whys', 'root cause')) {
      // Root cause section may or may not contain a Five-Whys ordered list.
      // If it has a numbered list, treat the entire body as fiveWhys; else as prose.
      const trimmed = trimSection(b);
      if (!trimmed) continue;
      const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
      const numberedCount = lines.filter((l) => /^\d+\.\s/.test(l)).length;
      if (numberedCount >= 2) {
        // Pull off any prose before the numbered list.
        const firstNumIdx = trimmed.split('\n').findIndex((l) => /^\d+\.\s/.test(l.trim()));
        if (firstNumIdx > 0) {
          const prose = trimmed.split('\n').slice(0, firstNumIdx).join('\n').trim();
          if (prose) out.rootCauseProse = prose;
        }
        out.fiveWhys = trimmed.split('\n').slice(Math.max(0, lines.findIndex((l) => /^\d+\.\s/.test(l)))).join('\n');
        // Be more precise: take the substring starting at the first numbered line.
        const idx = trimmed.search(/^\d+\.\s/m);
        if (idx >= 0) out.fiveWhys = trimmed.slice(idx).trim();
      } else {
        out.rootCauseProse = trimmed;
      }
    } else if (headingMatches(h, 'immediate resolution', 'resolution')) {
      out.immediateResolution = trimSection(b);
    } else if (headingMatches(h, 'takeaways')) {
      const { sections: subs } = splitH3(b);
      for (const sub of subs) {
        if (headingMatches(sub.heading, 'what went well', 'went well')) {
          out.wentWell = trimSection(sub.body);
        } else if (headingMatches(sub.heading, 'what could have been better', 'could be better', 'went wrong')) {
          out.couldBeBetter = trimSection(sub.body);
        } else if (headingMatches(sub.heading, 'where did we get lucky', 'got lucky', 'lucky')) {
          out.gotLucky = trimSection(sub.body);
        }
      }
    } else if (headingMatches(h, 'action items', 'action item')) {
      const { sections: subs } = splitH3(b);
      if (subs.length > 0) {
        for (const sub of subs) {
          const rows = parseActionItemTable(sub.body);
          if (rows.length > 0) {
            out.actionItems.push({ category: sub.heading, rows });
          }
        }
      } else {
        // Maybe it's a single flat table or a checklist.
        const rows = parseActionItemTable(b);
        if (rows.length > 0) {
          out.actionItems.push({ category: 'Action Items', rows });
        } else {
          // Checklist style "- [ ] foo" → treat as Open rows under one bucket.
          const checklistRows = parseChecklistAsActionItems(b);
          if (checklistRows.length > 0) {
            out.actionItems.push({ category: 'Action Items', rows: checklistRows });
          }
        }
      }
    } else if (headingMatches(h, 'timeline')) {
      const tbl = parseTimelineTable(b);
      if (tbl.length > 0) out.timeline = tbl;
      else {
        // Fall back: parse `- HH:MM ... — event` bullet form.
        const rows = parseTimelineBullets(b);
        if (rows.length > 0) out.timeline = rows;
      }
    } else if (headingMatches(h, 'description')) {
      // Free text description — fold into the unstructured bucket.
      const t = trimSection(b);
      if (t) unmatched.push(`## ${h}\n\n${t}`);
    } else {
      const t = trimSection(b);
      if (t) unmatched.push(`## ${h}\n\n${t}`);
    }
  }

  out.unstructured = unmatched.length > 0 ? unmatched.join('\n\n') : null;
  return out;
}

function parseChecklistAsActionItems(body: string): ActionItemRow[] {
  const out: ActionItemRow[] = [];
  for (const ln of body.split('\n')) {
    const m = ln.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (!m) continue;
    const checked = /[xX]/.test(m[1]);
    const action = m[2].trim();
    if (isPlaceholder(action)) continue;
    out.push({ action, status: checked ? 'Done' : 'Open', owner: '' });
  }
  return out;
}

function parseTimelineBullets(body: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const ln of body.split('\n')) {
    const m = ln.match(/^\s*[-*+]\s+`?([^`—–-]{1,40}?)`?\s*[—–-]\s+(.+)$/);
    if (!m) continue;
    const time = m[1].trim();
    const event = m[2].trim();
    if (!time || isPlaceholder(event)) continue;
    rows.push({ time, event });
  }
  return rows;
}

// Heuristic: pull a single big number from a phrase like
// "3,402 failed bookings" → { value: "3,402", label: "failed bookings" }.
export function extractFirstQuantity(text: string | null): { value: string; label: string } | null {
  if (!text) return null;
  const stripped = text.replace(/[*_]/g, '');
  const m = stripped.match(/(\d[\d,]*\.?\d*)\s*([a-zA-Z][a-zA-Z\s/%-]{2,40})/);
  if (!m) return null;
  const value = m[1];
  const label = m[2].trim().split(/[.\n,;]/)[0].trim();
  if (!label) return null;
  return { value, label };
}

// Extract markdown-link URLs and bare URLs from a body. Used by the right
// rail to surface "Related" (in-app /rcas/N) and "Links" (everything else).
export function extractLinks(body: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  // Markdown links first, since their label is more informative.
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(body)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: m[1].trim() });
  }
  const bareRe = /(?<!\]\()(https?:\/\/[^\s)]+)/g;
  while ((m = bareRe.exec(body)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      out.push({ url, label: new URL(url).hostname.replace(/^www\./, '') });
    } catch {
      out.push({ url, label: url });
    }
  }
  return out;
}
