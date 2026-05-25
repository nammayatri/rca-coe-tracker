import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { createRCA, updateRCA } from '../api/client';
import type { RCA, RCASeverity, User } from '../api/types';
import UserAutocomplete from './UserAutocomplete';
import SeverityPicker from './SeverityPicker';
import TagInput from './TagInput';
import Modal from './Modal';
import Dropdown, { DropdownItem } from './Dropdown';
import DatePicker, { type DatePickerPreset } from './DatePicker';
import { useToast, getErrorMessage } from './Toaster';
import { formatDuration } from '../utils/format';
import {
  ACTION_CATEGORIES,
  ACTION_STATUS_PRESETS,
  composeBody,
  contentFromMarkdown,
  contentFromRCA,
  emptyContent,
  emptyActionRow,
  emptyTimelineRow,
  serializeContent,
  type ActionCategory,
  type ActionItemRow,
  type ActionStatus,
  type RCAContent,
  type TimelineRow,
} from '../utils/rcaContent';

type Mode = 'create' | 'edit';

interface RCAFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** The RCA being edited. Required when mode === 'edit'. */
  rca?: RCA;
}

// v2: draft now nests the structured fields under `content` (was flat in v1).
const DRAFT_KEY = 'rca-tracker:create-draft:v2';

interface DraftShape {
  savedAt: string;
  title: string;
  severity: RCASeverity | null;
  services: string[];
  startedAt: string;
  detectedAt: string;
  mitigatedAt: string;
  resolvedAt: string;
  assignees: User[];
  content: RCAContent;
  overrideBody: string | null;
}

function readDraft(): DraftShape | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DraftShape;
  } catch {
    return null;
  }
}

function writeDraft(d: DraftShape): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // localStorage full or disabled — silently skip; the user just loses draft persistence.
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

function draftIsMeaningful(d: DraftShape): boolean {
  if (d.title.trim()) return true;
  if (d.severity) return true;
  if (d.services.length || d.assignees.length) return true;
  const c = d.content;
  if (!c) return false;
  if (
    c.tldr?.trim() ||
    c.summary.trim() ||
    c.impact.trim() ||
    c.consequence.trim() ||
    c.fiveWhys.trim() ||
    c.immediateResolution.trim() ||
    c.wentWell.trim() ||
    c.couldBeBetter.trim() ||
    c.gotLucky.trim()
  ) {
    return true;
  }
  if (c.timeline?.some((r) => r.time.trim() || r.event.trim())) return true;
  for (const cat of ACTION_CATEGORIES) {
    if (c.actions?.[cat]?.some((r) => r.action.trim() || r.owner)) return true;
  }
  return false;
}

