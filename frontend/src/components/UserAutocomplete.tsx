import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { fetchUsers } from '../api/client';
import type { User } from '../api/types';
import Avatar from './Avatar';

interface UserAutocompleteProps {
  value: User[];
  onChange: (users: User[]) => void;
  placeholder?: string;
  max?: number;
  /** Single-pick mode: hide the input entirely once one user is picked. */
  single?: boolean;
}

const DEFAULT_MAX = 10;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function UserAutocomplete({
  value,
  onChange,
  placeholder = 'Add people…',
  max = DEFAULT_MAX,
  single = false,
}: UserAutocompleteProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const atMax = value.length >= max;
  // In single-pick mode, the input is hidden entirely once a user is picked.
  const hideInput = single && atMax;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const debouncedQ = useDebounced(q, 200);

  const { data, isFetching } = useQuery<User[]>({
    queryKey: ['users-search', debouncedQ],
    queryFn: () => fetchUsers(debouncedQ),
    enabled: open,
    staleTime: 30_000,
  });

  const selectedEmails = useMemo(() => new Set(value.map((u) => u.email)), [value]);
  const options = useMemo(
    () => (data ?? []).filter((u) => !selectedEmails.has(u.email)),
    [data, selectedEmails],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Menu uses position: fixed — viewport coords only, no scroll offsets.
      setAnchor({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Capture phase so we see the event before Modal's stopPropagation on
    // content mousedown — otherwise clicks inside the modal don't reach us.
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [debouncedQ, options.length]);

  const addUser = (u: User) => {
    if (selectedEmails.has(u.email)) return;
    if (value.length >= max) return;
    onChange([...value, u]);
    setQ('');
    setHighlight(0);
    // Close after pick so the dropdown doesn't block the rest of the form.
    // The user can click the input again to re-open.
    setOpen(false);
    inputRef.current?.blur();
  };

  const removeUser = (email: string) => {
    onChange(value.filter((u) => u.email !== email));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && q === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = options[highlight];
      if (pick) addUser(pick);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="w-full">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((u) => {
            const displayName = u.name || u.email.split('@')[0] || u.email;
            return (
              <span
                key={u.email}
                className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 bg-slate-100 rounded-full text-xs font-medium text-slate-700"
              >
                <Avatar name={displayName} size="xs" />
                <span className="ml-0.5">{displayName}</span>
                <button
                  type="button"
                  onClick={() => removeUser(u.email)}
                  className="ml-0.5 p-0.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
                  aria-label={`Remove ${displayName}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {!hideInput && (
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={q}
            placeholder={atMax ? `Maximum ${max} reached — remove someone to add another` : placeholder}
            disabled={atMax}
            onFocus={() => !atMax && setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            className={`soft-focus w-full px-3 py-2 rounded-lg border text-sm focus:outline-none ${
              atMax
                ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                : 'border-slate-300 focus:border-blue-400'
            }`}
          />
          {isFetching && open && !atMax && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
          )}
        </div>
      )}
      {!single && value.length > 0 && (
        <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
          {value.length} of {max} assignees{atMax ? ' · maximum reached' : ''}
        </p>
      )}

      {open && anchor &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
            className="fixed z-50 bg-white rounded-xl ring-1 ring-slate-200/70 shadow-[0_12px_40px_-8px_rgba(15,23,42,0.18)] overflow-hidden animate-dropdown"
          >
            <div className="max-h-64 overflow-y-auto py-1 custom-scrollbar">
              {options.length === 0 ? (
                <div className="px-3 py-4 text-center text-[13px] text-slate-400">
                  {debouncedQ ? 'No matches' : 'Start typing to search…'}
                </div>
              ) : (
                options.map((u, i) => {
                  const displayName = u.name || u.email.split('@')[0] || u.email;
                  return (
                    <button
                      key={u.email}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addUser(u);
                      }}
                      onMouseEnter={() => setHighlight(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                        i === highlight ? 'bg-blue-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <Avatar name={displayName} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{displayName}</p>
                        <p className="text-[12px] text-slate-400 truncate">{u.email}</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
