import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronDown,
  Clock,
  Inbox,
  LayoutGrid,
  Plus,
  Rows3,
  Search,
  X,
} from 'lucide-react';
import { fetchRCAs } from '../api/client';
import type { RCA, RCASeverity, RCAStatus } from '../api/types';
import RCACard from '../components/RCACard';
import RCAFormModal from '../components/RCAFormModal';
import Dropdown, { DropdownItem } from '../components/Dropdown';
import DateRangeFilter from '../components/DateRangeFilter';
import StatusBadge from '../components/StatusBadge';
import SeverityIcon from '../components/SeverityIcon';
import { AvatarStack } from '../components/Avatar';
import TrendsBar from '../components/TrendsBar';
import FollowUpsTable from '../components/FollowUpsTable';
import { isStaleRCA, statusLabels, timeAgo } from '../utils/format';

type Filter = 'all' | 'mine' | 'followups' | RCAStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'open', label: statusLabels.open },
  { id: 'in_progress', label: statusLabels.in_progress },
  { id: 'rca_done', label: statusLabels.rca_done },
  { id: 'closed', label: statusLabels.closed },
  { id: 'followups', label: 'Follow-ups' },
];

const TRENDS_KEY = 'rca-list-show-trends';

const SEVERITY_OPTIONS: { id: '' | RCASeverity; label: string }[] = [
  { id: '', label: 'All severities' },
  { id: 'sev1', label: 'SEV1' },
  { id: 'sev2', label: 'SEV2' },
  { id: 'sev3', label: 'SEV3' },
];

const SEV_DOT: Record<RCASeverity, string> = {
  sev1: 'bg-red-500',
  sev2: 'bg-orange-500',
  sev3: 'bg-yellow-500',
};

const VIEW_KEY = 'rca-list-view';
type ViewMode = 'list' | 'grid';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/60 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center gap-1.5 mb-3">
        <div className="skeleton h-4 w-12 rounded-full" />
        <div className="skeleton h-4 w-14 rounded-full" />
      </div>
      <div className="flex items-center justify-between mt-5">
        <div className="flex items-center gap-2">
          <div className="skeleton h-7 w-7 rounded-full" />
          <div className="skeleton h-3 w-20" />
        </div>
        <div className="skeleton h-3 w-16" />
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="grid grid-cols-[auto_1fr_140px_120px_120px_120px] items-center gap-4 px-4 py-3 border-b border-slate-100">
      <div className="skeleton h-5 w-12 rounded-full" />
      <div className="skeleton h-4 w-3/4" />
      <div className="skeleton h-5 w-20 rounded-full" />
      <div className="skeleton h-4 w-12" />
      <div className="skeleton h-6 w-16" />
      <div className="skeleton h-3 w-14" />
    </div>
  );
}

function RCARow({ rca, idx }: { rca: RCA; idx: number }) {
  const navigate = useNavigate();
  const open = () => navigate(`/rcas/${rca.id}`);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={rca.title}
      onClick={open}
      onKeyDown={onKeyDown}
      style={{ animationDelay: `${Math.min(idx, 12) * 24}ms` }}
      className="group grid grid-cols-[auto_1fr_140px_120px_120px_120px] items-center gap-4 px-4 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50/80 cursor-pointer transition-colors animate-stagger-in focus:outline-none focus:bg-blue-50/40"
    >
      {/* Severity */}
      <div className="shrink-0 w-14">
        {rca.severity ? (
          <SeverityIcon severity={rca.severity} size={14} withLabel />
        ) : (
          <span className="text-[11px] text-slate-300 italic">—</span>
        )}
      </div>

      {/* Title */}
      <div className="min-w-0">
        <p
          className="text-[13.5px] font-medium text-slate-900 truncate group-hover:text-blue-700 transition-colors"
          title={rca.title}
        >
          {rca.title}
        </p>
        <p className="text-[11.5px] text-slate-400 truncate">
          by {rca.creator_name || rca.creator_email.split('@')[0]}
          {rca.services_affected.length > 0 ? ` · ${rca.services_affected.slice(0, 2).join(', ')}` : ''}
        </p>
      </div>

      {/* Status */}
      <div className="shrink-0">
        <StatusBadge status={rca.status} />
      </div>

      {/* Env */}
      <div className="shrink-0 text-[11.5px] text-slate-500 truncate" title={rca.environment ?? undefined}>
        {rca.environment || <span className="text-slate-300 italic">—</span>}
      </div>

      {/* Assignees */}
      <div className="shrink-0">
        {rca.assignees.length > 0 ? (
          <AvatarStack names={rca.assignees.map((a) => a.name || a.email)} max={3} size="xs" />
        ) : (
          <span className="text-[11.5px] text-slate-300 italic">unassigned</span>
        )}
      </div>

      {/* Created */}
      <div className="shrink-0 text-right text-[11.5px] text-slate-400 tabular-nums inline-flex items-center justify-end gap-1.5">
        {(() => {
          const s = isStaleRCA(rca);
          return s.stale ? (
            <span
              className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 ring-1 ring-amber-200 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
              title={`Stale: ${s.days} days in ${rca.status === 'open' ? 'Open' : 'In Progress'}`}
            >
              {s.days}d
            </span>
          ) : null;
        })()}
        <Clock className="w-3 h-3" />
        {timeAgo(rca.created_at)}
      </div>
    </div>
  );
}

