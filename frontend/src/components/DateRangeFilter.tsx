import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { buildMonthGrid, isSameDay } from './DatePicker';

interface DateRangeFilterProps {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}

interface Anchor {
  top: number;
  left: number;
  width: number;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function parseISO(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmt(d: Date): string {
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

interface PresetDef {
  id: string;
  label: string;
  compute: () => { from: Date; to: Date };
}

const PRESETS: PresetDef[] = [
  {
    id: 'today',
    label: 'Today',
    compute: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }),
  },
  {
    id: 'yesterday',
    label: 'Yesterday',
    compute: () => {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    },
  },
  {
    id: 'last7',
    label: 'Last 7 days',
    compute: () => {
      const end = endOfDay(new Date());
      const start = new Date();
      start.setDate(start.getDate() - 6);
      return { from: startOfDay(start), to: end };
    },
  },
  {
    id: 'last30',
    label: 'Last 30 days',
    compute: () => {
      const end = endOfDay(new Date());
      const start = new Date();
      start.setDate(start.getDate() - 29);
      return { from: startOfDay(start), to: end };
    },
  },
  {
    id: 'last90',
    label: 'Last 90 days',
    compute: () => {
      const end = endOfDay(new Date());
      const start = new Date();
      start.setDate(start.getDate() - 89);
      return { from: startOfDay(start), to: end };
    },
  },
  {
    id: 'thisMonth',
    label: 'This month',
    compute: () => ({ from: startOfMonth(new Date()), to: endOfDay(new Date()) }),
  },
  {
    id: 'lastMonth',
    label: 'Last month',
    compute: () => {
      const ref = new Date();
      const lastMonth = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
      return { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) };
    },
  },
];

// Match an existing range to a preset id for the trigger label.
function matchPreset(from: Date, to: Date): string | null {
  for (const p of PRESETS) {
    const { from: pf, to: pt } = p.compute();
    // Match by day-level boundaries since presets are full-day.
    if (
      isSameDay(pf, from) &&
      isSameDay(pt, to) &&
      from.getHours() === 0 &&
      from.getMinutes() === 0
    ) {
      return p.label;
    }
  }
  return null;
}

