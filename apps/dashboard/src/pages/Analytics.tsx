import { useQuery } from '@tanstack/react-query';
import type { Overview, ToolState, Usage } from '@jobwatch/dashboard-api';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNavigate } from 'react-router';
import { StatCard } from '@/components/StatCard';
import { usePlatform } from '@/components/Shell';
import { DisallowedBadges, KeywordBadges } from '@/components/KeywordBadges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, bytes, compact, duration, searchDetailLink } from '@/lib/format';
import { cn } from '@/lib/utils';

type Scope = 'session' | 'lifetime' | 'historical';
const SCOPES: { value: Scope; label: string; hint: string }[] = [
  { value: 'session', label: 'Session', hint: 'The calls in memory, since the router started' },
  { value: 'lifetime', label: 'Lifetime', hint: 'Daily totals kept across restarts' },
  { value: 'historical', label: 'Historical', hint: 'Daily totals for the dates you pick' },
];

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100));

function Bar({ share, tone = 'primary' }: { share: number; tone?: 'primary' | 'warning' | 'destructive' }) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        role="presentation"
        className={cn(
          'h-full',
          tone === 'primary' && 'bg-primary',
          tone === 'warning' && 'bg-warning',
          tone === 'destructive' && 'bg-destructive',
        )}
        ref={(node) => {
          if (node) node.style.width = `${Math.max(0, Math.min(100, share))}%`;
        }}
      />
    </div>
  );
}