export default function RCAFormModal({ open, onClose, mode, rca }: RCAFormModalProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error } = useToast();

  // ── Metadata fields (come straight off the RCA in edit mode) ──
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<RCASeverity | null>(null);
  const [services, setServices] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState('');
  const [detectedAt, setDetectedAt] = useState('');
  const [mitigatedAt, setMitigatedAt] = useState('');
  const [resolvedAt, setResolvedAt] = useState('');
  const [assignees, setAssignees] = useState<User[]>([]);
  const [touched, setTouched] = useState(false);

  // ── Structured body fields ──
  const [tldr, setTldr] = useState('');
  const [summary, setSummary] = useState('');
  const [impact, setImpact] = useState('');
  const [consequence, setConsequence] = useState('');
  const [fiveWhys, setFiveWhys] = useState('');
  const [immediateResolution, setImmediateResolution] = useState('');
  const [wentWell, setWentWell] = useState('');
  const [couldBeBetter, setCouldBeBetter] = useState('');
  const [gotLucky, setGotLucky] = useState('');
  const [actions, setActions] = useState<Record<ActionCategory, ActionItemRow[]>>(
    () => emptyContent().actions,
  );
  const [timeline, setTimeline] = useState<TimelineRow[]>(() => [emptyTimelineRow()]);
  // Unstructured markdown we don't model but must preserve across edits.
  const [extra, setExtra] = useState('');

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideBody, setOverrideBody] = useState<string | null>(null);

  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const skipNextSave = useRef(false);

  const applyContent = (c: RCAContent) => {
    setTldr(c.tldr);
    setSummary(c.summary);
    setImpact(c.impact);
    setConsequence(c.consequence);
    setFiveWhys(c.fiveWhys);
    setImmediateResolution(c.immediateResolution);
    setWentWell(c.wentWell);
    setCouldBeBetter(c.couldBeBetter);
    setGotLucky(c.gotLucky);
    setActions(c.actions);
    setTimeline(c.timeline);
    setExtra(c.extra);
  };

  const reset = () => {
    setTitle('');
    setSeverity(null);
    setServices([]);
    setStartedAt('');
    setDetectedAt('');
    setMitigatedAt('');
    setResolvedAt('');
    setAssignees([]);
    setTouched(false);
    applyContent(emptyContent());
    setOverrideOpen(false);
    setOverrideBody(null);
    setDraftRestored(false);
    setDraftSavedAt(null);
  };

  // Seed the form when it opens: from the RCA in edit mode, from a saved draft
  // (or blank) in create mode. Keyed on rca?.id, NOT the rca object — so a
  // background refetch while the modal is open won't clobber in-progress edits.
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && rca) {
      skipNextSave.current = true;
      setTitle(rca.title);
      setSeverity(rca.severity);
      setServices(rca.services_affected);
      setStartedAt(rca.incident_started_at ?? '');
      setDetectedAt(rca.incident_detected_at ?? '');
      setMitigatedAt(rca.incident_mitigated_at ?? '');
      setResolvedAt(rca.incident_resolved_at ?? '');
      setAssignees(rca.assignees);
      setTouched(false);
      applyContent(contentFromRCA(rca));
      setOverrideOpen(false);
      setOverrideBody(null);
      setDraftRestored(false);
      setDraftSavedAt(null);
      return;
    }
    // create
    const d = readDraft();
    if (d && draftIsMeaningful(d)) {
      skipNextSave.current = true;
      setTitle(d.title || '');
      setSeverity(d.severity ?? null);
      setServices(d.services || []);
      setStartedAt(d.startedAt || '');
      setDetectedAt(d.detectedAt || '');
      setMitigatedAt(d.mitigatedAt || '');
      setResolvedAt(d.resolvedAt || '');
      setAssignees(d.assignees || []);
      applyContent({ ...emptyContent(), ...d.content, extra: d.content?.extra ?? '' });
      setOverrideBody(d.overrideBody ?? null);
      setOverrideOpen(d.overrideBody != null);
      setDraftRestored(true);
      setDraftSavedAt(d.savedAt || null);
    } else {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, rca?.id]);

  const buildContent = (): RCAContent => ({
    tldr,
    summary,
    impact,
    consequence,
    fiveWhys,
    immediateResolution,
    wentWell,
    couldBeBetter,
    gotLucky,
    actions,
    timeline,
    extra,
  });

  const composedBody = useMemo(
    () => composeBody(buildContent()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tldr, summary, impact, consequence, fiveWhys, immediateResolution,
      wentWell, couldBeBetter, gotLucky, actions, timeline, extra,
    ],
  );

  const finalBody = overrideBody ?? composedBody;

  // Autosave the draft — create mode only. Edit mode never touches the draft.
  useEffect(() => {
    if (!open || mode !== 'create') return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const draft: DraftShape = {
        savedAt: new Date().toISOString(),
        title,
        severity,
        services,
        startedAt,
        detectedAt,
        mitigatedAt,
        resolvedAt,
        assignees,
        content: buildContent(),
        overrideBody,
      };
      if (draftIsMeaningful(draft)) {
        writeDraft(draft);
        setDraftSavedAt(draft.savedAt);
      } else {
        clearDraft();
        setDraftSavedAt(null);
      }
    }, 600);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open, mode, title, severity, services,
    startedAt, detectedAt, mitigatedAt, resolvedAt, assignees,
    tldr, summary, impact, consequence, fiveWhys, immediateResolution,
    wentWell, couldBeBetter, gotLucky, actions, timeline, extra, overrideBody,
  ]);

  const discardDraft = () => {
    clearDraft();
    reset();
  };

  const mutation = useMutation({
    mutationFn: async () => {
      // Keep body + content consistent: if the raw-markdown override is in use,
      // derive content from it; otherwise render the body from the structured
      // fields. Either way body is the rendered form of content.
      const content =
        overrideBody !== null ? contentFromMarkdown(overrideBody) : buildContent();
      const body = (overrideBody !== null ? overrideBody : composeBody(content)).trim();
      const contentJson = serializeContent(content);

      if (mode === 'edit' && rca) {
        return updateRCA(rca.id, {
          title: title.trim(),
          body,
          content: contentJson,
          assignee_emails: assignees.map((a) => a.email),
          severity: severity ?? null,
          services_affected: services,
          incident_started_at: startedAt || null,
          incident_detected_at: detectedAt || null,
          incident_mitigated_at: mitigatedAt || null,
          incident_resolved_at: resolvedAt || null,
        });
      }
      return createRCA({
        title: title.trim(),
        body: body || undefined,
        content: contentJson,
        assignee_emails: assignees.map((a) => a.email),
        severity: severity ?? undefined,
        environment: 'prod',
        services_affected: services.length ? services : undefined,
        incident_started_at: startedAt || undefined,
        incident_detected_at: detectedAt || undefined,
        incident_mitigated_at: mitigatedAt || undefined,
        incident_resolved_at: resolvedAt || undefined,
      });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['rcas'] });
      if (mode === 'edit') {
        queryClient.setQueryData(['rca', saved.id], saved);
        queryClient.invalidateQueries({ queryKey: ['rca-history', saved.id] });
        success('RCA updated', saved.title);
        onClose();
      } else {
        success('RCA created', saved.title);
        clearDraft();
        reset();
        onClose();
        navigate(`/rcas/${saved.id}`);
      }
    },
    onError: (err) => {
      error(mode === 'edit' ? 'Could not save changes' : 'Could not create RCA', getErrorMessage(err));
    },
  });

  const titleValid = title.trim().length >= 3;
  // Severity is required to create; on edit we don't block (legacy RCAs may
  // have none) but still surface the picker.
  const canSubmit = titleValid && (mode === 'edit' || severity !== null) && !mutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!titleValid) return;
    if (mode === 'create' && severity === null) return;
    mutation.mutate();
  };

  const handleClose = () => {
    if (mutation.isPending) return;
    if (mode === 'create') reset();
    onClose();
  };

  const updateActionRow = (cat: ActionCategory, idx: number, patch: Partial<ActionItemRow>) => {
    setActions((prev) => ({
      ...prev,
      [cat]: prev[cat].map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  };

  const addActionRow = (cat: ActionCategory) => {
    setActions((prev) => ({ ...prev, [cat]: [...prev[cat], emptyActionRow()] }));
  };

  const removeActionRow = (cat: ActionCategory, idx: number) => {
    setActions((prev) => {
      const next = prev[cat].filter((_, i) => i !== idx);
      return { ...prev, [cat]: next.length === 0 ? [emptyActionRow()] : next };
    });
  };

  const updateTimelineRow = (idx: number, patch: Partial<TimelineRow>) => {
    setTimeline((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addTimelineRow = () => {
    setTimeline((prev) => [...prev, emptyTimelineRow()]);
  };

  const removeTimelineRow = (idx: number) => {
    setTimeline((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? [emptyTimelineRow()] : next;
    });
  };

  const ttd = startedAt && detectedAt ? formatDuration(startedAt, detectedAt) : null;
  const ttRespond = detectedAt && mitigatedAt ? formatDuration(detectedAt, mitigatedAt) : null;
  const ttResolve = startedAt && resolvedAt ? formatDuration(startedAt, resolvedAt) : null;
  const showTimingChips = ttd || ttRespond || ttResolve;

  const sectionStatus = {
    incident: titleValid || severity !== null || services.length > 0,
    times: !!(startedAt || detectedAt || mitigatedAt || resolvedAt),
    assignees: assignees.length > 0,
    tldr: tldr.trim().length > 0,
    summary: summary.trim().length > 0,
    impact: impact.trim().length > 0,
    consequence: consequence.trim().length > 0,
    fivewhys: fiveWhys.trim().length > 0,
    resolution: immediateResolution.trim().length > 0,
    takeaways: !!(wentWell.trim() || couldBeBetter.trim() || gotLucky.trim()),
    actions: Object.values(actions).some((rows) => rows.some((r) => r.action.trim() || r.owner)),
    timeline: timeline.some((r) => r.time.trim() || r.event.trim()),
  };

  const SECTION_NAV: { id: keyof typeof sectionStatus; label: string }[] = [
    { id: 'incident', label: 'Incident' },
    { id: 'times', label: 'Times' },
    { id: 'assignees', label: 'Assignees' },
    { id: 'tldr', label: 'TL;DR' },
    { id: 'summary', label: 'Summary' },
    { id: 'impact', label: 'Impact' },
    { id: 'consequence', label: 'Consequence' },
    { id: 'fivewhys', label: '5 Whys' },
    { id: 'resolution', label: 'Resolution' },
    { id: 'takeaways', label: 'Takeaways' },
    { id: 'actions', label: 'Action items' },
    { id: 'timeline', label: 'Timeline' },
  ];

  const filledCount = SECTION_NAV.filter((s) => sectionStatus[s.id]).length;

  const scrollPaneRef = useRef<HTMLDivElement | null>(null);
  const scrollToSection = (id: string) => {
    const el = document.getElementById(`rca-section-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canSubmit) mutation.mutate();
    }
  };

  const isEdit = mode === 'edit';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="4xl"
      ariaLabel={isEdit ? 'Edit RCA' : 'Create new RCA'}
      closeOnBackdrop={!mutation.isPending}
      closeOnEsc={!mutation.isPending}
    >
      <>
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200/70 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              {isEdit ? (
                <Pencil className="w-4 h-4 text-blue-600" />
              ) : (
                <Plus className="w-4 h-4 text-blue-600" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900 truncate">
                {isEdit ? 'Edit RCA' : 'New RCA'}
              </h3>
              <p className="text-[12px] text-slate-500 truncate">
                {isEdit
                  ? 'Update any section — body and structured data are saved together.'
                  : 'Capture the incident scaffold — fields here drive the body template and computed durations.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isEdit && draftSavedAt && (
              <span
                className="text-[11px] text-slate-400 hidden md:inline-flex items-center gap-1"
                title={`Draft auto-saved at ${new Date(draftSavedAt).toLocaleTimeString()}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Draft saved
              </span>
            )}
            {!isEdit && draftRestored && (
              <button
                type="button"
                onClick={discardDraft}
                className="text-[12px] text-slate-500 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded-md inline-flex items-center gap-1 transition-colors"
                title="Discard restored draft and start fresh"
              >
                <RotateCcw className="w-3 h-3" />
                Start fresh
              </button>
            )}
            <button
              onClick={handleClose}
              className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-lg hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="flex flex-col min-h-0 flex-1">
          <div className="flex flex-1 min-h-0">
            <nav
              aria-label="Form sections"
              className="hidden lg:flex flex-col w-[200px] shrink-0 border-r border-slate-200/70 px-2 py-5 overflow-y-auto custom-scrollbar bg-slate-50/40"
            >
              <div className="px-2 mb-2 text-[10px] uppercase tracking-[0.08em] text-slate-400 font-semibold">
                Sections
              </div>
              {SECTION_NAV.map((s) => {
                const filled = sectionStatus[s.id];
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => scrollToSection(s.id)}
                    className={`text-left text-[13px] py-1.5 px-2 rounded-md inline-flex items-center gap-2 transition-colors ${
                      filled ? 'text-slate-900 hover:bg-slate-100 font-medium' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-full inline-flex items-center justify-center shrink-0 transition-all ${
                        filled ? 'bg-emerald-500 ring-2 ring-emerald-100' : 'bg-white border border-slate-300'
                      }`}
                    >
                      {filled && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
                    </span>
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
              <div className="px-2 mt-3 pt-3 border-t border-slate-200/60 text-[11px] text-slate-500 tabular-nums">
                <span className="font-medium text-slate-700">{filledCount}</span>
                <span className="text-slate-400"> of {SECTION_NAV.length} filled</span>
              </div>
              <div className="px-2 mt-1 text-[10.5px] text-slate-400">Cmd / Ctrl + Enter to submit</div>
            </nav>
            <div ref={scrollPaneRef} className="flex-1 min-w-0 px-6 py-5 space-y-6 overflow-y-auto custom-scrollbar">
              <Section id="incident" label="Incident">
                <FieldLabel required>Title</FieldLabel>
                <AutoGrowField
                  value={title}
                  onChange={setTitle}
                  placeholder="e.g. Driver app — repeated 502s during 8pm peak"
                  minHeight={46}
                  autoFocus
                  className={`w-full px-3.5 py-2.5 rounded-lg border text-[15px] soft-focus focus:outline-none focus:border-blue-400 ${
                    touched && !titleValid ? 'border-red-300 bg-red-50' : 'border-slate-300'
                  }`}
                />
                {touched && !titleValid && (
                  <p className="text-xs text-red-500 mt-1">Title must be at least 3 characters.</p>
                )}

                <div className="mt-5">
                  <FieldLabel required={!isEdit}>Severity</FieldLabel>
                  <div className="[&_button]:px-3 [&_button]:py-1 [&_button]:text-[12px]">
                    <SeverityPicker value={severity} onChange={setSeverity} />
                  </div>
                  {touched && !isEdit && severity === null && (
                    <p className="text-xs text-red-500 mt-1">Pick a severity.</p>
                  )}
                </div>

                <div className="mt-5">
                  <FieldLabel>Services affected</FieldLabel>
                  <TagInput
                    value={services}
                    onChange={setServices}
                    placeholder="dynamic-offer-driver, beckn-gateway… (Enter / comma)"
                  />
                </div>
              </Section>

              <Section id="times" label="Incident times">
                <p className="text-[12px] text-slate-500 -mt-1 mb-3">
                  Time to Detect / Respond / Resolve are computed live from these.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <DateTimeField label="Started" value={startedAt} onChange={setStartedAt} />
                  <DateTimeField label="Detected" value={detectedAt} onChange={setDetectedAt} />
                  <DateTimeField label="Mitigated" value={mitigatedAt} onChange={setMitigatedAt} />
                  <DateTimeField label="Resolved" value={resolvedAt} onChange={setResolvedAt} />
                </div>
                {showTimingChips && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {ttd && <TimingChip label="Time to Detect" value={ttd} />}
                    {ttRespond && <TimingChip label="Time to Respond" value={ttRespond} />}
                    {ttResolve && <TimingChip label="Time to Resolve" value={ttResolve} />}
                  </div>
                )}
              </Section>

              <Section id="assignees" label="Assignees">
                <UserAutocomplete value={assignees} onChange={setAssignees} placeholder="Search teammates…" />
              </Section>

              <Section id="tldr" label="TL;DR">
                <BodyTextarea
                  value={tldr}
                  onChange={setTldr}
                  placeholder="1-2 line summary: what broke, blast radius, how long, how we got out."
                  minHeight={70}
                />
              </Section>

              <Section id="summary" label="Summary">
                <BodyTextarea value={summary} onChange={setSummary} placeholder="What happened, in 1-2 lines per incident." />
              </Section>

              <Section id="impact" label="What was the impact?">
                <BodyTextarea value={impact} onChange={setImpact} placeholder="User-facing impact." />
              </Section>

              <Section id="consequence" label="What is the consequence of impact?">
                <BodyTextarea
                  value={consequence}
                  onChange={setConsequence}
                  placeholder="Business consequence: bounce, churn, drop, revenue."
                />
              </Section>

              <Section id="fivewhys" label="Root cause — Five Whys">
                <BodyTextarea
                  value={fiveWhys}
                  onChange={setFiveWhys}
                  placeholder="Why? ... Why? ... (drill 5 levels)"
                  minHeight={140}
                />
              </Section>

              <Section id="resolution" label="Immediate Resolution">
                <BodyTextarea
                  value={immediateResolution}
                  onChange={setImmediateResolution}
                  placeholder="What stopped the bleeding."
                />
              </Section>

              <Section id="takeaways" label="Takeaways">
                <div className="space-y-4">
                  <div>
                    <FieldLabel>What went well?</FieldLabel>
                    <BodyTextarea
                      value={wentWell}
                      onChange={setWentWell}
                      placeholder="Things that worked — runbook, comms, tooling, a teammate's quick thinking."
                      minHeight={80}
                    />
                  </div>
                  <div>
                    <FieldLabel>What could have been better?</FieldLabel>
                    <BodyTextarea
                      value={couldBeBetter}
                      onChange={setCouldBeBetter}
                      placeholder="Gaps in tooling, runbook, alerting, ownership, comms."
                      minHeight={80}
                    />
                  </div>
                  <div>
                    <FieldLabel>Where did we get lucky?</FieldLabel>
                    <BodyTextarea
                      value={gotLucky}
                      onChange={setGotLucky}
                      placeholder="Things that could have been much worse but weren't, by luck rather than design."
                      minHeight={80}
                    />
                  </div>
                </div>
              </Section>

              <Section id="actions" label="Action Items">
                <div className="space-y-5">
                  {ACTION_CATEGORIES.map((cat) => (
                    <ActionItemTable
                      key={cat}
                      category={cat}
                      rows={actions[cat]}
                      onUpdate={(idx, patch) => updateActionRow(cat, idx, patch)}
                      onAdd={() => addActionRow(cat)}
                      onRemove={(idx) => removeActionRow(cat, idx)}
                    />
                  ))}
                </div>
              </Section>

              <Section id="timeline" label="Timeline">
                <TimelineTable
                  rows={timeline}
                  onUpdate={updateTimelineRow}
                  onAdd={addTimelineRow}
                  onRemove={removeTimelineRow}
                />
              </Section>

              <details
                className="border-t border-slate-200/60 pt-4"
                open={overrideOpen}
                onToggle={(e) => {
                  const next = (e.target as HTMLDetailsElement).open;
                  setOverrideOpen(next);
                  if (!next) setOverrideBody(null);
                }}
              >
                <summary className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2 cursor-pointer select-none">
                  Advanced: edit raw markdown
                </summary>
                <p className="text-[12px] text-slate-500 mb-2">
                  Live preview of the composed body. Editing here overrides the structured fields until you collapse
                  this section.
                </p>
                <AutoGrowTextarea
                  value={finalBody}
                  onChange={(v) => setOverrideBody(v)}
                  placeholder="Markdown supported"
                  minHeight={320}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-[13px] leading-relaxed soft-focus focus:outline-none focus:border-blue-400 font-mono"
                />
              </details>

              {mutation.isError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-100">
                  <p className="text-sm text-red-700">
                    {isEdit ? 'Failed to save changes. Please try again.' : 'Failed to create RCA. Please try again.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-slate-200/70 shrink-0 bg-slate-50/60 rounded-b-2xl">
            <button
              type="button"
              onClick={handleClose}
              disabled={mutation.isPending}
              className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-500/20 inline-flex items-center gap-2"
            >
              {mutation.isPending && (
                <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {mutation.isPending
                ? isEdit
                  ? 'Saving…'
                  : 'Creating…'
                : isEdit
                ? 'Save changes'
                : 'Create RCA'}
            </button>
          </div>
        </form>
      </>
    </Modal>
  );
}

function Section({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <section
      id={id ? `rca-section-${id}` : undefined}
      style={{ scrollMarginTop: 12 }}
      className="border-t border-slate-200/60 pt-4 first:border-t-0 first:pt-0"
    >
      <h4 className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2">{label}</h4>
      {children}
    </section>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-slate-700 mb-1.5">
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function TimingChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="bg-slate-100 rounded-md px-2 py-1 text-[11px] text-slate-600">
      <span className="font-medium text-slate-700">{label}:</span>{' '}
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

const DATETIME_PRESETS: DatePickerPreset[] = [
  { label: 'Now', compute: () => new Date() },
  { label: '−15m', compute: () => new Date(Date.now() - 15 * 60_000) },
  { label: '−1h', compute: () => new Date(Date.now() - 60 * 60_000) },
  { label: '−6h', compute: () => new Date(Date.now() - 6 * 60 * 60_000) },
];

function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="block min-w-0">
      <div className="text-[12px] font-medium text-slate-500 mb-1">{label}</div>
      <DatePicker
        value={value || null}
        onChange={(next) => onChange(next ?? '')}
        withTime
        placeholder={`Pick ${label.toLowerCase()} time`}
        presets={DATETIME_PRESETS}
      />
    </div>
  );
}

// Resize a textarea to fit its content, deferred to the next animation frame so
// we don't force a synchronous reflow on every keystroke.
function useAutoGrow(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  minHeight: number,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      // Reset then measure so the box shrinks back when text is deleted.
      el.style.height = 'auto';
      el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, value, minHeight]);
}

// A textarea that grows to fit its content so everything typed stays visible
// (no inner scrollbar) and wraps long lines. Height never drops below minHeight.
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  minHeight = 100,
  className,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
  className: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, minHeight);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      autoFocus={autoFocus}
      rows={1}
      // break-words + overflow-hidden so long unbroken strings wrap instead of
      // forcing a scrollbar; resize-none because we manage height ourselves.
      style={{ minHeight }}
      className={`${className} resize-none overflow-hidden break-words whitespace-pre-wrap`}
    />
  );
}

// A single-line-style field that still WRAPS and grows to show all text, but
// strips hard newlines — used for the title and for action-item / timeline
// cells that get rendered into a markdown table (a literal newline there would
// break the table row). Plain Enter is swallowed; Cmd/Ctrl+Enter bubbles up to
// submit the form.
function AutoGrowField({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 38,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className: string;
  minHeight?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, minHeight);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) e.preventDefault();
      }}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      autoFocus={autoFocus}
      rows={1}
      style={{ minHeight }}
      className={`${className} resize-none overflow-hidden break-words whitespace-pre-wrap`}
    />
  );
}

function BodyTextarea({
  value,
  onChange,
  placeholder,
  minHeight = 100,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
}) {
  return (
    <AutoGrowTextarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      minHeight={minHeight}
      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-[13px] leading-relaxed soft-focus focus:outline-none focus:border-blue-400"
    />
  );
}

function ActionItemTable({
  category,
  rows,
  onUpdate,
  onAdd,
  onRemove,
}: {
  category: ActionCategory;
  rows: ActionItemRow[];
  onUpdate: (idx: number, patch: Partial<ActionItemRow>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="min-w-0">
      <h5 className="text-sm font-semibold text-slate-700 mb-2">{category}</h5>
      <div className="hidden sm:flex items-center gap-2 px-1 mb-1.5 text-[11px] text-slate-400 uppercase tracking-wide">
        <div className="flex-1 min-w-0">Action Item</div>
        <div className="w-32 shrink-0">Status</div>
        <div className="w-40 shrink-0">Owner</div>
        <div className="w-7 shrink-0" />
      </div>
      <div className="space-y-2 sm:space-y-1.5">
        {rows.map((row, idx) => (
          <div
            key={row.id}
            className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-2 rounded-lg sm:rounded-none border sm:border-0 border-slate-200 p-2 sm:p-0"
          >
            <AutoGrowField
              value={row.action}
              onChange={(v) => onUpdate(idx, { action: v })}
              placeholder="short description / tracker link"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm soft-focus focus:outline-none focus:border-blue-400"
            />
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink-0">
              <ActionStatusDropdown value={row.status} onChange={(s) => onUpdate(idx, { status: s })} />
              <div className="w-40 sm:w-40 shrink-0 min-w-0">
                <UserAutocomplete
                  value={row.owner ? [row.owner] : []}
                  onChange={(arr) => onUpdate(idx, { owner: arr[0] ?? null })}
                  max={1}
                  single
                  placeholder="Owner"
                />
              </div>
              <button
                type="button"
                onClick={() => onRemove(idx)}
                aria-label="Remove row"
                className="text-slate-400 hover:text-red-500 hover:bg-red-50 rounded p-1 shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5">
        <button
          type="button"
          onClick={onAdd}
          className="text-blue-600 hover:bg-blue-50 text-xs px-2 py-1 rounded inline-flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          Add row
        </button>
      </div>
      <p className="text-[11px] text-slate-400 italic mt-1">
        Tip: file each item in your tracker (Jira / Linear / GitHub) and paste the link in the action column.
      </p>
    </div>
  );
}

const ACTION_STATUS_DOT: Record<string, string> = {
  Open: 'bg-blue-500',
  'In Progress': 'bg-amber-500',
  'To Be Tested': 'bg-violet-500',
  Closed: 'bg-slate-400',
};
// Unknown/custom statuses (e.g. imported "Blocked") get a neutral dot.
const statusDot = (s: string) => ACTION_STATUS_DOT[s] ?? 'bg-slate-300';

function ActionStatusDropdown({
  value,
  onChange,
}: {
  value: ActionStatus;
  onChange: (next: ActionStatus) => void;
}) {
  const display = (value || '').trim() || 'Open';
  // A status not in the preset list (carried over from legacy markdown) still
  // shows and stays selectable, so it's never silently rewritten.
  const isCustom = !ACTION_STATUS_PRESETS.includes(display as (typeof ACTION_STATUS_PRESETS)[number]);
  const items = isCustom ? [display, ...ACTION_STATUS_PRESETS] : [...ACTION_STATUS_PRESETS];
  const trigger = (
    <button
      type="button"
      aria-label={`Status: ${display}`}
      className="w-32 shrink-0 inline-flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white text-slate-700 hover:border-slate-400 transition-all duration-150"
    >
      <span className="inline-flex items-center gap-1.5 truncate">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(display)}`} />
        <span className="truncate">{display}</span>
      </span>
      <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
    </button>
  );

  return (
    <Dropdown trigger={trigger} width={170}>
      {(close) => (
        <>
          {items.map((s) => (
            <DropdownItem
              key={s}
              selected={s === display}
              onSelect={() => {
                onChange(s);
                close();
              }}
              leading={<span className={`w-1.5 h-1.5 rounded-full ${statusDot(s)}`} />}
            >
              {s}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}

function TimelineTable({
  rows,
  onUpdate,
  onAdd,
  onRemove,
}: {
  rows: TimelineRow[];
  onUpdate: (idx: number, patch: Partial<TimelineRow>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="hidden sm:flex items-center gap-2 px-1 mb-1.5 text-[11px] text-slate-400 uppercase tracking-wide">
        <div className="w-44 shrink-0">Time</div>
        <div className="flex-1 min-w-0">Event</div>
        <div className="w-7 shrink-0" />
      </div>
      <div className="space-y-2 sm:space-y-1.5">
        {rows.map((row, idx) => (
          <div key={row.id} className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-2">
            <AutoGrowField
              value={row.time}
              onChange={(v) => onUpdate(idx, { time: v })}
              placeholder="07:11, 3 Jan / 18:00 UTC"
              className="w-full sm:w-44 shrink-0 px-3 py-2 rounded-lg border border-slate-300 text-sm soft-focus focus:outline-none focus:border-blue-400"
            />
            <div className="flex items-start gap-1.5 sm:gap-2 flex-1 min-w-0">
              <AutoGrowField
                value={row.event}
                onChange={(v) => onUpdate(idx, { event: v })}
                placeholder="what happened"
                className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm soft-focus focus:outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={() => onRemove(idx)}
                aria-label="Remove row"
                className="text-slate-400 hover:text-red-500 hover:bg-red-50 rounded p-1 shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5">
        <button
          type="button"
          onClick={onAdd}
          className="text-blue-600 hover:bg-blue-50 text-xs px-2 py-1 rounded inline-flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          Add row
        </button>
      </div>
    </div>
  );
}
