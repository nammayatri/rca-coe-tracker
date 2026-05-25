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

export interface DatePickerPreset {
  label: string;
  compute: () => Date;
}

interface DatePickerProps {
  value: string | null;
  onChange: (next: string | null) => void;
  withTime?: boolean;
  placeholder?: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  className?: string;
  presets?: DatePickerPreset[];
}

interface Anchor {
  top: number;
  left: number;
  width: number;
}

// ───── Date utilities (local-only, scoped to this file) ─────

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface DayCell {
  date: Date;
  currentMonth: boolean;
}

// Build a 6×7 (= 42) grid covering the visible month with leading/trailing days.
export function buildMonthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0..6 (Sun..Sat)
  const cells: DayCell[] = [];
  // Leading days from previous month.
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, currentMonth: false });
  }
  // Days in this month.
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), currentMonth: true });
  }
  // Trailing days to fill 42 cells.
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last);
    next.setDate(last.getDate() + 1);
    cells.push({ date: next, currentMonth: false });
  }
  return cells;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toTimeInput(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function applyTime(base: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map((s) => parseInt(s, 10));
  const out = new Date(base);
  out.setHours(Number.isFinite(h) ? h : 0);
  out.setMinutes(Number.isFinite(m) ? m : 0);
  out.setSeconds(0);
  out.setMilliseconds(0);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function formatHour12(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(d.getMinutes())} ${ampm}`;
}

export function formatTriggerLabel(d: Date | null, withTime: boolean): string {
  if (!d) return '';
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  return withTime ? `${base}  ${formatHour12(d)}` : base;
}

function parseISO(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ───── Component ─────

export default function DatePicker({
  value,
  onChange,
  withTime = false,
  placeholder = 'Pick a date',
  align = 'left',
  disabled = false,
  className = '',
  presets,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const selected = useMemo(() => parseISO(value), [value]);

  // Visible month/year of the calendar.
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const base = selected ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  const [yearPickerOpen, setYearPickerOpen] = useState(false);

  // Sync view when value changes externally while closed.
  useEffect(() => {
    if (open) return;
    const base = selected ?? new Date();
    setView({ year: base.getFullYear(), month: base.getMonth() });
  }, [selected, open]);

  // Close on outside click + Esc.
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

  // Position the popover relative to the trigger, clamped into the viewport so
  // it can never overflow off-screen — flips above the trigger when there isn't
  // enough room below, and is pinned within the left/right/bottom edges.
  useLayoutEffect(() => {
    if (!open) return;
    const MARGIN = 8;
    const WIDTH = 304; // calendar width
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal: honor the requested alignment, then clamp into the viewport.
      let left = align === 'right' ? r.right - WIDTH : r.left;
      left = Math.max(MARGIN, Math.min(left, vw - WIDTH - MARGIN));

      // Vertical: prefer below; flip above when there's more room there.
      const popH = popoverRef.current?.offsetHeight ?? 360;
      const roomBelow = vh - r.bottom - MARGIN;
      const roomAbove = r.top - MARGIN;
      let top = r.bottom + 6;
      if (roomBelow < popH && roomAbove > roomBelow) {
        top = r.top - 6 - popH;
      }
      // Final clamp so it stays fully on-screen regardless.
      top = Math.max(MARGIN, Math.min(top, vh - popH - MARGIN));

      setAnchor({ top, left, width: WIDTH });
    };
    update();
    // Re-measure once the popover has actually rendered, so the flip uses its
    // real height instead of the estimate.
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, align]);

  const stepMonth = useCallback((delta: number) => {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }, []);

  const cells = useMemo(() => buildMonthGrid(view.year, view.month), [view]);

  const today = new Date();

  const commitDate = (next: Date) => {
    // Keep existing time if withTime; otherwise normalize to start of day.
    const merged = withTime
      ? selected
        ? (() => {
            const out = new Date(next);
            out.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
            return out;
          })()
        : (() => {
            const now = new Date();
            const out = new Date(next);
            out.setHours(now.getHours(), now.getMinutes(), 0, 0);
            return out;
          })()
      : startOfDay(next);
    onChange(merged.toISOString());
  };

  const setTime = (hhmm: string) => {
    const base = selected ?? new Date();
    const out = applyTime(base, hhmm);
    onChange(out.toISOString());
  };

  const setNow = () => {
    onChange(new Date().toISOString());
    const now = new Date();
    setView({ year: now.getFullYear(), month: now.getMonth() });
  };

  const setNowMinusMinutes = (mins: number) => {
    const d = new Date(Date.now() - mins * 60_000);
    onChange(d.toISOString());
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  // Keyboard navigation inside the grid.
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = document.activeElement as HTMLElement | null;
    if (!target || !target.dataset.dayIso) return;
    const cur = new Date(target.dataset.dayIso);
    let next: Date | null = null;
    if (e.key === 'ArrowLeft') next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
    else if (e.key === 'ArrowRight') next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    else if (e.key === 'ArrowUp') next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 7);
    else if (e.key === 'ArrowDown') next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
    else if (e.key === 'PageUp') {
      stepMonth(-1);
      return;
    } else if (e.key === 'PageDown') {
      stepMonth(1);
      return;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commitDate(cur);
      return;
    }
    if (!next) return;
    e.preventDefault();
    setView({ year: next.getFullYear(), month: next.getMonth() });
    // Defer focus to next paint after grid re-renders.
    const iso = next.toISOString();
    requestAnimationFrame(() => {
      const root = popoverRef.current;
      if (!root) return;
      const btn = root.querySelector<HTMLButtonElement>(`[data-day-iso="${iso}"]`);
      btn?.focus();
    });
  };

  const yearGrid = useMemo(() => {
    const center = view.year;
    const start = center - 6;
    return Array.from({ length: 12 }, (_, i) => start + i);
  }, [view.year]);

  const triggerLabel = formatTriggerLabel(selected, withTime);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        className={`group relative w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white text-sm soft-focus transition-all duration-150 ${
          disabled
            ? 'opacity-50 cursor-not-allowed border-slate-200'
            : open
            ? 'border-blue-400'
            : 'border-slate-300 hover:border-slate-400'
        } ${className}`}
      >
        <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className={`flex-1 text-left truncate tabular-nums ${selected ? 'text-slate-800' : 'text-slate-400'}`}>
          {selected ? triggerLabel : placeholder}
        </span>
        {selected && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
            aria-label="Clear date"
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100"
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
            aria-label="Choose date"
            style={{
              top: anchor.top,
              left: anchor.left,
              width: anchor.width,
              maxHeight: 'calc(100vh - 16px)',
              overflowY: 'auto',
            }}
            className="fixed z-[60] glass layered-shadow rounded-2xl ring-1 ring-slate-200/70 p-3 animate-dropdown custom-scrollbar"
          >
            {presets && presets.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3 pb-3 border-b border-slate-200/60">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      const d = p.compute();
                      onChange(d.toISOString());
                      setView({ year: d.getFullYear(), month: d.getMonth() });
                    }}
                    className="text-[11.5px] text-slate-600 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 px-2 py-1 rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                className="p-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-all duration-150 active:scale-[0.97]"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setYearPickerOpen((v) => !v)}
                className="text-[13px] font-semibold text-slate-800 tracking-tight px-2 py-1 rounded-md hover:bg-slate-100 transition-all duration-150"
                aria-label="Pick year"
              >
                {MONTHS_LONG[view.month]} {view.year}
              </button>
              <button
                type="button"
                onClick={() => stepMonth(1)}
                className="p-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-all duration-150 active:scale-[0.97]"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {yearPickerOpen ? (
              <div className="grid grid-cols-4 gap-1.5 px-1 py-2">
                {yearGrid.map((y) => {
                  const isCurrent = y === view.year;
                  return (
                    <button
                      key={y}
                      type="button"
                      onClick={() => {
                        setView((v) => ({ ...v, year: y }));
                        setYearPickerOpen(false);
                      }}
                      className={`text-[12.5px] py-1.5 rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums ${
                        isCurrent
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                {/* DOW row */}
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {DOW.map((d, i) => (
                    <div
                      key={i}
                      className="text-[10.5px] uppercase tracking-wide text-slate-400 text-center font-medium"
                    >
                      {d}
                    </div>
                  ))}
                </div>

                {/* Day grid */}
                <div
                  className="grid grid-cols-7 gap-1"
                  onKeyDown={onGridKeyDown}
                >
                  {cells.map((c, idx) => {
                    const isToday = isSameDay(c.date, today);
                    const isSelected = selected ? isSameDay(c.date, selected) : false;
                    const aria = `${MONTHS_LONG[c.date.getMonth()]} ${c.date.getDate()}, ${c.date.getFullYear()}`;
                    return (
                      <button
                        key={idx}
                        type="button"
                        data-day-iso={c.date.toISOString()}
                        onClick={() => commitDate(c.date)}
                        aria-pressed={isSelected}
                        aria-label={aria}
                        tabIndex={isSelected || (!selected && isToday) ? 0 : -1}
                        className={`relative h-8 w-full text-[12.5px] rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                          isSelected
                            ? 'bg-blue-600 text-white shadow-sm font-semibold'
                            : !c.currentMonth
                            ? 'text-slate-300 hover:bg-slate-50'
                            : 'text-slate-700 hover:bg-slate-100'
                        } ${isToday && !isSelected ? 'ring-1 ring-blue-300' : ''}`}
                      >
                        {c.date.getDate()}
                      </button>
                    );
                  })}
                </div>

                {/* Time row */}
                {withTime && (
                  <div className="mt-3 pt-3 border-t border-slate-200/60 flex items-center gap-2">
                    <input
                      type="time"
                      value={selected ? toTimeInput(selected) : ''}
                      onChange={(e) => setTime(e.target.value)}
                      className="px-2 py-1 rounded-md border border-slate-300 text-[12.5px] tabular-nums soft-focus focus:outline-none focus:border-blue-400"
                    />
                    <div className="flex gap-1 ml-auto">
                      <button
                        type="button"
                        onClick={setNow}
                        className="text-[11px] text-slate-600 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 px-1.5 py-1 rounded-md transition-all duration-150 active:scale-[0.97]"
                      >
                        Now
                      </button>
                      <button
                        type="button"
                        onClick={() => setNowMinusMinutes(15)}
                        className="text-[11px] text-slate-600 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 px-1.5 py-1 rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums"
                      >
                        −15m
                      </button>
                      <button
                        type="button"
                        onClick={() => setNowMinusMinutes(60)}
                        className="text-[11px] text-slate-600 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 px-1.5 py-1 rounded-md transition-all duration-150 active:scale-[0.97] tabular-nums"
                      >
                        −1h
                      </button>
                    </div>
                  </div>
                )}

                {/* Footer */}
                <div className="mt-3 pt-3 border-t border-slate-200/60 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      const t = new Date();
                      setView({ year: t.getFullYear(), month: t.getMonth() });
                      commitDate(t);
                    }}
                    className="text-[12px] text-slate-700 hover:text-blue-700 hover:bg-blue-50 px-2 py-1 rounded-md transition-all duration-150 active:scale-[0.97] font-medium"
                  >
                    Today
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onChange(null)}
                      className="text-[12px] text-slate-500 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded-md transition-all duration-150 active:scale-[0.97]"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="text-[12px] bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md transition-all duration-150 active:scale-[0.97] font-medium shadow-sm shadow-blue-500/20"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