export default function RCAListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = (searchParams.get('status') as RCAStatus) || '';
  const mineParam = searchParams.get('mine') === '1';
  const followupsParam = searchParams.get('followups') === '1';
  const qParam = searchParams.get('q') || '';
  const severityParamRaw = (searchParams.get('severity') || '').toLowerCase();
  const severityParam: RCASeverity | '' =
    severityParamRaw === 'sev1' || severityParamRaw === 'sev2' || severityParamRaw === 'sev3'
      ? severityParamRaw
      : '';
  const fromParam = searchParams.get('from') || '';
  const toParam = searchParams.get('to') || '';

  const activeFilter: Filter = followupsParam
    ? 'followups'
    : mineParam
    ? 'mine'
    : statusParam
    ? (statusParam as Filter)
    : 'all';

  const [showTrends, setShowTrends] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(TRENDS_KEY) !== '0';
  });

  const dismissTrends = () => {
    setShowTrends(false);
    if (typeof window !== 'undefined') window.localStorage.setItem(TRENDS_KEY, '0');
  };

  const [search, setSearch] = useState(qParam);
  const debouncedSearch = useDebounced(search, 250);
  const [showCreate, setShowCreate] = useState(false);

  // How many rows to fetch. "Load more" grows this (capped at the API's max);
  // it resets to the default whenever the filters change.
  const PAGE_STEP = 50;
  const MAX_PAGE_SIZE = 200;
  const [limit, setLimit] = useState(PAGE_STEP);
  useEffect(() => {
    setLimit(PAGE_STEP);
  }, [statusParam, mineParam, debouncedSearch, severityParam, fromParam, toParam, followupsParam]);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'list';
    return (window.localStorage.getItem(VIEW_KEY) as ViewMode) || 'list';
  });

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // Sync URL `q` from local debounced state.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (debouncedSearch) next.set('q', debouncedSearch);
    else next.delete('q');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Keep input synced if URL changes externally (e.g. sidebar nav reset).
  useEffect(() => {
    setSearch(qParam);
  }, [qParam]);

  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    next.delete('mine');
    next.delete('followups');
    if (f === 'mine') next.set('mine', '1');
    else if (f === 'followups') next.set('followups', '1');
    else if (f !== 'all') next.set('status', f);
    setSearchParams(next);
  };

  const setSeverity = (v: '' | RCASeverity) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('severity', v);
    else next.delete('severity');
    setSearchParams(next);
  };

  const setRange = (fromIso: string | null, toIso: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (fromIso) next.set('from', fromIso);
    else next.delete('from');
    if (toIso) next.set('to', toIso);
    else next.delete('to');
    setSearchParams(next);
  };

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['rcas', statusParam, mineParam, debouncedSearch, severityParam, fromParam, toParam, limit],
    queryFn: () =>
      fetchRCAs({
        status: statusParam || undefined,
        mine: mineParam || undefined,
        q: debouncedSearch || undefined,
        severity: severityParam || undefined,
        from: fromParam || undefined,
        to: toParam || undefined,
        page_size: limit,
      }),
    enabled: !followupsParam,
    placeholderData: (prev) => prev, // keep current rows visible while "Load more" fetches
  });

  // Follow-ups tab loads everything page-size-large so we can flatten action
  // items. It honors the same severity/date/search filters (they persist across
  // tab switches) so switching here doesn't silently drop them.
  const { data: followupsData, isLoading: followupsLoading } = useQuery({
    queryKey: ['rcas-followups', debouncedSearch, severityParam, fromParam, toParam],
    queryFn: () =>
      fetchRCAs({
        page_size: 200,
        q: debouncedSearch || undefined,
        severity: severityParam || undefined,
        from: fromParam || undefined,
        to: toParam || undefined,
      }),
    enabled: followupsParam,
  });

  const items = data?.items ?? [];
  const hasFilters = useMemo(
    () => activeFilter !== 'all' || !!debouncedSearch || !!severityParam || !!fromParam || !!toParam,
    [activeFilter, debouncedSearch, severityParam, fromParam, toParam],
  );
  const totalLabel = followupsParam
    ? followupsData
      ? `${followupsData.items.length} ${followupsData.items.length === 1 ? 'RCA' : 'RCAs'} scanned`
      : ''
    : data
    ? `${data.total} ${data.total === 1 ? 'RCA' : 'RCAs'}`
    : '';

  const clear = () => {
    setSearch('');
    setSearchParams({});
  };

  const severityLabel = SEVERITY_OPTIONS.find((o) => o.id === severityParam)?.label ?? 'All severities';

  return (
    <div className="px-5 md:px-8 py-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">RCAs</h1>
          <p className="text-[13px] text-slate-500 mt-1">
            Post-incident reviews — root cause analyses and centers of excellence.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.97] inline-flex items-center gap-1.5 shrink-0 shadow-sm shadow-blue-500/20"
        >
          <Plus className="w-4 h-4" />
          New RCA
        </button>
      </div>

      {/* Filter chips + search + view toggle */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f, i) => {
            const isActive = activeFilter === f.id;
            // Visual divider before "Follow-ups" since it switches view, not filter.
            const isFollowUps = f.id === 'followups';
            const prevIsRegular = i > 0 && FILTERS[i - 1].id !== 'followups';
            return (
              <span key={f.id} className="inline-flex items-center gap-1.5">
                {isFollowUps && prevIsRegular && (
                  <span aria-hidden className="hidden sm:inline-block h-4 w-px bg-slate-200 mx-1" />
                )}
                <button
                  onClick={() => setFilter(f.id)}
                  className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-all duration-150 active:scale-[0.97] ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                  }`}
                >
                  {f.label}
                </button>
              </span>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-full sm:w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search RCAs…"
              className="soft-focus w-full pl-9 pr-20 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400 bg-white"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="p-0.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <kbd
                  className="hidden sm:inline-flex items-center bg-white border border-slate-200 rounded text-[11px] px-1 py-0.5 font-medium text-slate-500"
                  title="Open command palette"
                >
                  {isMac ? '⌘K' : 'Ctrl K'}
                </kbd>
              )}
            </div>
          </div>

          {/* View toggle — only meaningful for the RCA list, hide on Follow-ups. */}
          <div
            className={`${followupsParam ? 'hidden' : 'hidden sm:inline-flex'} items-center bg-slate-100 rounded-lg p-0.5`}
            role="group"
            aria-label="View mode"
          >
            <button
              type="button"
              onClick={() => setView('list')}
              aria-pressed={view === 'list'}
              title="List view"
              className={`p-1.5 rounded-md transition-all duration-150 ${
                view === 'list'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Rows3 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setView('grid')}
              aria-pressed={view === 'grid'}
              title="Grid view"
              className={`p-1.5 rounded-md transition-all duration-150 ${
                view === 'grid'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Trends summary */}
      {showTrends && (data?.items || followupsData?.items) && (
        <TrendsBar
          rcas={(followupsData?.items ?? data?.items) || []}
          onDismiss={dismissTrends}
        />
      )}

      {/* Sub-filters */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {!followupsParam && (
          <>
            <Dropdown
              width={200}
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-slate-200 text-sm bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all duration-150 min-w-[180px]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {severityParam && (
                      <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT[severityParam as RCASeverity]}`} />
                    )}
                    {severityLabel}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                </button>
              }
            >
              {(close) => (
                <>
                  {SEVERITY_OPTIONS.map((o) => (
                    <DropdownItem
                      key={o.id || 'all'}
                      selected={severityParam === o.id}
                      leading={o.id ? <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT[o.id]}`} /> : null}
                      onSelect={() => {
                        setSeverity(o.id);
                        close();
                      }}
                    >
                      {o.label}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>

            {severityParam && (
              <button
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('severity');
                  setSearchParams(next);
                }}
                className="text-[12px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1 transition-colors"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}

            <DateRangeFilter
              from={fromParam || null}
              to={toParam || null}
              onChange={setRange}
            />
          </>
        )}

        {!showTrends && (
          <button
            type="button"
            onClick={() => {
              setShowTrends(true);
              if (typeof window !== 'undefined') window.localStorage.removeItem(TRENDS_KEY);
            }}
            className="text-[12px] text-slate-500 hover:text-slate-700 transition-colors"
          >
            Show trends
          </button>
        )}

        <span className="ml-auto text-[12px] text-slate-400 tabular-nums">
          {totalLabel}
        </span>
      </div>

      {/* Body */}
      {followupsParam ? (
        followupsLoading ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200/60 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <RowSkeleton key={i} />
            ))}
          </div>
        ) : (
          <FollowUpsTable rcas={followupsData?.items ?? []} />
        )
      ) : isLoading ? (
        view === 'list' ? (
          <div className="bg-white rounded-2xl border border-slate-200/60 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <RowSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )
      ) : error ? (
        <div className="bg-white rounded-2xl border border-slate-200/60 p-12 text-center animate-fade-up">
          <AlertCircle className="w-10 h-10 text-red-300 mx-auto mb-3" />
          <p className="text-sm text-red-600 font-medium mb-1">Failed to load RCAs</p>
          <button
            onClick={() => refetch()}
            className="mt-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200/60 p-14 text-center animate-fade-up">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 ring-1 ring-slate-200/60 flex items-center justify-center">
            <Inbox className="w-7 h-7 text-slate-400" />
          </div>
          <h3 className="text-base font-semibold text-slate-800">
            {hasFilters ? 'No RCAs match your filters' : 'No RCAs yet'}
          </h3>
          <p className="text-[13px] text-slate-500 mt-1.5 max-w-sm mx-auto">
            {hasFilters
              ? 'Try removing filters or broadening your search.'
              : 'Create the first one to start tracking post-incident reviews.'}
          </p>
          {hasFilters ? (
            <button
              onClick={clear}
              className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all duration-150 active:scale-[0.97]"
            >
              <X className="w-3.5 h-3.5" />
              Clear filters
            </button>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-5 inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.97] shadow-sm shadow-blue-500/20"
            >
              <Plus className="w-4 h-4" />
              Create your first RCA
            </button>
          )}
        </div>
      ) : view === 'list' ? (
        <div className="bg-white rounded-2xl border border-slate-200/60 overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_140px_120px_120px_120px] gap-4 px-4 py-2 bg-slate-50/60 border-b border-slate-200/60 text-[10.5px] uppercase tracking-[0.08em] text-slate-400 font-semibold">
            <div className="w-14">Sev</div>
            <div>Title</div>
            <div>Status</div>
            <div>Env</div>
            <div>Assignees</div>
            <div className="text-right">Created</div>
          </div>
          {items.map((rca, idx) => (
            <RCARow key={rca.id} rca={rca} idx={idx} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((rca, idx) => (
            <div
              key={rca.id}
              className="animate-stagger-in"
              style={{ animationDelay: `${Math.min(idx, 12) * 28}ms` }}
            >
              <RCACard rca={rca} />
            </div>
          ))}
        </div>
      )}

      {/* Pagination — without this the list silently stops at the page size. */}
      {!followupsParam && !isLoading && !error && data && items.length < data.total && (
        <div className="mt-5 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setLimit((l) => Math.min(l + PAGE_STEP, MAX_PAGE_SIZE))}
            disabled={isFetching || limit >= MAX_PAGE_SIZE}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetching ? (
              <span className="inline-block w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
            ) : null}
            {limit >= MAX_PAGE_SIZE ? `Showing first ${MAX_PAGE_SIZE}` : 'Load more'}
          </button>
          <span className="text-[12px] text-slate-400 tabular-nums">
            Showing {items.length} of {data.total}
            {limit >= MAX_PAGE_SIZE && data.total > MAX_PAGE_SIZE ? ' — refine filters to narrow the rest' : ''}
          </span>
        </div>
      )}

      <RCAFormModal mode="create" open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
