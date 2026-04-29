import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  ChevronLeft,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  deleteRCA,
  fetchRCA,
  fetchRCAHistory,
  regenerateSummary,
  updateRCA,
} from '../api/client';
import type { RCA, RCASeverity, RCAStatus, User } from '../api/types';
import type { UpdateRCAPatch } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import StatusStepper from '../components/StatusStepper';
import SeverityPicker from '../components/SeverityPicker';
import TagInput from '../components/TagInput';
import Avatar from '../components/Avatar';
import UserAutocomplete from '../components/UserAutocomplete';
import ConfirmDialog from '../components/ConfirmDialog';
import CloseRCAModal from '../components/CloseRCAModal';
import Dropdown, { DropdownItem } from '../components/Dropdown';
import PillRow from '../components/PillRow';
import BlamelessBanner from '../components/BlamelessBanner';
import ImpactMetrics from '../components/ImpactMetrics';
import RCATimeline from '../components/RCATimeline';
import FiveWhysCallout from '../components/FiveWhysCallout';
import ActionItemsTable from '../components/ActionItemsTable';
import LessonsPanels from '../components/LessonsPanels';
import RightRail from '../components/RightRail';
import { useToast, getErrorMessage } from '../components/Toaster';
import {
  formatDate,
  fromDatetimeLocal,
  statusLabels,
  timeAgo,
  toDatetimeLocal,
} from '../utils/format';
import { parseRCABody } from '../utils/parseRCABody';

const TS_FIELDS = [
  { key: 'incident_started_at', label: 'Started' },
  { key: 'incident_detected_at', label: 'Detected' },
  { key: 'incident_mitigated_at', label: 'Mitigated' },
  { key: 'incident_resolved_at', label: 'Resolved' },
] as const;

function displayCreator(rca: RCA): { primary: string; secondary?: string } {
  const local = rca.creator_email.split('@')[0] || rca.creator_email;
  if (!rca.creator_name || rca.creator_name === rca.creator_email) {
    return { primary: local, secondary: 'email' };
  }
  return { primary: rca.creator_name };
}

interface InteractiveMarkdownProps {
  body: string;
  onChangeChecklist?: (nextBody: string) => void;
  canEdit?: boolean;
}