export default function DateRangeFilter({ from, to, onChange }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const fromDate = useMemo(() => parseISO(from), [from]);
  const toDate = useMemo(() => parseISO(to), [to]);

  // Local draft while popover is open.
  const [draftFrom, setDraftFrom] = useState<Date | null>(fromDate);
  const [draftTo, setDraftTo] = useState<Date | null>(toDate);

  // Two visible months side by side.
  const [leftView, setLeftView] = useState<{ year: number; month: number }>(() => {
    const base = fromDate ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  useEffect(() => {
    if (!open) return;
    setDraftFrom(fromDate);
    setDraftTo(toDate);
    const base = fromDate ?? new Date();
    setLeftView({ year: base.getFullYear(), month: base.getMonth() });
  }, [open, fromDate, toDate]);

  const rightView = useMemo(() => {
    const d = new Date(leftView.year, leftView.month + 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [leftView]);

  // Click outside + Esc.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Position popover.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const measuredWidth = 560;
      // Popover is position: fixed (viewport-relative). Right-align under
      // the trigger; clamp to viewport edge.
      let left = r.right - measuredWidth;
      if (left < 8) left = 8;
      setAnchor({
        top: r.bottom + 6,
        left,
        width: measuredWidth,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const stepMonth = useCallback((delta: number) => {
    setLeftView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }, []);

  const handlePickDay = (date: Date) => {
    if (!draftFrom || (draftFrom && draftTo)) {
      // Start a fresh range.
      setDraftFrom(startOfDay(date));
      setDraftTo(null);
      return;
    }
    if (date.getTime() < startOfDay(draftFrom).getTime()) {
      // Picked an earlier date — make it the new from.
      setDraftFrom(startOfDay(date));
      setDraftTo(null);
      return;
    }
    setDraftTo(endOfDay(date));
  };

  const apply = () => {
    const fromIso = draftFrom ? draftFrom.toISOString() : null;
    const toIso = draftTo ? draftTo.toISOString() : null;
    onChange(fromIso, toIso);
    setOpen(false);
  };

  const clearRange = () => {
    setDraftFrom(null);
    setDraftTo(null);
    onChange(null, null);
    setOpen(false);
  };

  const usePreset = (p: PresetDef) => {
    const { from: pf, to: pt } = p.compute();
    setDraftFrom(pf);
    setDraftTo(pt);
    onChange(pf.toISOString(), pt.toISOString());
    setOpen(false);
  };

  // Trigger label.
  const triggerLabel = useMemo(() => {
    if (!fromDate && !toDate) return 'All dates';
    if (fromDate && toDate) {
      const matched = matchPreset(fromDate, toDate);
      if (matched) return matched;
      return `${fmt(fromDate)} – ${fmt(toDate)}`;
    }
    if (fromDate) return `From ${fmt(fromDate)}`;
    if (toDate) return `Until ${fmt(toDate)}`;
    return 'All dates';
  }, [fromDate, toDate]);

  const isActive = !!(fromDate || toDate);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        className={`group inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-sm transition-all duration-150 active:scale-[0.97] min-w-[180px] ${
          isActive
            ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
        } ${open ? 'ring-2 ring-blue-200/60' : ''}`}
      >
        <span className="inline-flex items-center gap-1.5 truncate">
          <Calendar className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{triggerLabel}</span>
        </span>
        {isActive && (
          <span
            role="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null, null);
            }}
            aria-label="Clear date range"
            className="p-0.5 rounded-full text-blue-500 hover:text-blue-700 hover:bg-blue-100/60 transition-colors"
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>

      {open && anchor &&
        createPortal(
          <div
            ref={popoverRef}
            id={dialogId}
            role="dialog"
            aria-label="Choose date range"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
            className="fixed z-[60] glass layered-shadow rounded-2xl ring-1 ring-slate-200/70 animate-dropdown overflow-hidden"
          >
            <div className="flex">
              {/* Presets pane */}
              <div className="w-[148px] shrink-0 border-r border-slate-200/60 p-2 bg-slate-50/40">
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-[0.08em] text-slate-400 font-semibold">
                  Quick range
                </div>
                <div className="space-y-0.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => usePreset(p)}
                      className="w-full text-left text-[12.5px] text-slate-700 hover:bg-blue-50 hover:text-blue-700 px-2 py-1.5 rounded-md transition-all duration-150"
                    >
                      {p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={clearRange}
                    className="w-full text-left text-[12.5px] text-slate-500 hover:bg-slate-100 px-2 py-1.5 rounded-md transition-all duration-150 mt-1 border-t border-slate-200/60 pt-2"
                  >
                    All time
                  </button>
                </div>
              </div>

              {/* Calendars pane */}
              <div className="flex-1 p-3">
                <div className="grid grid-cols-2 gap-3">
                  <MonthPane
                    year={leftView.year}
                    month={leftView.month}
                    onPrev={() => stepMonth(-1)}
                    onNext={null}
                    draftFrom={draftFrom}
                    draftTo={draftTo}
                    onPick={handlePickDay}
                  />
                  <MonthPane
                    year={rightView.year}
                    month={rightView.month}
                    onPrev={null}
                    onNext={() => stepMonth(1)}
                    draftFrom={draftFrom}
                    draftTo={draftTo}
                    onPick={handlePickDay}
                  />
                </div>

                {/* Footer */}
                <div className="mt-3 pt-3 border-t border-slate-200/60 flex items-center justify-between">
                  <div className="text-[12px] text-slate-500 tabular-nums">
                    {draftFrom ? (
                      <span>
                        <span className="text-slate-700 font-medium">
                          {fmt(draftFrom)}
                        </span>
                        <span className="mx-1.5 text-slate-300">–</span>
                        <span className={draftTo ? 'text-slate-700 font-medium' : 'text-slate-400 italic'}>
                          {draftTo ? fmt(draftTo) : 'pick end…'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-400">Pick a start date</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setDraftFrom(null);
                        setDraftTo(null);
                      }}
                      className="text-[12px] text-slate-600 hover:text-slate-900 hover:bg-slate-100 px-2.5 py-1 rounded-md transition-all duration-150 active:scale-[0.97]"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={apply}
                      disabled={!draftFrom && !draftTo && !fromDate && !toDate}
                      className="text-[12px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1 rounded-md transition-all duration-150 active:scale-[0.97] font-medium shadow-sm shadow-blue-500/20"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function MonthPane({
  year,
  month,
  onPrev,
  onNext,
  draftFrom,
  draftTo,
  onPick,
}: {
  year: number;
  month: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  draftFrom: Date | null;
  draftTo: Date | null;
  onPick: (d: Date) => void;
}) {
  const cells = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const today = new Date();

  const inRange = (d: Date) => {
    if (!draftFrom || !draftTo) return false;
    const t = startOfDay(d).getTime();
    return t >= startOfDay(draftFrom).getTime() && t <= startOfDay(draftTo).getTime();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          type="button"
          onClick={() => onPrev?.()}
          disabled={!onPrev}
          className="p-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-all duration-150 active:scale-[0.97] disabled:opacity-0 disabled:pointer-events-none"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-[12.5px] font-semibold text-slate-800 tracking-tight">
          {MONTHS_LONG[month]} {year}
        </div>
        <button
          type="button"
          onClick={() => onNext?.()}
          disabled={!onNext}
          className="p-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-all duration-150 active:scale-[0.97] disabled:opacity-0 disabled:pointer-events-none"
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {DOW.map((d, i) => (
          <div
            key={i}
            className="text-[10px] uppercase tracking-wide text-slate-400 text-center font-medium"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((c, idx) => {
          const isToday = isSameDay(c.date, today);
          const isFrom = draftFrom ? isSameDay(c.date, draftFrom) : false;
          const isTo = draftTo ? isSameDay(c.date, draftTo) : false;
          const isEdge = isFrom || isTo;
          const middle = !isEdge && inRange(c.date);
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onPick(c.date)}
              aria-label={`${MONTHS_LONG[c.date.getMonth()]} ${c.date.getDate()}, ${c.date.getFullYear()}`}
              className={`relative h-7 w-full text-[11.5px] rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                isEdge
                  ? 'bg-blue-600 text-white shadow-sm font-semibold'
                  : middle
                  ? 'bg-blue-50 text-blue-700'
                  : !c.currentMonth
                  ? 'text-slate-300 hover:bg-slate-50'
                  : 'text-slate-700 hover:bg-slate-100'
              } ${isToday && !isEdge ? 'ring-1 ring-blue-300' : ''}`}
            >
              {c.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
