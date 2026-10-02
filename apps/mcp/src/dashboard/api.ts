import {
  callDetailSchema,
  callRowSchema,
  callsPageSchema,
  jobDetailSchema,
  jobsPageSchema,
  overviewSchema,
  searchesSchema,
  settingsSchema,
  toolsSchema,
  usageSchemaResponse,
  type CallDetail,
  type CallsPage,
  type JobDetail,
  type JobsPage,
  type Overview,
  type Searches,
  type Settings,
  type Tools,
  type Usage,
} from '@jobwatch/dashboard-api';
import { describeInstalled } from '@jobwatch/adapters';
import {
  JOB_SORT_COLUMNS,
  type CallEntry,
  type CallLog,
  type CircuitBreaker,
  type InstalledAdapters,
  type PlatformStatus,
  type RateLimiter,
  type Registry,
  type RuntimeManager,
  type Store,
} from '@jobwatch/core';
import { buildCatalog, extractHints, summarizeJob } from '@jobwatch/sdk';
import { z } from 'zod';

/** What the dashboard reads. Nothing here can start a browser, call a site or spend a rate-limit unit. */
export interface DashboardData {
  version: string;
  clock: () => number;
  store: Store;
  callLog: CallLog;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  registry: () => Registry;
  installed: InstalledAdapters;
  /** `JW_ADAPTERS` pins the list of adapters. */
  pinned: boolean;
  runtime: () => RuntimeManager | undefined;
  /** The limits in force, shown read only (no secret in it). */
  settings: Settings;
  /** The last session check of each browser platform (what `session_status` found); the dashboard never runs a check. */
  sessionStates: () => ReadonlyMap<string, PlatformStatus>;
}

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Parse a response with its schema before it leaves: a field that is not in the schema fails here instead of leaking. */
export const checked = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);

// ---------------------------------------------------------------------------------------------------------- calls

