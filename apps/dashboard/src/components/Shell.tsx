import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BarChart3,
  BookOpen,
  Briefcase,
  LogOut,
  Moon,
  Search,
  Settings,
  SquareCode,
  Sun,
  Telescope,
  Zap,
  MapPin,
  ChevronDown,
  ChevronUp,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** `group`: the menu item the page sits under, for the pages of the utilities (they fetch no jobs, so they have no platform tab). */
const GROUP_ICONS: Record<string, LucideIcon> = { Tools: Wrench };

const SECTIONS: readonly { to: string; label: string; icon: LucideIcon; end: boolean; tabs: boolean; group?: string }[] = [
  { to: '/', label: 'Overview', icon: Activity, end: true, tabs: false },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: false, tabs: true },
  { to: '/runs', label: 'Runs', icon: Zap, end: false, tabs: true },
  { to: '/jobs', label: 'Jobs', icon: Briefcase, end: false, tabs: true },
  { to: '/searches', label: 'Searches', icon: Search, end: false, tabs: true },
  { to: '/ats-discovery', label: 'ATS discovery', icon: Telescope, end: false, tabs: false, group: 'Tools' },
  { to: '/linkedin-places', label: 'LinkedIn places', icon: MapPin, end: false, tabs: false, group: 'Tools' },
  { to: '/custom-adapters', label: 'Custom adapters', icon: SquareCode, end: false, tabs: false, group: 'Tools' },
  { to: '/docs', label: 'Docs', icon: BookOpen, end: false, tabs: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false, tabs: false },
];

const NAV_ITEM =
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground';
const NAV_ACTIVE = 'bg-accent text-accent-foreground';

/** A menu item that folds and unfolds the pages under it. Open at first; a folded group is marked when the page shown is one of its own. */
function NavGroup({
  label,
  icon: Icon,
  items,
  pathname,
}: {
  label: string;
  icon: LucideIcon;
  items: readonly (typeof SECTIONS)[number][];
  pathname: string;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronUp : ChevronDown;
  const hasCurrent = items.some((item) => pathname.startsWith(item.to));
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`nav-group-${label}`}
        className={cn(NAV_ITEM, !open && hasCurrent && NAV_ACTIVE)}
        onClick={() => setOpen(!open)}
      >
        <Icon className="size-4" />
        <span className="flex-1 text-left">{label}</span>
        <Chevron className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <ul id={`nav-group-${label}`} className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={({ isActive }) => cn(NAV_ITEM, 'pl-9', isActive && NAV_ACTIVE)}>
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** `?tool=linkedin` filters the section to one platform; the tab is kept in the URL so a view is a link. */
export function usePlatform(): string | undefined {
  const [params] = useSearchParams();
  return params.get('tool') ?? undefined;
}

/** The tab that groups every utility together (they fetch no jobs, so each has no tab of its own); no platform is named so. */
export const UTILITY_TAB = 'utility';

/** What the `?tool=` tab asks the API for: one platform, or every utility together. */
export function useToolFilter(): { platform?: string; role?: 'utility' } {
  const tool = usePlatform();
  if (tool === undefined) return {};
  return tool === UTILITY_TAB ? { role: 'utility' } : { platform: tool };
}

export function Shell() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [dark, toggle] = useTheme();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, refetchInterval: 15_000 });
  const section = SECTIONS.find((s) => (s.end ? location.pathname === s.to : location.pathname.startsWith(s.to)));
  // a utility fetches no jobs: it has no tab on the pages that list jobs and searches
  const platforms = (tools.data?.adapters ?? [])
    .filter((adapter) => adapter.enabled && adapter.role === 'adapter')
    .map((adapter) => adapter.platform);
  const unique = [...new Set(platforms)];
  // the utility tab is offered where the numbers of the utilities are shown, and only when one is enabled
  const hasUtility = (tools.data?.adapters ?? []).some((adapter) => adapter.enabled && adapter.role === 'utility');
  const utilityTab = hasUtility && (section?.to === '/runs' || section?.to === '/analytics');

  return (
    <div className="flex h-screen">
      <nav aria-label="Sections" className="flex w-52 shrink-0 flex-col border-r bg-card">
        <div className="px-4 py-4 text-sm font-semibold tracking-wide">jobwatch</div>
        <ul className="flex-1 space-y-0.5 px-2">
          {SECTIONS.map((item, index) => {
            if (item.group !== undefined) {
              // the pages of a group are drawn once, under the group's own item, at the place of its first page
              if (SECTIONS[index - 1]?.group === item.group) return null;
              return (
                <NavGroup
                  key={item.group}
                  label={item.group}
                  icon={GROUP_ICONS[item.group] ?? Wrench}
                  items={SECTIONS.filter((entry) => entry.group === item.group)}
                  pathname={location.pathname}
                />
              );
            }
            return (
              <li key={item.to}>
                <NavLink
                  to={{ pathname: item.to, search: params.get('tool') && item.tabs ? `?tool=${params.get('tool')}` : '' }}
                  end={item.end}
                  className={({ isActive }) => cn(NAV_ITEM, isActive && NAV_ACTIVE)}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
        <div className="border-t p-3 text-xs text-muted-foreground">
          {me.data?.mode === 'google' ? <div className="truncate">{me.data.email}</div> : <div>Local development</div>}
          <div>v{me.data?.version ?? '…'}</div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-5 py-2">
          <h1 className="text-lg font-semibold">{section?.label ?? 'jobwatch'}</h1>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {me.data?.idleStopAt && (
              <span title="The dashboard closes itself when it is not used">
                closes {new Date(me.data.idleStopAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} if idle
              </span>
            )}
            <Badge variant={me.isError ? 'destructive' : 'success'}>{me.isError ? 'Offline' : 'Connected'}</Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
              onClick={toggle}
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            {me.data?.mode === 'google' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                onClick={() => {
                  void fetch('/dashboard/auth/logout', {
                    method: 'POST',
                    headers: { 'x-jw-csrf': '1' },
                    credentials: 'same-origin',
                  }).finally(() => window.location.assign('/dashboard/login'));
                }}
              >
                <LogOut className="size-4" />
              </Button>
            )}
          </div>
        </header>

        {section?.tabs && (
          <div className="border-b px-5 py-2">
            <Tabs
              value={params.get('tool') ?? 'all'}
              onValueChange={(value) => {
                const next = new URLSearchParams(params);
                if (value === 'all') next.delete('tool');
                else next.set('tool', value);
                setParams(next);
              }}
            >
              <TabsList aria-label="Tool">
                <TabsTrigger value="all">All</TabsTrigger>
                {unique.map((platform) => (
                  <TabsTrigger key={platform} value={platform}>
                    {platform}
                  </TabsTrigger>
                ))}
                {utilityTab && <TabsTrigger value={UTILITY_TAB}>Utility</TabsTrigger>}
              </TabsList>
            </Tabs>
          </div>
        )}

        <main className="flex min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
