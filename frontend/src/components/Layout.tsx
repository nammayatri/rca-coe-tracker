import { useEffect, useMemo, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  ClipboardCheck,
  FileSearch,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Shield,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import Avatar from './Avatar';
import Dropdown, { DropdownItem } from './Dropdown';
import { openCommandSearch } from './CommandSearch';
import { fetchRCA, fetchRCAs } from '../api/client';
import { timeAgo } from '../utils/format';

const COLLAPSE_KEY = 'rca-sidebar-collapsed';

function isMacPlatform() {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
}

function NavItem({
  to,
  end,
  icon,
  label,
  collapsed,
  onNavigate,
  active: forcedActive,
}: {
  to: string;
  end?: boolean;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onNavigate?: () => void;
  active?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) => {
        const active = forcedActive ?? isActive;
        return `group relative flex items-center gap-2.5 ${
          collapsed ? 'justify-center px-2' : 'px-3'
        } py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
          active
            ? 'bg-blue-50 text-blue-700'
            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
        }`;
      }}
    >
      {({ isActive }) => {
        const active = forcedActive ?? isActive;
        return (
          <>
            <span
              className={`absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-600 rounded-r-full transition-opacity duration-150 ${
                active ? 'opacity-100' : 'opacity-0'
              }`}
              aria-hidden
            />
            <span
              className={`shrink-0 inline-flex items-center justify-center w-5 h-5 ${
                active ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600'
              }`}
            >
              {icon}
            </span>
            {!collapsed && <span className="flex-1 truncate">{label}</span>}
            {collapsed && (
              <span
                className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md text-[11px] font-medium text-white bg-slate-900/90 shadow-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10"
                role="tooltip"
              >
                {label}
              </span>
            )}
          </>
        );
      }}
    </NavLink>
  );
}