const callQuery = z.object({
  tool: z.string().max(64).optional(),
  platform: z.string().max(32).optional(),
  code: z.string().max(32).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const callRow = (entry: CallEntry) =>
  callRowSchema.parse({
    id: entry.id,
    requestId: entry.requestId,
    tool: entry.tool,
    platform: entry.platform,
    state: entry.state,
    code: entry.code,
    startedAt: iso(entry.startedAt),
    durationMs: entry.durationMs,
    unitsReserved: entry.unitsReserved,
    unitsSpent: entry.unitsSpent,
    responseBytes: entry.responseBytes,
    estimatedTokens: entry.estimatedTokens,
    warnings: entry.warnings,
    keywords: entry.keywords,
  });

export function listCalls(data: DashboardData, query: unknown): CallsPage {
  const q = callQuery.parse(query);
  const page = data.callLog.list({
    limit: q.limit,
    ...(q.tool === undefined ? {} : { tool: q.tool }),
    ...(q.platform === undefined ? {} : { platform: q.platform }),
    ...(q.code === undefined ? {} : { code: q.code }),
    ...(q.before === undefined ? {} : { before: q.before }),
  });
  return checked(callsPageSchema, { calls: page.calls.map(callRow), total: page.total, next: page.next });
}

export function getCall(data: DashboardData, id: number): CallDetail | undefined {
  const entry = data.callLog.get(id);
  if (entry === undefined) return undefined;
  return checked(callDetailSchema, {
    ...callRow(entry),
    adapter: entry.adapter,
    argsHash: entry.argsHash,
    params: entry.params,
    paramsTruncated: entry.paramsTruncated,
    paramsDropped: entry.paramsDropped,
    jobText: entry.jobText,
  });
}

// ----------------------------------------------------------------------------------------------------------- jobs

const jobsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  source: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  board: z.string().max(120).optional(),
  found_by: z.string().trim().max(200).optional(),
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
  dateField: z.enum(['first_seen', 'last_seen', 'fetched_at']).default('first_seen'),
  sort: z.enum(Object.keys(JOB_SORT_COLUMNS) as [keyof typeof JOB_SORT_COLUMNS, ...(keyof typeof JOB_SORT_COLUMNS)[]]).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

function parseDate(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new z.ZodError([{ code: 'custom', path: [name], message: 'not a date', input: value }]);
  return ms;
}

export function listJobs(data: DashboardData, query: unknown): JobsPage {
  const q = jobsQuery.parse(query);
  const since = parseDate('from', q.from, 0);
  const until = parseDate('to', q.to, data.clock() + DAY_MS);
  const { rows, total } = data.store.listJobs({
    field: q.dateField,
    since,
    until,
    sources: q.source === undefined ? [] : [q.source],
    boards: q.board === undefined || q.board === '' ? [] : [q.board],
    ...(q.q === undefined || q.q === '' ? {} : { q: q.q }),
    ...(q.found_by === undefined || q.found_by === '' ? {} : { search: q.found_by }),
    ...(q.sort === undefined ? {} : { sort: q.sort }),
    dir: q.dir,
    offset: (q.page - 1) * q.pageSize,
    limit: q.pageSize,
    withDescription: false,
  });
  const foundBy = new Map<string, string[]>();
  for (const platform of new Set(rows.map((row) => row.platform)))
    for (const [id, queries] of data.store.foundBy(
      platform,
      rows.filter((row) => row.platform === platform).map((row) => row.id),
    ))
      foundBy.set(`${platform}\u0000${id}`, queries);
  return checked(jobsPageSchema, {
    jobs: rows.map((row) => ({
      source: row.platform,
      id: row.id,
      board: row.board ?? null,
      title: row.title,
      company: row.company,
      location: row.location,
      url: row.url,
      firstSeen: iso(row.firstSeen),
      fetchedAt: iso(row.fetchedAt),
      lastSeen: iso(row.lastSeen),
      descriptionChars: row.descriptionChars,
      foundBy: foundBy.get(`${row.platform}\u0000${row.id}`) ?? [],
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  });
}

export function getJob(data: DashboardData, source: string, id: string): JobDetail | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
  const row = data.store.getJob(source, id);
  if (row === null) return undefined;
  const summary = summarizeJob(row.description);
  const hints = extractHints(row.description);
  return checked(jobDetailSchema, {
    source,
    id,
    board: row.board ?? null,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    firstSeen: iso(row.firstSeen),
    fetchedAt: iso(row.fetchedAt),
    lastSeen: iso(row.lastSeen),
    descriptionChars: row.description.length,
    foundBy: data.store.foundBy(source, [id]).get(id) ?? [],
    description: row.description,
    summary: summary.summary,
    summaryKind: summary.kind,
    outline: summary.outline,
    hints: { stack: hints.stack_hints, years: hints.years_hints, remote: hints.remote_hints, salary: hints.salary_text },
  });
}

// ------------------------------------------------------------------------------------------------------- searches

const searchesQuery = z.object({
  since: z.string().max(32).optional(),
  until: z.string().max(32).optional(),
  source: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
});

export function listSearches(data: DashboardData, query: unknown): Searches {
  const q = searchesQuery.parse(query);
  const until = parseDate('until', q.until, data.clock() + 1);
  const since = parseDate('since', q.since, until - 7 * DAY_MS);
  const rows = data.store.searchStats({ since, until, ...(q.source === undefined ? {} : { platform: q.source }), limit: 200 });
  return checked(searchesSchema, {
    searches: rows.map((row) => ({
      source: row.platform,
      query: row.query,
      runs: row.runs,
      lastRun: iso(row.lastRun),
      jobsFound: row.jobsFound,
      jobsReturned: row.jobsReturned,
      jobsNew: row.jobsNew,
    })),
  });
}

// ---------------------------------------------------------------------------------------------------------- tools

function sessionOf(data: DashboardData, platform: string, kind: 'browser' | 'http') {
  if (kind !== 'browser') return null;
  const status = data.sessionStates().get(platform);
  return status === undefined ? null : { state: status.state, checkedAt: status.checked_at, note: status.note ?? null };
}

export async function getTools(data: DashboardData): Promise<Tools> {
  const registry = data.registry();
  const enabled = new Set(registry.enabled.map((adapter) => adapter.id));
  const now = data.clock();
  const adapters = [];
  for (const entry of await describeInstalled(data.installed)) {
    const load = data.installed[entry.id];
    if (entry.summary === undefined || load === undefined) continue;
    const catalog = buildCatalog(await load());
    const isOn = enabled.has(entry.id);
    const platform = entry.summary.platform;
    const rate = isOn ? data.limiter.status(platform) : undefined;
    const open = isOn ? data.breaker.state(platform) : undefined;
    const boards = isOn
      ? data.store
          .usageKeys(platform, now - DAY_MS)
          .map((board) => {
            const status = data.limiter.status(`${platform}#${board}`);
            return { board, rateHour: status.hour, rateDay: status.day };
          })
          .sort((a, b) => b.rateDay.used - a.rateDay.used || a.board.localeCompare(b.board))
          .slice(0, 25)
      : [];
    adapters.push({
      id: entry.id,
      displayName: entry.summary.displayName,
      platform,
      kind: entry.summary.kind,
      enabled: isOn,
      pinned: data.pinned,
      hosts: [...entry.summary.allowedHosts],
      tools: catalog.map((tool) => ({
        name: tool.name,
        title: tool.title,
        costMax: tool.limits.rate.cost,
        params: Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      })),
      rateHour: rate?.hour ?? null,
      rateDay: rate?.day ?? null,
      boards,
      breaker: open ? { reason: open.reason, until: open.until === null ? null : iso(open.until) } : null,
      session: sessionOf(data, platform, entry.summary.kind),
    });
  }
  const status = data.runtime()?.status();
  return checked(toolsSchema, {
    adapters,
    runtime: {
      enabled: data.runtime() !== undefined,
      state: status?.current?.state ?? 'cold',
      platform: status?.current?.platform ?? null,
      peakMb: status?.current ? Math.round(status.current.peakBytes / (1024 * 1024)) : null,
      waiting: status?.waiting ?? 0,
    },
  });
}

// -------------------------------------------------------------------------------------------------------- overview

export const getSettings = (data: DashboardData): Settings => checked(settingsSchema, data.settings);

export function getOverview(data: DashboardData): Overview {
  const calls = data.callLog.all();
  const done = calls.filter((call) => call.state === 'done');
  const runtime = data.runtime()?.status();
  return checked(overviewSchema, {
    version: data.version,
    uptimeS: Math.round(process.uptime()),
    health: {
      completed: done.filter((call) => call.code === 'ok').length,
      failed: done.filter((call) => call.code !== 'ok' && call.code !== 'rate_limited').length,
      rateLimited: done.filter((call) => call.code === 'rate_limited').length,
      active: calls.length - done.length,
    },
    tokensReturned: calls.reduce((sum, call) => sum + call.estimatedTokens, 0),
    callsInMemory: calls.length,
    callBufferSize: data.callLog.capacity,
    storedJobs: data.store.countJobs(),
    runtimeState: runtime?.current?.state ?? 'cold',
    enabledAdapters: data.registry().enabled.length,
  });
}

// ----------------------------------------------------------------------------------------------------------- usage

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null);

const usageQuery = z.object({
  scope: z.enum(['session', 'lifetime', 'historical']).default('session'),
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
  tool: z.string().max(64).optional(),
  platform: z.string().max(32).optional(),
});

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The analytics. `session` reads the calls in memory (hourly buckets, with percentiles); `lifetime` and `historical` read the persisted
 * daily totals, which survive a restart (daily buckets; durations are averages and a maximum, since percentiles need every call).
 */
export function getUsage(data: DashboardData, query: unknown): Usage {
  const q = usageQuery.parse(query);
  if (q.scope !== 'session') return getPersistedUsage(data, q);
  return getSessionUsage(data, q);
}

function getPersistedUsage(data: DashboardData, q: z.infer<typeof usageQuery>): Usage {
  const now = data.clock();
  const to = q.scope === 'historical' && q.to !== undefined && q.to !== '' ? day(parseDate('to', q.to, now)) : day(now);
  const from = q.scope === 'historical' && q.from !== undefined && q.from !== '' ? day(parseDate('from', q.from, now)) : '0000-01-01';
  const rows = data.store
    .dailyUsage(from, to)
    .filter((row) => (q.tool === undefined || row.tool === q.tool) && (q.platform === undefined || row.platform === q.platform));
  const sum = (pick: (row: (typeof rows)[number]) => number, list = rows): number => list.reduce((total, row) => total + pick(row), 0);
  const calls = sum((row) => row.calls);
  const byTool = new Map<string, typeof rows>();
  for (const row of rows) byTool.set(row.tool, [...(byTool.get(row.tool) ?? []), row]);
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  return checked(usageSchemaResponse, {
    scope: q.scope,
    granularity: 'day',
    since: rows[0] === undefined ? null : `${rows[0].day}T00:00:00.000Z`,
    totals: {
      calls,
      errors: sum((row) => row.errors),
      responseBytes: sum((row) => row.responseBytes),
      estimatedTokens: sum((row) => row.tokens),
      unitsSpent: sum((row) => row.units),
      textAvailableChars: sum((row) => row.textAvailable),
      textReturnedChars: sum((row) => row.textReturned),
      durationP50Ms: null,
      durationP95Ms: null,
      durationMaxMs: rows.length === 0 ? null : Math.max(...rows.map((row) => row.maxDurationMs)),
    },
    byTool: [...byTool.entries()]
      .map(([tool, list]) => {
        const n = sum((row) => row.calls, list);
        return {
          tool,
          platform: list[0]?.platform ?? '',
          calls: n,
          errors: sum((row) => row.errors, list),
          estimatedTokens: sum((row) => row.tokens, list),
          avgTokens: n === 0 ? 0 : Math.round(sum((row) => row.tokens, list) / n),
          avgDurationMs: n === 0 ? null : Math.round(sum((row) => row.durationMs, list) / n),
          maxDurationMs: Math.max(...list.map((row) => row.maxDurationMs)),
          avgUnitsSpent: n === 0 ? 0 : Math.round((sum((row) => row.units, list) / n) * 10) / 10,
        };
      })
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens),
    series: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, list]) => ({
        bucket: `${date}T00:00:00.000Z`,
        calls: sum((row) => row.calls, list),
        errors: sum((row) => row.errors, list),
        estimatedTokens: sum((row) => row.tokens, list),
      })),
  });
}

