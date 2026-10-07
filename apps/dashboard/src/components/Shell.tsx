import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Activity, BarChart3, BookOpen, Briefcase, LogOut, Moon, Search, Settings, Sun, Telescope, Zap, MapPin } from 'lucide-react';
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** `group`: the heading the item sits under, for the pages of the utilities (they fetch no jobs, so they have no platform tab). */
const SECTIONS: readonly { to: string; label: string; icon: LucideIcon; end: boolean; tabs: boolean; group?: string }[] = [
  { to: '/', label: 'Overview', icon: Activity, end: true, tabs: false },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: false, tabs: true },
  { to: '/runs', label: 'Runs', icon: Zap, end: false, tabs: true },
  { to: '/jobs', label: 'Jobs', icon: Briefcase, end: false, tabs: true },
  { to: '/searches', label: 'Searches', icon: Search, end: false, tabs: true },
  { to: '/ats-discovery', label: 'ATS discovery', icon: Telescope, end: false, tabs: false, group: 'Tools' },
  { to: '/linkedin-places', label: 'LinkedIn places', icon: MapPin, end: false, tabs: false, group: 'Tools' },
  { to: '/docs', label: 'Docs', icon: BookOpen, end: false, tabs: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false, tabs: false },
];

/** `?tool=linkedin` filters the section to one platform; the tab is kept in the URL so a view is a link. */
export function usePlatform(): string | undefined {
  const [params] = useSearchParams();
  return params.get('tool') ?? undefined;
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

  return (
    <div className="flex h-screen">
      <nav aria-label="Sections" className="flex w-52 shrink-0 flex-col border-r bg-card">
        <div className="px-4 py-4 text-sm font-semibold tracking-wide">jobwatch</div>
        <ul className="flex-1 space-y-0.5 px-2">
          {SECTIONS.map(({ to, label, icon: Icon, end, group }, index) => (
            <li key={to}>
              {group !== undefined && SECTIONS[index - 1]?.group !== group && (
                <div className="px-3 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</div>
              )}
              <NavLink
                to={{
                  pathname: to,
                  search: params.get('tool') && SECTIONS.find((s) => s.to === to)?.tabs ? `?tool=${params.get('tool')}` : '',
                }}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md py-2 pr-3 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    group === undefined ? 'pl-3' : 'pl-5',
                    isActive && 'bg-accent text-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            </li>
          ))}
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