function GroupHeader({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="my-2 mx-3 h-px bg-slate-200/70" aria-hidden />;
  return (
    <p className="text-[10px] uppercase tracking-[0.08em] text-slate-400 font-semibold px-3 mb-1 mt-3">
      {children}
    </p>
  );
}

function RecentRCAs({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['sidebar-recent'],
    queryFn: () => fetchRCAs({ page_size: 4 }),
    staleTime: 60_000,
  });

  if (collapsed) return null;
  if (isLoading) {
    return (
      <div className="px-3 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-6 w-full" />
        ))}
      </div>
    );
  }
  const items = data?.items?.slice(0, 4) ?? [];
  if (items.length === 0) {
    return <p className="text-[12px] text-slate-400 px-3 italic">No recent RCAs</p>;
  }
  return (
    <ul className="space-y-0.5 px-1.5">
      {items.map((rca) => (
        <li key={rca.id}>
          <Link
            to={`/rcas/${rca.id}`}
            onClick={onNavigate}
            className="block px-2 py-1.5 rounded-lg text-[12.5px] text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 truncate transition-colors"
            title={rca.title}
          >
            {rca.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SidebarContent({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { isAdmin } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const onListPage = location.pathname === '/';
  const mineActive = onListPage && searchParams.get('mine') === '1';
  const followupsActive = onListPage && searchParams.get('followups') === '1';
  const allActive =
    onListPage &&
    !mineActive &&
    !followupsActive &&
    !searchParams.get('severity') &&
    !searchParams.get('status');

  const sevActive = (sev: string) =>
    onListPage && searchParams.get('severity') === sev && !mineActive && !followupsActive;

  return (
    <>
      <div
        className={`h-14 flex items-center gap-2.5 ${
          collapsed ? 'justify-center px-2' : 'px-4'
        } border-b border-slate-200/60 shrink-0`}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-sm shadow-blue-500/20 shrink-0">
          <ClipboardCheck className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="text-[13px] font-semibold text-slate-900 tracking-tight leading-tight block truncate">
              RCA Tracker
            </span>
            <span className="text-[10.5px] text-slate-400">Post-incident reviews</span>
          </div>
        )}
      </div>

      <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
        <GroupHeader collapsed={collapsed}>Browse</GroupHeader>
        <div className={`${collapsed ? 'px-1' : 'px-2'} space-y-0.5`}>
          <NavItem
            to="/"
            end
            icon={<FileSearch className="w-4 h-4" />}
            label="All RCAs"
            collapsed={collapsed}
            onNavigate={onNavigate}
            active={allActive}
          />
          <NavItem
            to="/?mine=1"
            icon={<ClipboardCheck className="w-4 h-4" />}
            label="Mine"
            collapsed={collapsed}
            onNavigate={onNavigate}
            active={mineActive}
          />
        </div>

        <GroupHeader collapsed={collapsed}>Filters</GroupHeader>
        <div className={`${collapsed ? 'px-1' : 'px-2'} space-y-0.5`}>
          <NavItem
            to="/?severity=sev1"
            icon={<span className="w-2 h-2 rounded-full bg-red-500" />}
            label="Sev1"
            collapsed={collapsed}
            onNavigate={onNavigate}
            active={sevActive('sev1')}
          />
          <NavItem
            to="/?severity=sev2"
            icon={<span className="w-2 h-2 rounded-full bg-orange-500" />}
            label="Sev2"
            collapsed={collapsed}
            onNavigate={onNavigate}
            active={sevActive('sev2')}
          />
          <NavItem
            to="/?severity=sev3"
            icon={<span className="w-2 h-2 rounded-full bg-yellow-500" />}
            label="Sev3"
            collapsed={collapsed}
            onNavigate={onNavigate}
            active={sevActive('sev3')}
          />
        </div>

        {!collapsed && (
          <>
            <GroupHeader collapsed={collapsed}>Recent</GroupHeader>
            <RecentRCAs collapsed={collapsed} onNavigate={onNavigate} />
          </>
        )}

        {isAdmin && (
          <>
            <GroupHeader collapsed={collapsed}>Manage</GroupHeader>
            <div className={`${collapsed ? 'px-1' : 'px-2'} space-y-0.5`}>
              <NavItem
                to="/users"
                icon={<UsersIcon className="w-4 h-4" />}
                label="Users"
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </div>
          </>
        )}
      </nav>
    </>
  );
}

function CommandSearchTrigger() {
  const isMac = isMacPlatform();
  return (
    <>
      <button
        type="button"
        onClick={openCommandSearch}
        className="hidden md:inline-flex items-center gap-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 transition-all duration-150 pl-3 pr-2 py-1.5 group"
        aria-label="Search RCAs"
      >
        <Search className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 transition-colors" />
        <span className="text-[13px]">Search…</span>
        <kbd className="ml-1 inline-flex items-center bg-white border border-slate-200 rounded text-[11px] px-1 py-0.5 font-medium text-slate-500">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <button
        type="button"
        onClick={openCommandSearch}
        className="md:hidden p-2 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        aria-label="Search RCAs"
      >
        <Search className="w-4 h-4" />
      </button>
    </>
  );
}

function Breadcrumbs() {
  const location = useLocation();

  const rcaIdMatch = location.pathname.match(/^\/rcas\/(\d+)/);
  const rcaId = rcaIdMatch ? Number(rcaIdMatch[1]) : null;
  const { data: rca } = useQuery({
    queryKey: ['rca', rcaId],
    queryFn: () => fetchRCA(rcaId!),
    enabled: rcaId !== null && Number.isFinite(rcaId),
    staleTime: 60_000,
  });

  if (location.pathname === '/users') {
    return (
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-slate-600">
        <span className="font-medium text-slate-900">Users</span>
      </nav>
    );
  }

  if (rcaId !== null && Number.isFinite(rcaId)) {
    const title = rca?.title ?? `RCA #${rcaId}`;
    const truncated = title.length > 60 ? `${title.slice(0, 60)}…` : title;
    return (
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-[13px] text-slate-500 min-w-0"
      >
        <Link to="/" className="hover:text-slate-900 transition-colors shrink-0">
          RCAs
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
        <span className="font-medium text-slate-900 truncate" title={title}>
          {truncated}
        </span>
      </nav>
    );
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-slate-600">
      <span className="font-medium text-slate-900">RCAs</span>
    </nav>
  );
}

function UserMenu() {
  const { me, isAdmin } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;

  const trigger = (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-lg pl-1 pr-2 py-1 hover:bg-slate-100 transition-colors"
      aria-label="Account menu"
    >
      <Avatar name={me.name || me.email} size="sm" />
      <span className="hidden sm:flex flex-col items-start leading-tight pr-1">
        <span className="text-[12.5px] font-medium text-slate-700 truncate max-w-[140px]">
          {me.name || me.email.split('@')[0]}
        </span>
      </span>
    </button>
  );

  return (
    <Dropdown trigger={trigger} align="right" width={260}>
      {(close) => (
        <>
          <div className="px-2 pt-1.5 pb-2.5 flex items-center gap-2.5">
            <Avatar name={me.name || me.email} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-slate-900 truncate">{me.name}</p>
              <p className="text-[11.5px] text-slate-500 truncate">{me.email}</p>
              {isAdmin && (
                <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 ring-1 ring-purple-200">
                  <Shield className="w-2.5 h-2.5" />
                  Admin
                </span>
              )}
            </div>
          </div>
          <div className="h-px bg-slate-200/70 mx-1 my-1" aria-hidden />
          {isAdmin && (
            <>
              <DropdownItem
                leading={<UsersIcon className="w-4 h-4 text-slate-500" />}
                onSelect={() => {
                  close();
                  navigate('/users');
                }}
              >
                Users
              </DropdownItem>
              <div className="h-px bg-slate-200/70 mx-1 my-1" aria-hidden />
            </>
          )}
          <DropdownItem
            leading={<LogOut className="w-4 h-4 text-slate-500" />}
            onSelect={() => {
              close();
              // Sign-out is handled by Pomerium upstream; nothing to do client-side.
            }}
          >
            Sign out
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}

export default function Layout() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Close mobile drawer when navigating
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, location.search]);

  const sidebarWidth = collapsed ? 'w-14' : 'w-60';
  const transitionKey = useMemo(() => location.pathname + location.search, [location]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar */}
      <header className="sticky top-0 z-30 h-14 glass border-b border-slate-200/70 flex items-center px-3 md:px-4 gap-3">
        <button
          type="button"
          onClick={() => {
            // On mobile open the drawer, on md+ toggle collapse
            if (window.matchMedia('(min-width: 768px)').matches) {
              setCollapsed((c) => !c);
            } else {
              setMobileOpen((o) => !o);
            }
          }}
          className="p-2 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="hidden md:inline-flex">
            {collapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </span>
          <span className="md:hidden">
            <Menu className="w-5 h-5" />
          </span>
        </button>

        <div className="flex-1 min-w-0">
          <Breadcrumbs />
        </div>

        <CommandSearchTrigger />

        <UserMenu />
      </header>

      {/* Body row: sidebar + main */}
      <div className="flex">
        {/* Desktop sidebar */}
        <aside
          className={`hidden md:flex sticky top-14 h-[calc(100vh-3.5rem)] ${sidebarWidth} bg-white/80 border-r border-slate-200/70 flex-col shrink-0 transition-[width] duration-200`}
        >
          <SidebarContent collapsed={collapsed} />
        </aside>

        {/* Mobile drawer */}
        <div
          className={`md:hidden fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity duration-200 ${
            mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
        <aside
          className={`md:hidden fixed top-0 left-0 bottom-0 z-50 w-72 bg-white border-r border-slate-200 flex flex-col transform transition-transform duration-300 ease-in-out ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between px-3 h-14 border-b border-slate-200/60 shrink-0">
            <span className="text-[13px] font-semibold text-slate-900">Menu</span>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </aside>

        {/* Main column */}
        <main className="flex-1 min-w-0">
          <div key={transitionKey} className="animate-page-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
