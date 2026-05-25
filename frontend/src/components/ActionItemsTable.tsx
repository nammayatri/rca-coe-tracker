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

function statusMeta(raw: string): { label: string; dot: string; text: string } {
  const t = (raw || '').toLowerCase().replace(/[●○•]/g, '').trim();
  if (t.includes('done') || t.includes('complete') || t === 'closed') return { label: 'Done', dot: 'bg-emerald-500', text: 'text-emerald-700' };
  if (t.includes('progress') || t === 'wip') return { label: 'In Progress', dot: 'bg-amber-500', text: 'text-amber-700' };
  if (t.includes('test')) return { label: 'To Be Tested', dot: 'bg-blue-500', text: 'text-blue-700' };
  if (t.includes('block')) return { label: 'Blocked', dot: 'bg-red-500', text: 'text-red-700' };
  if (!t || t.includes('open') || t === '—' || t === '-') return { label: 'Open', dot: 'bg-slate-300', text: 'text-slate-600' };
  return { label: raw, dot: 'bg-slate-300', text: 'text-slate-600' };
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
            return (
              <tr key={i} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2.5 text-slate-700 leading-relaxed break-words whitespace-pre-line">
                  {ticket && (
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-[11.5px] font-medium text-blue-700 bg-blue-50 ring-1 ring-blue-100 rounded px-1.5 py-0.5 mr-2 hover:bg-blue-100 transition-colors"
                    >
                      {ticket.id}
                    </a>
                  )}
                  <span>{cleanText(rest) || cleanText(r.action)}</span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full ring-1 ${t.cls}`}
                  >
                    {t.label}
                  </span>
                </td>
                <td className="px-3 py-2.5">{renderOwner(r.owner)}</td>
                <td className="px-3 py-2.5">
                  <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${s.text}`}>
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