// Render markdown with toggleable `- [ ]` checkboxes that PATCH the body.
function InteractiveMarkdown({ body, onChangeChecklist, canEdit }: InteractiveMarkdownProps) {
  const checklistLines = useMemo(() => {
    const lines = body.split('\n');
    const refs: { lineIdx: number; checked: boolean; text: string }[] = [];
    lines.forEach((ln, i) => {
      const m = ln.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
      if (m) {
        refs.push({ lineIdx: i, checked: /[xX]/.test(m[3]), text: m[4] });
      }
    });
    return refs;
  }, [body]);

  const counter = useRef(0);
  counter.current = 0;

  const toggleAt = (idx: number) => {
    if (!canEdit || !onChangeChecklist) return;
    const ref = checklistLines[idx];
    if (!ref) return;
    const lines = body.split('\n');
    const ln = lines[ref.lineIdx];
    const next = ref.checked
      ? ln.replace(/^(\s*[-*+]\s+\[)[xX](\]\s+.*)$/, '$1 $2')
      : ln.replace(/^(\s*[-*+]\s+\[) (\]\s+.*)$/, '$1x$2');
    lines[ref.lineIdx] = next;
    onChangeChecklist(lines.join('\n'));
  };

  return (
    <div className="prose-rca">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          li: (props: ComponentPropsWithoutRef<'li'> & { checked?: boolean | null }) => {
            const { checked, children, className, ...rest } = props;
            if (typeof checked === 'boolean') {
              const myIdx = counter.current++;
              return (
                <li
                  {...rest}
                  className={`${className ?? ''} flex items-start gap-2 list-none -ml-5`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit}
                    onChange={() => toggleAt(myIdx)}
                    className={`mt-1 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 ${
                      !canEdit ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
                    }`}
                  />
                  <span
                    className={`flex-1 ${
                      checked ? 'line-through text-slate-400' : 'text-slate-700'
                    }`}
                  >
                    {children}
                  </span>
                </li>
              );
            }
            return (
              <li {...rest} className={className}>
                {children}
              </li>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <h2 className="text-[16px] font-medium text-slate-900 mb-3 mt-1 flex items-baseline gap-2">
      {children}
      {hint && <span className="text-[12px] font-normal text-slate-500">{hint}</span>}
    </h2>
  );
}

function ProseSection({ markdown }: { markdown: string }) {
  return (
    <div className="prose-rca prose-rca-compact max-w-[68ch]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

interface RCADetailContentProps {
  rca: RCA;
}

function RCADetailContent({ rca }: RCADetailContentProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin, canEdit, canDelete } = useAuth();
  const { success, error, info } = useToast();

  const editable = canEdit(rca);
  const deletable = canDelete(rca);

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(rca.title);

  const [bodyEditing, setBodyEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(rca.body);

  const [assigneesEditing, setAssigneesEditing] = useState(false);
  const [assigneesDraft, setAssigneesDraft] = useState<User[]>(rca.assignees);

  const [showDelete, setShowDelete] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showClose, setShowClose] = useState(false);

  const [servicesDraft, setServicesDraft] = useState<string[]>(rca.services_affected);
  const [tsDraft, setTsDraft] = useState({
    incident_started_at: toDatetimeLocal(rca.incident_started_at),
    incident_detected_at: toDatetimeLocal(rca.incident_detected_at),
    incident_mitigated_at: toDatetimeLocal(rca.incident_mitigated_at),
    incident_resolved_at: toDatetimeLocal(rca.incident_resolved_at),
  });

  // Sync drafts back to the canonical RCA when it refetches — but only
  // when the user is *not* mid-edit, so an in-flight focus refetch doesn't
  // blow away a draft they're typing.
  useEffect(() => {
    if (!titleEditing) setTitleDraft(rca.title);
    if (!bodyEditing) setBodyDraft(rca.body);
    if (!assigneesEditing) setAssigneesDraft(rca.assignees);
    setServicesDraft(rca.services_affected);
    setTsDraft({
      incident_started_at: toDatetimeLocal(rca.incident_started_at),
      incident_detected_at: toDatetimeLocal(rca.incident_detected_at),
      incident_mitigated_at: toDatetimeLocal(rca.incident_mitigated_at),
      incident_resolved_at: toDatetimeLocal(rca.incident_resolved_at),
    });
    // titleEditing/bodyEditing/assigneesEditing intentionally excluded — toggling
    // those flags shouldn't re-pull from rca; the saveX handlers already commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rca]);

  const prevSummaryAt = useRef<string | null>(rca.ai_summary_at);
  useEffect(() => {
    prevSummaryAt.current = rca.ai_summary_at;
  }, [rca.ai_summary_at]);

  const patch = useMutation({
    mutationFn: (p: UpdateRCAPatch) => updateRCA(rca.id, p),
    onSuccess: (next, variables) => {
      queryClient.setQueryData(['rca', rca.id], next);
      queryClient.invalidateQueries({ queryKey: ['rcas'] });
      queryClient.invalidateQueries({ queryKey: ['rca-history', rca.id] });
      if ('status' in variables) {
        success('Status updated', `Now ${statusLabels[next.status]}`);
      }
    },
    onError: (err) => {
      error('Update failed', getErrorMessage(err));
    },
  });

  const del = useMutation({
    mutationFn: () => deleteRCA(rca.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rcas'] });
      success('RCA deleted');
      navigate('/');
    },
    onError: (err) => {
      error('Could not delete RCA', getErrorMessage(err));
    },
  });

  const regen = useMutation({
    mutationFn: () => regenerateSummary(rca.id),
    onMutate: () => {
      info('Regenerating summary…', 'This usually takes a few seconds.');
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['rca', rca.id], next);
      if (next.ai_summary_at && next.ai_summary_at !== prevSummaryAt.current) {
        success('Summary updated');
        prevSummaryAt.current = next.ai_summary_at;
      }
    },
    onError: (err) => {
      error('Regenerate failed', getErrorMessage(err));
    },
  });

  const saveTitle = () => {
    const v = titleDraft.trim();
    if (!v || v === rca.title) {
      setTitleEditing(false);
      setTitleDraft(rca.title);
      return;
    }
    patch.mutate({ title: v });
    setTitleEditing(false);
  };

  const saveBody = () => {
    if (bodyDraft === rca.body) {
      setBodyEditing(false);
      return;
    }
    patch.mutate({ body: bodyDraft });
    setBodyEditing(false);
  };

  const saveAssignees = () => {
    const next = assigneesDraft.map((u) => u.email).sort();
    const prev = rca.assignees.map((u) => u.email).sort();
    if (JSON.stringify(next) === JSON.stringify(prev)) {
      setAssigneesEditing(false);
      return;
    }
    patch.mutate({ assignee_emails: next });
    setAssigneesEditing(false);
  };

  const changeStatus = (next: RCAStatus) => {
    if (!editable) return;
    if (next === rca.status) return;
    // Closing requires a confirm + optional PR-link capture.
    if (next === 'closed') {
      setShowClose(true);
      return;
    }
    patch.mutate({ status: next });
  };

  const confirmClose = (prUrl: string | null) => {
    const updates: UpdateRCAPatch = { status: 'closed' };
    if (prUrl) {
      const heading = '## Pull requests';
      const body = rca.body || '';
      if (body.includes(heading)) {
        // Append to existing section.
        updates.body = body.trimEnd() + `\n- ${prUrl}\n`;
      } else {
        const sep = body.trimEnd() ? body.trimEnd() + '\n\n' : '';
        updates.body = `${sep}${heading}\n\n- ${prUrl}\n`;
      }
    }
    patch.mutate(updates, {
      onSuccess: () => setShowClose(false),
    });
  };

  const changeSeverity = (next: RCASeverity | null) => {
    if (next === rca.severity) return;
    patch.mutate({ severity: next });
  };

  const onChecklistToggle = (nextBody: string) => {
    if (!editable) return;
    queryClient.setQueryData(['rca', rca.id], { ...rca, body: nextBody });
    patch.mutate({ body: nextBody });
  };

  const servicesTimer = useRef<number | null>(null);
  const onServicesChange = (next: string[]) => {
    setServicesDraft(next);
    if (servicesTimer.current) window.clearTimeout(servicesTimer.current);
    servicesTimer.current = window.setTimeout(() => {
      if (JSON.stringify(next) === JSON.stringify(rca.services_affected)) return;
      patch.mutate({ services_affected: next });
    }, 600);
  };

  const tsTimers = useRef<Record<string, number | null>>({});
  const onTsChange = (key: (typeof TS_FIELDS)[number]['key'], v: string) => {
    setTsDraft((d) => ({ ...d, [key]: v }));
    if (tsTimers.current[key]) window.clearTimeout(tsTimers.current[key]!);
    tsTimers.current[key] = window.setTimeout(() => {
      const iso = fromDatetimeLocal(v);
      if (iso === rca[key]) return;
      patch.mutate({ [key]: iso } as UpdateRCAPatch);
    }, 600);
  };

  const { data: history } = useQuery({
    queryKey: ['rca-history', rca.id],
    queryFn: () => fetchRCAHistory(rca.id),
  });

  const showSummaryCard = rca.status === 'rca_done' || rca.status === 'closed';
  const summaryGenerating =
    showSummaryCard && rca.ai_summary == null && (rca.status === 'closed' || rca.status === 'rca_done');

  const creator = displayCreator(rca);
  const parsed = useMemo(() => parseRCABody(rca.body), [rca.body]);

  // The subtitle one-liner: services + environment, falling back gracefully.
  const subtitleParts: string[] = [];
  if (rca.services_affected.length > 0) subtitleParts.push(rca.services_affected.slice(0, 3).join(', '));
  if (rca.environment) subtitleParts.push(rca.environment);
  const subtitle = subtitleParts.join(' · ');

  const hasStructured =
    !!parsed.tldr ||
    !!parsed.summary ||
    !!parsed.impact ||
    !!parsed.consequence ||
    !!parsed.fiveWhys ||
    !!parsed.rootCauseProse ||
    !!parsed.immediateResolution ||
    !!parsed.wentWell ||
    !!parsed.couldBeBetter ||
    !!parsed.gotLucky ||
    parsed.actionItems.length > 0 ||
    parsed.timeline.length > 0;

  const showLessons = !!parsed.wentWell || !!parsed.couldBeBetter || !!parsed.gotLucky;

  return (
    <div className="px-5 md:px-8 py-6 max-w-[1280px] mx-auto">
      {/* Top action row */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <button
          onClick={() => {
            if (window.history.length > 1) navigate(-1);
            else navigate('/');
          }}
          className="inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-900 transition-colors active:scale-[0.97]"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <div className="flex items-center gap-2">
          {editable && (
            <button
              type="button"
              onClick={() => {
                setBodyDraft(rca.body);
                setBodyEditing(true);
              }}
              className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-600 hover:text-slate-900 px-2.5 py-1.5 rounded-lg hover:bg-slate-100 transition-colors active:scale-[0.97]"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit body
            </button>
          )}
          {(deletable || isAdmin) && (
            <Dropdown
              align="right"
              width={220}
              trigger={
                <button
                  type="button"
                  aria-label="More actions"
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              }
            >
              {(close) => (
                <>
                  {isAdmin && showSummaryCard && rca.ai_summary && (
                    <DropdownItem
                      leading={<RefreshCw className="w-4 h-4 text-violet-500" />}
                      onSelect={() => {
                        regen.mutate();
                        close();
                      }}
                    >
                      Regenerate AI summary
                    </DropdownItem>
                  )}
                  {deletable && (
                    <>
                      {isAdmin && showSummaryCard && rca.ai_summary && (
                        <div className="h-px bg-slate-200/70 mx-1 my-1" aria-hidden />
                      )}
                      <DropdownItem
                        danger
                        leading={<Trash2 className="w-4 h-4" />}
                        onSelect={() => {
                          close();
                          setShowDelete(true);
                        }}
                      >
                        Delete RCA
                      </DropdownItem>
                    </>
                  )}
                </>
              )}
            </Dropdown>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="mb-1">
        {titleEditing ? (
          <input
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveTitle();
              } else if (e.key === 'Escape') {
                setTitleDraft(rca.title);
                setTitleEditing(false);
              }
            }}
            className="w-full text-[22px] leading-tight font-medium text-slate-900 tracking-tight bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 soft-focus focus:outline-none focus:border-blue-400"
          />
        ) : (
          <div className="group flex items-start gap-2 min-w-0">
            <h1
              onClick={() => editable && setTitleEditing(true)}
              className={`text-[22px] leading-tight font-medium text-slate-900 tracking-tight flex-1 min-w-0 ${
                editable ? 'cursor-text hover:text-slate-700 transition-colors' : ''
              }`}
              title={editable ? 'Click to edit' : rca.title}
            >
              {rca.title}
            </h1>
            {editable && (
              <button
                type="button"
                onClick={() => setTitleEditing(true)}
                className="shrink-0 opacity-0 group-hover:opacity-100 mt-1.5 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all"
                aria-label="Edit title"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Subtitle (services + env) */}
      {subtitle && (
        <p className="text-[13px] text-slate-500 mb-3">{subtitle}</p>
      )}

      {/* Pill row */}
      <PillRow rca={rca} />

      {/* Blameless banner */}
      <BlamelessBanner />

      {/* Author + creation byline (kept compact, since the right rail also shows author) */}
      <div className="mb-5 flex items-center gap-2 text-[12.5px] text-slate-500">
        <Avatar name={creator.primary} size="xs" />
        <span>
          by <span className="text-slate-700 font-medium">{creator.primary}</span>
          {creator.secondary && <span className="text-slate-400"> ({creator.secondary})</span>}
        </span>
        <span className="text-slate-300">·</span>
        <span title={formatDate(rca.created_at)}>{timeAgo(rca.created_at)}</span>
        {rca.closed_at && (
          <>
            <span className="text-slate-300">·</span>
            <span title={formatDate(rca.closed_at)}>closed {timeAgo(rca.closed_at)}</span>
          </>
        )}
      </div>

      {/* 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6">
        {/* MAIN */}
        <div className="min-w-0 space-y-7">
          {/* Status stepper */}
          <div>
            <StatusStepper
              value={rca.status}
              onChange={changeStatus}
              canEdit={editable}
              pending={patch.isPending}
            />
          </div>

          {/* Impact metrics */}
          <section>
            <SectionHeading>Impact</SectionHeading>
            <ImpactMetrics rca={rca} consequence={parsed.consequence ?? parsed.impact} />
            {(parsed.impact || parsed.consequence) && (
              <div className="mt-4 space-y-3">
                {parsed.impact && (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 font-semibold mb-1.5">
                      User-facing impact
                    </p>
                    <ProseSection markdown={parsed.impact} />
                  </div>
                )}
                {parsed.consequence && (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 font-semibold mb-1.5">
                      Business consequence
                    </p>
                    <ProseSection markdown={parsed.consequence} />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* TL;DR */}
          {parsed.tldr && (
            <section>
              <SectionHeading>TL;DR</SectionHeading>
              <ProseSection markdown={parsed.tldr} />
            </section>
          )}

          {/* Summary (if separate from TL;DR) */}
          {parsed.summary && (
            <section>
              <SectionHeading>Summary</SectionHeading>
              <ProseSection markdown={parsed.summary} />
            </section>
          )}

          {/* Timeline */}
          {(parsed.timeline.length > 0 || (history && history.length > 0)) && (
            <section>
              <SectionHeading hint={parsed.timeline.length > 0 ? 'from RCA body + activity' : 'from activity log'}>
                Timeline
              </SectionHeading>
              <RCATimeline history={history ?? []} bodyTimeline={parsed.timeline} />
            </section>
          )}

          {/* Root cause */}
          {(parsed.rootCauseProse || parsed.fiveWhys) && (
            <section>
              <SectionHeading>Root cause</SectionHeading>
              {parsed.rootCauseProse && (
                <div className="mb-4">
                  <ProseSection markdown={parsed.rootCauseProse} />
                </div>
              )}
              {parsed.fiveWhys && <FiveWhysCallout markdown={parsed.fiveWhys} />}
            </section>
          )}

          {/* Immediate resolution */}
          {parsed.immediateResolution && (
            <section>
              <SectionHeading>Immediate resolution</SectionHeading>
              <ProseSection markdown={parsed.immediateResolution} />
            </section>
          )}

          {/* Action items */}
          {parsed.actionItems.length > 0 && (
            <section>
              <SectionHeading>Action items</SectionHeading>
              <ActionItemsTable groups={parsed.actionItems} />
            </section>
          )}

          {/* Lessons */}
          {showLessons && (
            <section>
              <SectionHeading>What we learned</SectionHeading>
              <LessonsPanels
                wentWell={parsed.wentWell}
                couldBeBetter={parsed.couldBeBetter}
                gotLucky={parsed.gotLucky}
              />
            </section>
          )}

          {/* AI summary card */}
          {showSummaryCard && (
            <section className="relative rounded-2xl p-[1px] bg-gradient-to-br from-violet-300 via-blue-300 to-violet-300 animate-rca-reveal">
              <div className="bg-white rounded-[15px] p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
                      <Sparkles className="w-4 h-4 text-violet-600" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 leading-tight">
                        AI Summary
                      </h3>
                      {rca.ai_summary_at && (
                        <p className="text-[11px] text-slate-500 leading-tight">
                          {rca.ai_summary_model ? `${rca.ai_summary_model} · ` : ''}
                          {timeAgo(rca.ai_summary_at)}
                        </p>
                      )}
                    </div>
                  </div>
                  {isAdmin && rca.ai_summary && (
                    <button
                      onClick={() => regen.mutate()}
                      disabled={regen.isPending}
                      className="inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-all duration-150 disabled:opacity-50 active:scale-[0.97]"
                    >
                      <RefreshCw className={`w-3 h-3 ${regen.isPending ? 'animate-spin' : ''}`} />
                      {regen.isPending ? 'Regenerating' : 'Regenerate'}
                    </button>
                  )}
                </div>

                {rca.ai_summary ? (
                  <div className="prose-rca prose-rca-compact max-w-[68ch]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{rca.ai_summary}</ReactMarkdown>
                  </div>
                ) : summaryGenerating ? (
                  <div className="space-y-2">
                    <div className="skeleton h-3 w-5/6" />
                    <div className="skeleton h-3 w-4/6" />
                    <div className="skeleton h-3 w-3/6" />
                    <p className="text-[11.5px] text-slate-400 mt-2 inline-flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin text-violet-500" />
                      Generating summary…
                    </p>
                  </div>
                ) : (
                  <p className="text-[13px] text-slate-500">
                    A summary will be generated automatically when this RCA reaches "RCA Done" or
                    "Closed".
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Body editor (full raw) */}
          {bodyEditing && (
            <section className="bg-white rounded-2xl ring-1 ring-slate-200/60 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] uppercase tracking-[0.08em] text-slate-500 font-semibold">
                  Edit body (markdown)
                </h3>
              </div>
              <textarea
                value={bodyDraft}
                onChange={(e) => setBodyDraft(e.target.value)}
                rows={20}
                placeholder="Markdown supported"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm soft-focus focus:outline-none focus:border-blue-400 font-mono leading-relaxed"
                autoFocus
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => {
                    setBodyDraft(rca.body);
                    setBodyEditing(false);
                  }}
                  className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 active:scale-[0.97]"
                >
                  Cancel
                </button>
                <button
                  onClick={saveBody}
                  className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 active:scale-[0.97]"
                >
                  Save
                </button>
              </div>
            </section>
          )}

          {/* Unstructured fallback — preserves user-authored sections we don't know how to render. */}
          {!bodyEditing && parsed.unstructured && (
            <section className="max-w-[68ch]">
              <InteractiveMarkdown
                body={parsed.unstructured}
                onChangeChecklist={onChecklistToggle}
                canEdit={editable}
              />
            </section>
          )}

          {!bodyEditing && !hasStructured && !parsed.unstructured && (
            <section>
              <p className="text-[13px] text-slate-400 italic">
                No description yet.{' '}
                {editable && (
                  <button
                    onClick={() => {
                      setBodyDraft(rca.body);
                      setBodyEditing(true);
                    }}
                    className="text-blue-600 hover:text-blue-700 not-italic font-medium"
                  >
                    Add one →
                  </button>
                )}
              </p>
            </section>
          )}

          {/* Editable meta strip — kept below the structured content for power users */}
          {editable && (
            <section className="bg-slate-50/70 rounded-2xl ring-1 ring-slate-200/60 p-4">
              <button
                onClick={() => setShowMeta((v) => !v)}
                className="w-full flex items-center justify-between gap-3 text-left group"
                aria-expanded={showMeta}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="w-7 h-7 rounded-lg bg-white ring-1 ring-slate-200 flex items-center justify-center group-hover:ring-blue-300 transition-colors">
                    <Pencil className="w-3.5 h-3.5 text-slate-500 group-hover:text-blue-600 transition-colors" />
                  </span>
                  <span className="text-[13.5px] font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">
                    Edit details
                  </span>
                  <span className="text-[11px] text-slate-400 hidden sm:inline">
                    severity · environment · services · assignees · times
                  </span>
                </span>
                <span className="text-slate-400 text-lg leading-none">{showMeta ? '−' : '+'}</span>
              </button>
              {showMeta && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10.5px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                      Severity
                    </label>
                    <SeverityPicker value={rca.severity} onChange={changeSeverity} />
                  </div>
                  <div>
                    <label className="block text-[10.5px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                      Services
                    </label>
                    <TagInput
                      value={servicesDraft}
                      onChange={onServicesChange}
                      placeholder="Add and Enter…"
                    />
                  </div>
                  {TS_FIELDS.map((f) => (
                    <div key={f.key}>
                      <label className="block text-[10.5px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                        {f.label}
                      </label>
                      <input
                        type="datetime-local"
                        value={tsDraft[f.key] || ''}
                        onChange={(e) => onTsChange(f.key, e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-[12.5px] tabular-nums soft-focus focus:outline-none focus:border-blue-400 bg-white"
                      />
                    </div>
                  ))}
                  <div className="md:col-span-2">
                    <label className="block text-[10.5px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                      Assignees (IC + co-handlers)
                    </label>
                    {assigneesEditing ? (
                      <div>
                        <UserAutocomplete value={assigneesDraft} onChange={setAssigneesDraft} />
                        <div className="flex justify-end gap-2 mt-2">
                          <button
                            onClick={() => {
                              setAssigneesDraft(rca.assignees);
                              setAssigneesEditing(false);
                            }}
                            className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors active:scale-[0.97]"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={saveAssignees}
                            className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors active:scale-[0.97]"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setAssigneesDraft(rca.assignees);
                          setAssigneesEditing(true);
                        }}
                        className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[12.5px] text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                        {rca.assignees.length === 0
                          ? 'Add assignees'
                          : `${rca.assignees.length} assignee${rca.assignees.length === 1 ? '' : 's'}`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        {/* RIGHT */}
        <RightRail rca={rca} />
      </div>

      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={() => del.mutate()}
        pending={del.isPending}
        variant="danger"
        title="Delete this RCA?"
        description="This will permanently remove the RCA and its history. This can't be undone."
        confirmLabel="Delete RCA"
      />

      <CloseRCAModal
        open={showClose}
        onClose={() => !patch.isPending && setShowClose(false)}
        onConfirm={confirmClose}
        pending={patch.isPending}
      />
    </div>
  );
}

export default function RCADetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const numericId = id ? Number(id) : NaN;

  const { data, isLoading, error, refetch } = useQuery<RCA>({
    queryKey: ['rca', numericId],
    queryFn: () => fetchRCA(numericId),
    enabled: Number.isFinite(numericId),
    refetchInterval: (query) => {
      const r = query.state.data;
      if ((r?.status === 'closed' || r?.status === 'rca_done') && r.ai_summary == null) return 4000;
      return false;
    },
  });

  if (!Number.isFinite(numericId)) {
    return (
      <div className="p-6 text-center">
        <AlertCircle className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <p className="text-sm text-slate-500 font-medium">RCA not found</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="px-5 md:px-8 py-6 max-w-[1280px] mx-auto">
        <div className="skeleton h-3 w-20 mb-4" />
        <div className="skeleton h-7 w-2/3 mb-3" />
        <div className="skeleton h-3 w-40 mb-5" />
        <div className="skeleton h-12 rounded-2xl mb-5" />
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6">
          <div className="space-y-3">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-4 w-4/5" />
          </div>
          <div className="space-y-3">
            <div className="skeleton h-24 rounded-2xl" />
            <div className="skeleton h-16 rounded-2xl" />
            <div className="skeleton h-16 rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-white rounded-2xl border border-slate-200/60 p-12 text-center animate-fade-up">
          <AlertCircle className="w-10 h-10 text-red-300 mx-auto mb-3" />
          <p className="text-sm text-red-600 font-medium mb-1">Failed to load this RCA</p>
          <p className="text-[13px] text-slate-400 mb-4">
            It may have been deleted or you don't have access.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => navigate('/')}
              className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 active:scale-[0.97] inline-flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" />
              Back to list
            </button>
            <button
              onClick={() => refetch()}
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 active:scale-[0.97]"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <RCADetailContent rca={data} />;
}