export function Analytics() {
  const platform = usePlatform();
  const [scope, setScope] = useState<Scope>('session');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const usage = useQuery({
    queryKey: ['usage', scope, from, to, platform],
    queryFn: () => api.usage({ scope, ...(scope === 'historical' ? { from, to } : {}), ...(platform === undefined ? {} : { platform }) }),
    refetchInterval: scope === 'session' ? 5000 : 30_000,
  });
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 5000 });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, refetchInterval: 15_000 });

  return (
    <div className="w-full space-y-4 overflow-auto p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Period" className="inline-flex rounded-lg bg-muted p-1">
          {SCOPES.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={scope === item.value ? 'default' : 'ghost'}
              title={item.hint}
              aria-pressed={scope === item.value}
              onClick={() => setScope(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {scope === 'historical' && (
          <div className="flex items-center gap-2">
            <Input aria-label="From date" type="date" className="w-36" value={from} onChange={(event) => setFrom(event.target.value)} />
            <span className="text-muted-foreground">to</span>
            <Input aria-label="To date" type="date" className="w-36" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {SCOPES.find((item) => item.value === scope)?.hint}
          {usage.data?.since ? ` · since ${new Date(usage.data.since).toLocaleDateString()}` : ''}. Token counts are estimates (~).
        </span>
      </div>

      {usage.isError && <p className="text-sm text-destructive">Could not load the analytics.</p>}
      {usage.data === undefined && !usage.isError && <p className="text-sm text-muted-foreground">Loading…</p>}
      {usage.data !== undefined && usage.data.totals.calls === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {scope === 'session'
            ? 'No calls yet. Run a search from Claude and its numbers appear here.'
            : 'No calls recorded for this period.'}
        </p>
      )}

      {overview.data !== undefined && <HealthCards overview={overview.data} />}
      {usage.data !== undefined && usage.data.totals.calls > 0 && <UsagePanels usage={usage.data} />}
      {tools.data !== undefined && (
        <Budgets
          adapters={tools.data.adapters.filter((adapter) => adapter.enabled && (platform === undefined || adapter.platform === platform))}
        />
      )}
      <SearchEffectiveness platform={platform} />
    </div>
  );
}

function HealthCards({ overview }: { overview: Overview }) {
  const health = overview.health;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Request health</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-4 gap-2 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Completed</div>
            <div className="text-xl font-semibold tabular-nums">{compact(health.completed)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Failed</div>
            <div className={cn('text-xl font-semibold tabular-nums', health.failed > 0 && 'text-destructive')}>
              {compact(health.failed)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Rate limited</div>
            <div className={cn('text-xl font-semibold tabular-nums', health.rateLimited > 0 && 'text-warning')}>
              {compact(health.rateLimited)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Running</div>
            <div className="text-xl font-semibold tabular-nums">{health.active}</div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Live activity</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-4 gap-2 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Browser</div>
            <div className="text-base font-medium">{overview.runtimeState}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Adapters</div>
            <div className="text-xl font-semibold tabular-nums">{overview.enabledAdapters}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Calls kept</div>
            <div className="text-xl font-semibold tabular-nums">{compact(overview.callsInMemory)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Stored jobs</div>
            <div className="text-xl font-semibold tabular-nums">{compact(overview.storedJobs)}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UsagePanels({ usage }: { usage: Usage }) {
  const t = usage.totals;
  const errorRate = pct(t.errors, t.calls);
  const keptBack = t.textAvailableChars === 0 ? null : pct(t.textAvailableChars - t.textReturnedChars, t.textAvailableChars);
  const maxTokens = Math.max(1, ...usage.byTool.map((tool) => tool.estimatedTokens));
  const hours = usage.granularity === 'hour';
  const series = usage.series.map((point) => ({
    ...point,
    label: hours ? new Date(point.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : point.bucket.slice(5, 10),
  }));
  const perUnit = hours ? 'hour' : 'day';
  const latest = usage.series.at(-1);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Tokens returned to Claude"
          value={`~${compact(t.estimatedTokens)}`}
          note={`~${compact(Math.round(t.estimatedTokens / t.calls))} per call · ${bytes(t.responseBytes)} sent`}
        />
        <StatCard
          title="Calls"
          value={compact(t.calls)}
          tone={errorRate >= 20 ? 'destructive' : errorRate > 0 ? 'warning' : undefined}
          note={`${t.errors} failed or refused (${errorRate} %)`}
        />
        <StatCard
          title="Kept back by summaries"
          value={keptBack === null ? '–' : `${keptBack} %`}
          tone={keptBack !== null && keptBack > 0 ? 'success' : undefined}
          note={
            keptBack === null
              ? 'No job text was involved'
              : `~${compact(Math.round((t.textAvailableChars - t.textReturnedChars) / 3.5))} tokens of job text not sent (${compact(t.textReturnedChars)} of ${compact(t.textAvailableChars)} characters)`
          }
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Duration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>Median</span>
              <span className="tabular-nums">{t.durationP50Ms === null ? 'n/a' : duration(t.durationP50Ms)}</span>
            </div>
            <div className="flex justify-between">
              <span>95th percentile</span>
              <span className="tabular-nums">{t.durationP95Ms === null ? 'n/a' : duration(t.durationP95Ms)}</span>
            </div>
            <div className="flex justify-between">
              <span>Slowest</span>
              <span className="tabular-nums">{t.durationMaxMs === null ? 'n/a' : duration(t.durationMaxMs)}</span>
            </div>
            {t.durationP50Ms === null && (
              <p className="pt-1 text-xs text-muted-foreground">Percentiles need every call: they exist for the session only.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Throughput</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>Latest {perUnit}</span>
              <span className="tabular-nums">{latest === undefined ? '–' : `${latest.calls} calls`}</span>
            </div>
            <div className="flex justify-between">
              <span>Average per {perUnit}</span>
              <span className="tabular-nums">{series.length === 0 ? '–' : (t.calls / series.length).toFixed(1)}</span>
            </div>
            <div className="flex justify-between">
              <span>Units spent</span>
              <span className="tabular-nums">{compact(t.unitsSpent)}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Time per tool</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {usage.byTool.slice(0, 6).map((tool) => (
              <div key={tool.tool} className="flex justify-between gap-2">
                <span className="truncate">{tool.tool}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {tool.avgDurationMs === null ? '–' : duration(tool.avgDurationMs)} avg ·{' '}
                  {tool.maxDurationMs === null ? '–' : duration(tool.maxDurationMs)} max
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Token usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>Job text available</span>
              <span className="tabular-nums">{compact(t.textAvailableChars)} chars</span>
            </div>
            <div className="flex justify-between">
              <span>Job text sent</span>
              <span className="tabular-nums">{compact(t.textReturnedChars)} chars</span>
            </div>
            <div className="flex justify-between border-t pt-1">
              <span>All results sent</span>
              <span className="tabular-nums">~{compact(t.estimatedTokens)} tokens</span>
            </div>
            <div className="flex justify-between">
              <span>In bytes</span>
              <span className="tabular-nums">{bytes(t.responseBytes)}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What each tool returned</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {usage.byTool.slice(0, 8).map((tool) => (
              <div key={tool.tool} className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span className="truncate">{tool.tool}</span>
                  <span className="tabular-nums text-muted-foreground">~{compact(tool.estimatedTokens)}</span>
                </div>
                <Bar share={pct(tool.estimatedTokens, maxTokens)} />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tokens over time</CardTitle>
          </CardHeader>
          <CardContent>
            <div role="img" aria-label={`Estimated tokens returned per ${perUnit}`} className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="var(--muted-foreground)"
                    width={36}
                    tickFormatter={(value: number) => compact(value)}
                  />
                  <Tooltip
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="estimatedTokens"
                    name="~tokens"
                    stroke="var(--primary)"
                    fill="var(--primary)"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">Show as a table</summary>
              <ul className="mt-1 text-xs">
                {series.map((point) => (
                  <li key={point.bucket} className="flex justify-between">
                    <span>{point.label}</span>
                    <span className="tabular-nums">
                      ~{point.estimatedTokens} tokens · {point.calls} calls
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per tool</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {['Tool', 'Calls', 'Errors', '~Tokens', 'Avg ~tokens', 'Avg duration', 'Avg units', 'Share'].map((title) => (
                  <TableHead key={title}>{title}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.byTool.map((tool) => (
                <TableRow key={tool.tool}>
                  <TableCell className="font-medium">{tool.tool}</TableCell>
                  <TableCell className="tabular-nums">{tool.calls}</TableCell>
                  <TableCell className={cn('tabular-nums', tool.errors > 0 && 'text-destructive')}>{tool.errors}</TableCell>
                  <TableCell className="tabular-nums">{compact(tool.estimatedTokens)}</TableCell>
                  <TableCell className="tabular-nums">{compact(tool.avgTokens)}</TableCell>
                  <TableCell className="tabular-nums">{tool.avgDurationMs === null ? '–' : duration(tool.avgDurationMs)}</TableCell>
                  <TableCell className="tabular-nums">{tool.avgUnitsSpent}</TableCell>
                  <TableCell className="tabular-nums">{pct(tool.estimatedTokens, t.estimatedTokens)} %</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function Budgets({ adapters }: { adapters: ToolState[] }) {
  const gauges = adapters.filter((adapter) => adapter.rateHour !== null && adapter.rateDay !== null);
  const boards = adapters
    .flatMap((adapter) =>
      adapter.boards.map((board) => ({
        platform: adapter.platform,
        ...board,
        share: Math.max(pct(board.rateHour.used, board.rateHour.limit), pct(board.rateDay.used, board.rateDay.limit)),
      })),
    )
    .filter((board) => board.share >= 50)
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);
  if (gauges.length === 0) return null;
  const tone = (share: number) => (share >= 90 ? 'destructive' : share >= 70 ? 'warning' : 'primary');
  return (
    <Card aria-label="Budgets">
      <CardHeader>
        <CardTitle>Rate budgets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {gauges.map((adapter) => (
            <div key={adapter.id} className="space-y-1.5">
              <div className="text-sm font-medium">{adapter.displayName}</div>
              {(
                [
                  ['hour', adapter.rateHour],
                  ['day', adapter.rateDay],
                ] as const
              ).map(([label, rate]) =>
                rate === null ? null : (
                  <div key={label} className="flex items-center gap-2 text-xs">
                    <span className="w-8 text-muted-foreground">{label}</span>
                    <Bar share={pct(rate.used, rate.limit)} tone={tone(pct(rate.used, rate.limit))} />
                    <span className="w-20 text-right tabular-nums">
                      {rate.used} / {rate.limit}
                    </span>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        {boards.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Company boards closest to their limit</div>
            <ul className="space-y-1">
              {boards.map((board) => (
                <li key={`${board.platform}/${board.board}`} className="flex items-center gap-2 text-xs">
                  <span className="w-40 truncate">
                    {board.platform}/{board.board}
                  </span>
                  <Bar share={board.share} tone={tone(board.share)} />
                  <span className="w-10 text-right tabular-nums">{board.share} %</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SearchEffectiveness({ platform }: { platform: string | undefined }) {
  const navigate = useNavigate();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const searches = useQuery({
    queryKey: ['searches', platform, 7],
    queryFn: () => api.searches({ since, ...(platform === undefined ? {} : { source: platform }) }),
  });
  const rows = (searches.data?.searches ?? []).filter((row) => row.keywords.length > 0);
  if (rows.length === 0) return null;
  const best = [...rows].sort((a, b) => b.jobsNew - a.jobsNew).slice(0, 5);
  const stale = rows.filter((row) => row.jobsNew === 0 && row.runs >= 2);
  const open = (source: string, keywords: readonly string[], disallowed: readonly string[]): void =>
    void navigate(searchDetailLink(source, keywords, disallowed));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card aria-label="Best keywords">
        <CardHeader>
          <CardTitle>Keywords that brought the most new jobs (7 days)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {best.map((row) => (
            <button
              key={`${row.source}|${row.keywords.join('\u0000')}|${row.disallowed.join('\u0000')}`}
              className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-accent"
              onClick={() => open(row.source, row.keywords, row.disallowed)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <KeywordBadges keywords={row.keywords} />
                {row.disallowed.length > 0 && <DisallowedBadges terms={row.disallowed} />}
                <Badge variant="secondary">{row.source}</Badge>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {row.jobsNew} new of {row.jobsFound}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>
      <Card aria-label="Keywords to drop">
        <CardHeader>
          <CardTitle>Keywords that found nothing new (7 days)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {stale.length === 0 ? (
            <p className="text-muted-foreground">Every keyword brought something new.</p>
          ) : (
            stale.map((row) => (
              <div
                key={`${row.source}|${row.keywords.join('\u0000')}|${row.disallowed.join('\u0000')}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <KeywordBadges keywords={row.keywords} />
                  {row.disallowed.length > 0 && <DisallowedBadges terms={row.disallowed} />}
                  <Badge variant="secondary">{row.source}</Badge>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {row.runs} runs · last {ago(row.lastRun)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
