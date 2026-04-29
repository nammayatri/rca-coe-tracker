import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RCA } from '../api/types';
import Avatar from './Avatar';
import { extractLinks } from '../utils/parseRCABody';

interface RightRailProps {
  rca: RCA;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="block text-[11px] text-slate-500">{label}</span>
      <span className="block text-[12.5px] text-slate-800 leading-snug">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 font-semibold mb-2">
        {title}
      </p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

const RCA_LINK_RE = /^\/rcas\/(\d+)/;

export default function RightRail({ rca }: RightRailProps) {
  const links = extractLinks(rca.body);
  const related = links.filter((l) => RCA_LINK_RE.test(l.url));
  const externalLinks = links
    .filter((l) => !RCA_LINK_RE.test(l.url))
    // Drop ticket-link URLs already shown inline in the action items table.
    .filter((l) => !/^[A-Z][A-Z0-9_-]*-\d+$/.test(l.label))
    .slice(0, 6);

  const ic = rca.assignees[0];
  const coHandlers = rca.assignees.slice(1);
  const creatorDisplay = rca.creator_name || rca.creator_email.split('@')[0];
  const creatorIsAlsoIC = ic && ic.email === rca.creator_email;

  return (
    <aside className="space-y-4">
      <div className="bg-slate-50 rounded-xl ring-1 ring-slate-200/60 p-4 space-y-3">
        <Section title="People">
          <div className="flex items-start gap-2">
            <Avatar name={creatorDisplay} size="xs" />
            <Row label="Author">{creatorDisplay}</Row>
          </div>
          {ic && (
            <div className="flex items-start gap-2">
              <Avatar name={ic.name || ic.email} size="xs" />
              <Row label="IC (incident commander)">
                {ic.name || ic.email.split('@')[0]}
                {creatorIsAlsoIC && <span className="text-slate-400 text-[11px]"> · also author</span>}
              </Row>
            </div>
          )}
          {coHandlers.length > 0 && (
            <div>
              <span className="block text-[11px] text-slate-500 mb-1.5">
                Co-handlers ({coHandlers.length})
              </span>
              <div className="flex flex-wrap gap-1.5">
                {coHandlers.map((u) => {
                  const display = u.name || u.email.split('@')[0];
                  return (
                    <span
                      key={u.email}
                      className="inline-flex items-center gap-1 bg-white rounded-full pl-0.5 pr-2 py-0.5 ring-1 ring-slate-200 text-[11.5px] text-slate-700"
                      title={u.email}
                    >
                      <Avatar name={display} size="xs" />
                      <span className="truncate max-w-[110px]">{display}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </Section>
      </div>

      <div className="bg-slate-50 rounded-xl ring-1 ring-slate-200/60 p-4">
        <Section title="Timeline">
          {rca.incident_started_at && <Row label="Started">{shortDate(rca.incident_started_at)}</Row>}
          {rca.incident_detected_at && <Row label="Detected">{shortDate(rca.incident_detected_at)}</Row>}
          {rca.incident_mitigated_at && <Row label="Mitigated">{shortDate(rca.incident_mitigated_at)}</Row>}
          {rca.incident_resolved_at && <Row label="Resolved">{shortDate(rca.incident_resolved_at)}</Row>}
          {!rca.incident_started_at &&
            !rca.incident_detected_at &&
            !rca.incident_mitigated_at &&
            !rca.incident_resolved_at && (
              <p className="text-[12px] text-slate-400 italic">No incident times recorded</p>
            )}
        </Section>
      </div>

      {related.length > 0 && (
        <div className="bg-slate-50 rounded-xl ring-1 ring-slate-200/60 p-4">
          <Section title="Related">
            {related.map((l) => {
              const idMatch = l.url.match(RCA_LINK_RE);
              const to = idMatch ? `/rcas/${idMatch[1]}` : l.url;
              return (
                <Link
                  key={l.url}
                  to={to}
                  className="block text-[12.5px] text-blue-700 hover:text-blue-900 hover:underline truncate"
                  title={l.label}
                >
                  {l.label}
                </Link>
              );
            })}
          </Section>
        </div>
      )}

      {externalLinks.length > 0 && (
        <div className="bg-slate-50 rounded-xl ring-1 ring-slate-200/60 p-4">
          <Section title="Links">
            {externalLinks.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-[12.5px] text-blue-700 hover:text-blue-900 hover:underline truncate group"
                title={l.url}
              >
                <ExternalLink className="w-3 h-3 shrink-0 opacity-70 group-hover:opacity-100" />
                <span className="truncate">{l.label}</span>
              </a>
            ))}
          </Section>
        </div>
      )}
    </aside>
  );
}
