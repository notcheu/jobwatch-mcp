import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { DisallowedBadges, KeywordBadges } from '@/components/KeywordBadges';
import { StatCard } from '@/components/StatCard';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { compact, searchDetailLink } from '@/lib/format';
import { HealthBadge } from '@/components/SearchHealth';

export function Overview() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 5000 });
  const o = overview.data;
  if (overview.isError) return <p className="p-6 text-sm text-destructive">Could not load the overview.</p>;
  if (o === undefined) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="w-full space-y-4 overflow-auto p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Request health</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-2 text-sm">
            <span>Completed</span>
            <span className="text-right tabular-nums">{compact(o.health.completed)}</span>
            <span>Failed</span>
            <span className={`text-right tabular-nums ${o.health.failed > 0 ? 'text-destructive' : ''}`}>{compact(o.health.failed)}</span>
            <span>Rate limited</span>
            <span className={`text-right tabular-nums ${o.health.rateLimited > 0 ? 'text-warning' : ''}`}>
              {compact(o.health.rateLimited)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-2 text-sm">
            <span>Running now</span>
            <span className="text-right tabular-nums">{o.health.active}</span>
            <span>Browser</span>
            <span className="text-right">{o.runtimeState}</span>
            <span>Enabled adapters</span>
            <span className="text-right tabular-nums">{o.enabledAdapters}</span>
            <span>Uptime</span>
            <span className="text-right tabular-nums">
              {Math.floor(o.uptimeS / 3600)} h {Math.floor((o.uptimeS % 3600) / 60)} min
            </span>
          </CardContent>
        </Card>
      </div>
      <Card aria-label="Searches in bad health">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Searches in bad health (7 days)</CardTitle>
          <Link to="/searches" className="text-xs text-primary hover:underline">
            All searches
          </Link>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {o.badSearches.count === 0 ? (
            <p className="text-muted-foreground">Every search brought jobs in and kept most of them.</p>
          ) : (
            <>
              <ul className="divide-y">
                {o.badSearches.items.map((search) => (
                  <li key={`${search.source}|${search.keywords.join('\u0000')}|${search.disallowed.join('\u0000')}`}>
                    <Link
                      to={searchDetailLink(search.source, search.keywords, search.disallowed)}
                      className="flex items-center justify-between gap-2 py-1.5 hover:bg-accent/50"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <KeywordBadges keywords={search.keywords} />
                        {search.disallowed.length > 0 && <DisallowedBadges terms={search.disallowed} />}
                        <Badge variant="secondary">{search.source}</Badge>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {search.jobsExcluded} of {search.jobsFound} discarded
                        </span>
                        <HealthBadge health={search.health} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {o.badSearches.count > o.badSearches.items.length && (
                <p className="text-xs text-muted-foreground">and {o.badSearches.count - o.badSearches.items.length} more</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Tokens returned to Claude"
          value={`~${compact(o.tokensReturned)}`}
          note="Estimated from the size of the text sent"
        />
        <StatCard title="Calls shown" value={compact(o.callsInMemory)} note={`of ${compact(o.callBufferSize)} kept`} />
        <StatCard title="Stored jobs" value={compact(o.storedJobs)} note="In the router database" />
      </div>
    </div>
  );
}
