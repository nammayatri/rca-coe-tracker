import type { ActionItemGroup } from '../utils/parseRCABody';

interface ActionItemsTableProps {
  groups: ActionItemGroup[];
}

interface TypeMeta {
  label: string;
  cls: string;
}

// Map the four action-item buckets to incident.io-style "Type" chips.
function categoryToType(category: string): TypeMeta {
  const c = category.toLowerCase();
  if (c.includes('immediate')) return { label: 'Mitigate', cls: 'bg-orange-50 text-orange-700 ring-orange-100' };
  if (c.includes('monitor') || c.includes('alert')) return { label: 'Detect', cls: 'bg-blue-50 text-blue-700 ring-blue-100' };
  if (c.includes('operational')) return { label: 'Process', cls: 'bg-slate-100 text-slate-700 ring-slate-200/70' };
  if (c.includes('long-term') || c.includes('long term') || c.includes('fundamental') || c.includes('investment')) return { label: 'Prevent', cls: 'bg-red-50 text-red-700 ring-red-100' };
  return { label: 'Action', cls: 'bg-slate-100 text-slate-700 ring-slate-200/70' };
}

interface StatusMeta { label: string; dot: string; text: string; bg: string; ring: string; }

function statusMeta(raw: string): StatusMeta {
  const t = (raw || '').toLowerCase().replace(/[●○•]/g, '').trim();
  if (t.includes('done') || t.includes('complete') || t === 'closed') {
    return { label: 'Done', dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-200' };
  }
  if (t.includes('progress') || t === 'wip') {
    return { label: 'In Progress', dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', ring: 'ring-amber-200' };
  }
  if (t.includes('test')) {
    return { label: 'To Be Tested', dot: 'bg-violet-500', text: 'text-violet-700', bg: 'bg-violet-50', ring: 'ring-violet-200' };
  }
  if (t.includes('block')) {
    return { label: 'Blocked', dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200' };
  }
  if (!t || t.includes('open') || t === '—' || t === '-') {
    return { label: 'Open', dot: 'bg-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', ring: 'ring-blue-200' };
  }
  return { label: raw, dot: 'bg-slate-400', text: 'text-slate-700', bg: 'bg-slate-100', ring: 'ring-slate-200' };
}

const TICKET_LINK_RE = /\[([A-Z][A-Z0-9_-]*-\d+)\]\((https?:\/\/[^)]+)\)/;

interface RenderedAction {
  ticket?: { id: string; url: string };
  rest: string;
}

function splitTicket(action: string): RenderedAction {
  const m = action.match(TICKET_LINK_RE);
  if (!m) return { rest: action };
  const rest = action.replace(TICKET_LINK_RE, '').replace(/^\s*[—–-]\s*/, '').trim();
  return { ticket: { id: m[1], url: m[2] }, rest };
}

// Strip italic emphasis around placeholder text and bare em-dash leaders.
function cleanText(s: string): string {
  return s.replace(/_+/g, '').replace(/^\s*[—–-]\s*/, '').trim();
}

function renderOwner(owner: string) {
  const o = owner.trim();
  if (!o || o === '—' || /^_+.*_+$/.test(o)) return <span className="text-slate-300">—</span>;
  return <span className="text-slate-600">{o.startsWith('@') ? o : o}</span>;
}

export default function ActionItemsTable({ groups }: ActionItemsTableProps) {
  if (groups.length === 0) return null;

  // Flatten with category column so the table reads as a single sortable list.
  const rows: { category: string; action: string; status: string; owner: string }[] = [];
  for (const g of groups) {
    for (const r of g.rows) {
      rows.push({ category: g.category, ...r });
    }
  }
  if (rows.length === 0) return null;

  // Move completed items to the end so "what's left to do" is visible at a glance.
  // Stable sort: not-done rows keep their original order, done rows trail behind.
  const isDone = (r: { status: string }) => statusMeta(r.status).label === 'Done';
  rows.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));

  return (
    <div className="rounded-xl ring-1 ring-slate-200/70 overflow-hidden bg-white">
      <table className="w-full text-[13px] table-fixed">
        <colgroup>
          <col style={{ width: '50%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead className="bg-slate-50/80">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-[11px] uppercase tracking-[0.06em] text-slate-500">
              Item
            </th>
            <th className="text-left px-3 py-2 font-medium text-[11px] uppercase tracking-[0.06em] text-slate-500">
              Type
            </th>
            <th className="text-left px-3 py-2 font-medium text-[11px] uppercase tracking-[0.06em] text-slate-500">
              Owner
            </th>
            <th className="text-left px-3 py-2 font-medium text-[11px] uppercase tracking-[0.06em] text-slate-500">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const { ticket, rest } = splitTicket(r.action);
            const t = categoryToType(r.category);
            const s = statusMeta(r.status);
            const done = s.label === 'Done';
            return (
              <tr
                key={i}
                className={`border-t border-slate-100 align-top transition-colors ${done ? 'bg-slate-50/60' : ''}`}
              >
                <td
                  className={`px-3 py-2.5 leading-relaxed break-words whitespace-pre-line ${
                    done ? 'text-slate-400 line-through' : 'text-slate-700'
                  }`}
                >
                  {ticket && (
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center text-[11.5px] font-medium rounded px-1.5 py-0.5 mr-2 ring-1 transition-colors no-underline ${
                        done
                          ? 'text-slate-400 bg-slate-100 ring-slate-200'
                          : 'text-blue-700 bg-blue-50 ring-blue-100 hover:bg-blue-100'
                      }`}
                    >
                      {ticket.id}
                    </a>
                  )}
                  <span>{cleanText(rest) || cleanText(r.action)}</span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full ring-1 ${t.cls} ${done ? 'opacity-60' : ''}`}
                  >
                    {t.label}
                  </span>
                </td>
                <td className={`px-3 py-2.5 ${done ? 'opacity-60' : ''}`}>{renderOwner(r.owner)}</td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset ${s.bg} ${s.text} ${s.ring}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} aria-hidden />
                    {s.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