/** The analytics of the calls in memory (this router's session). */
function getSessionUsage(data: DashboardData, q: z.infer<typeof usageQuery>): Usage {
  const calls = data.callLog
    .all()
    .filter(
      (call) =>
        call.state === 'done' &&
        (q.tool === undefined || call.tool === q.tool) &&
        (q.platform === undefined || call.platform === q.platform),
    );
  const durations = calls.flatMap((call) => (call.durationMs === null ? [] : [call.durationMs])).sort((a, b) => a - b);
  const byTool = new Map<string, CallEntry[]>();
  for (const call of calls) byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
  const buckets = new Map<number, { calls: number; errors: number; tokens: number }>();
  for (const call of calls) {
    const bucket = Math.floor(call.startedAt / HOUR_MS) * HOUR_MS;
    const entry = buckets.get(bucket) ?? { calls: 0, errors: 0, tokens: 0 };
    entry.calls += 1;
    if (call.code !== 'ok') entry.errors += 1;
    entry.tokens += call.estimatedTokens;
    buckets.set(bucket, entry);
  }
  const first = data.callLog.all()[0];
  return checked(usageSchemaResponse, {
    scope: 'session',
    granularity: 'hour',
    since: first === undefined ? null : iso(first.startedAt),
    totals: {
      calls: calls.length,
      errors: calls.filter((call) => call.code !== 'ok').length,
      responseBytes: sum(calls.map((call) => call.responseBytes)),
      estimatedTokens: sum(calls.map((call) => call.estimatedTokens)),
      unitsSpent: sum(calls.map((call) => call.unitsSpent)),
      textAvailableChars: sum(calls.map((call) => call.jobText?.available ?? 0)),
      textReturnedChars: sum(calls.map((call) => call.jobText?.returned ?? 0)),
      durationP50Ms: percentile(durations, 50),
      durationP95Ms: percentile(durations, 95),
      durationMaxMs: durations.at(-1) ?? null,
    },
    byTool: [...byTool.entries()]
      .map(([tool, list]) => {
        const timed = list.flatMap((call) => (call.durationMs === null ? [] : [call.durationMs]));
        return {
          tool,
          platform: list[0]?.platform ?? '',
          calls: list.length,
          errors: list.filter((call) => call.code !== 'ok').length,
          estimatedTokens: sum(list.map((call) => call.estimatedTokens)),
          avgTokens: Math.round(sum(list.map((call) => call.estimatedTokens)) / list.length),
          avgDurationMs: timed.length === 0 ? null : Math.round(sum(timed) / timed.length),
          maxDurationMs: timed.length === 0 ? null : Math.max(...timed),
          avgUnitsSpent: Math.round((sum(list.map((call) => call.unitsSpent)) / list.length) * 10) / 10,
        };
      })
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens),
    series: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucket, entry]) => ({ bucket: iso(bucket), calls: entry.calls, errors: entry.errors, estimatedTokens: entry.tokens })),
  });
}
