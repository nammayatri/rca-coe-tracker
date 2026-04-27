import { useState } from 'react';
import type { RCAHistoryEntry, RCAStatus } from '../api/types';
import type { TimelineRow } from '../utils/parseRCABody';
import { formatDate, statusColors, statusLabels } from '../utils/format';

interface RCATimelineProps {
  history: RCAHistoryEntry[];
  bodyTimeline: TimelineRow[];
}

interface MergedEvent {
  key: string;
  ts: number; // for sort; bodyTimeline rows use Infinity to keep their order at the top
  bucket: 'body' | 'history';
  dot: string;
  time: string;
  actor?: string;
  text: string;
  rawAt?: string;
}

const FIELD_HUMAN: Record<string, string> = {
  title: 'title',
  body: 'description',
  severity: 'severity',
  environment: 'environment',
  services_affected: 'services affected',
  incident_started_at: 'incident start time',
  incident_detected_at: 'incident detection time',
  incident_mitigated_at: 'incident mitigation time',
  incident_resolved_at: 'incident resolution time',
};

function humanizeStatus(value: string): string {
  return statusLabels[value as RCAStatus] ?? value;
}

function shortHandle(value: string | null | undefined): string {
  if (!value) return 'someone';
  return value.split('@')[0] || value;
}

function describeAction(h: RCAHistoryEntry): string {
  switch (h.action) {
    case 'created':
      return 'created this RCA';
    case 'status_changed': {
      const to = h.to_value ? humanizeStatus(h.to_value) : '';
      return to ? `changed status to ${to}` : 'changed status';
    }
    case 'assigned':
      return `assigned ${shortHandle(h.to_value)}`;
    case 'unassigned':
      return `unassigned ${shortHandle(h.to_value ?? h.from_value)}`;
    case 'edited': {
      const field = h.from_value ? FIELD_HUMAN[h.from_value] ?? h.from_value : 'the RCA';
      if (h.from_value === 'severity' && h.to_value) {
        return `changed severity to ${h.to_value.toUpperCase()}`;
      }
      if (h.from_value === 'environment' && h.to_value) {
        return `set environment to ${h.to_value}`;
      }
      if (h.from_value === 'services_affected' && h.to_value) {
        return `updated services to ${h.to_value}`;
      }
      if (h.from_value === 'title' && h.to_value) {
        return `renamed to "${h.to_value}"`;
      }
      return `updated ${field}`;
    }
    case 'deleted':
      return 'deleted the RCA';
    default:
      return h.action;
  }
}

function dotColorForHistory(h: RCAHistoryEntry): string {
  if (h.action === 'created') return 'bg-slate-400';
  if (h.action === 'assigned' || h.action === 'unassigned') return 'bg-blue-500';
  if (h.action === 'status_changed' && h.to_value) {
    const c = statusColors[h.to_value as RCAStatus];
    if (c) return c.dot;
  }
  if (h.action === 'edited') return 'bg-slate-400';
  return 'bg-slate-400';
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const MAX_INITIAL = 12;

export default function RCATimeline({ history, bodyTimeline }: RCATimelineProps) {
  const [expanded, setExpanded] = useState(false);

  const events: MergedEvent[] = [];

  bodyTimeline.forEach((row, i) => {
    events.push({
      key: `body-${i}`,
      ts: -Infinity, // body-defined rows sit above auto events; user controls order
      bucket: 'body',
      dot: 'bg-emerald-500',
      time: row.time,
      text: row.event,
    });
  });

  history.forEach((h) => {
    events.push({
      key: `hist-${h.id}`,
      ts: new Date(h.at).getTime(),
      bucket: 'history',
      dot: dotColorForHistory(h),
      time: shortTime(h.at),
      actor: h.actor_email.split('@')[0],
      text: describeAction(h),
      rawAt: h.at,
    });
  });

  const bodyEvents = events.filter((e) => e.bucket === 'body');
  const historyEvents = events
    .filter((e) => e.bucket === 'history')
    .sort((a, b) => a.ts - b.ts);
  const ordered = [...bodyEvents, ...historyEvents];

  if (ordered.length === 0) {
    return <p className="text-[13px] text-slate-400 italic">No timeline yet.</p>;
  }

  const visible = expanded ? ordered : ordered.slice(0, MAX_INITIAL);
  const hidden = ordered.length - visible.length;

  // Find the first history event in the visible slice — used to render a
  // small label above the activity-log section so users know where the
  // curated timeline ends and the auto-generated activity begins.
  const firstHistoryIdx = visible.findIndex((e) => e.bucket === 'history');
  const showActivitySplit = bodyEvents.length > 0 && firstHistoryIdx > 0;

  return (
    <div className="relative pl-5">
      <span className="absolute left-1 top-1 bottom-1 w-px bg-slate-200" aria-hidden />
      <ol className="space-y-3">
        {visible.flatMap((e, i) => {
          const nodes = [];
          if (showActivitySplit && i === firstHistoryIdx) {
            nodes.push(
              <li key={`split-${e.key}`} className="relative pt-2">
                <span className="text-[10px] uppercase tracking-[0.08em] text-slate-400 font-semibold">
                  Activity log
                </span>
              </li>,
            );
          }
          nodes.push(
            <li key={e.key} className="relative">
              <span
                className={`absolute -left-[18px] top-1.5 w-2.5 h-2.5 rounded-full ${e.dot} ring-2 ring-white`}
                aria-hidden
              />
              <div className="text-[13px] text-slate-700 leading-snug">
                <span
                  className="font-mono text-[11.5px] text-slate-500 mr-2 tabular-nums"
                  title={e.rawAt ? formatDate(e.rawAt) : undefined}
                >
                  {e.time || '—'}
                </span>
                {e.actor && (
                  <span className="font-medium text-slate-900 mr-1.5">{e.actor}</span>
                )}
                <span className="text-slate-600">{e.text}</span>
              </div>
            </li>,
          );
          return nodes;
        })}
      </ol>
      {hidden > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 ml-0 text-[12px] text-blue-600 hover:text-blue-700 font-medium transition-colors active:scale-[0.97]"
        >
          View all ({ordered.length}) →
        </button>
      )}
      {expanded && ordered.length > MAX_INITIAL && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-3 text-[12px] text-slate-500 hover:text-slate-700 font-medium transition-colors active:scale-[0.97]"
        >
          Collapse
        </button>
      )}
    </div>
  );
}
