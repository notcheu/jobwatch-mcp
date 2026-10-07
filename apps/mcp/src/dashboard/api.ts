import {
  placeLookupsSchema,
  savedPlaceSchema,
  savedPlacesSchema,
  atsLookupsSchema,
  companyBoardSchema,
  companyBoardsSchema,
  callDetailSchema,
  callRowSchema,
  docsSchema,
  callsPageSchema,
  jobDetailSchema,
  jobsPageSchema,
  overviewSchema,
  searchDetailSchema,
  searchesSchema,
  settingsSchema,
  toolsSchema,
  usageSchemaResponse,
  type AtsLookups,
  type PlaceLookups,
  type SavedPlace,
  type SavedPlaces,
  type CompanyBoard,
  type CompanyBoards,
  type CallDetail,
  type Docs,
  type CallsPage,
  type JobDetail,
  type JobsPage,
  type Overview,
  type SearchDetailInfo,
  type Searches,
  type Settings,
  type Tools,
  type Usage,
} from '@jobwatch/dashboard-api';
import { describeInstalledModules } from '@jobwatch/mcp-modules';
import {
  JOB_SORT_COLUMNS,
  createPlatformMemory,
  effectiveRate,
  searchHealth,
  type CallEntry,
  type CompanyBoard as CompanyBoardRow,
  type CallLog,
  type Budgets,
  type CircuitBreaker,
  type InstalledModules,
  type PlatformStatus,
  type RateLimiter,
  type StoredSalary,
  type Registry,
  type RuntimeManager,
  type JobSearch,
  type SearchRef,
  type SearchStat,
  type Store,
} from '@jobwatch/core';
import {
  buildCatalog,
  roleOf,
  savedLocation,
  savedLocations,
  type SavedLocation,
  describeParams,
  extractHints,
  sampleInput,
  summarizeJob,
} from '@jobwatch/sdk';
import { z } from 'zod';

/** What the dashboard reads. Nothing here can start a browser, call a site or spend a rate-limit unit. */
export interface DashboardData {
  version: string;
  clock: () => number;
  store: Store;
  callLog: CallLog;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  budgets: Budgets;
  registry: () => Registry;
  installed: InstalledModules;
  /** `ADAPTERS` pins the list of adapters, `UTILITIES` the list of utilities: each is changed from the environment only. */
  pinned: { adapters: boolean; utilities: boolean };
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
  /** `utility`: the calls of every utility together (the Utility tab). */
  role: z.enum(['utility']).optional(),
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

/** The platforms of the installed utilities (they fetch no jobs): what the dashboard's Utility tab groups. */
async function utilityPlatforms(data: DashboardData): Promise<string[]> {
  const found: string[] = [];
  for (const load of Object.values(data.installed)) {
    const module = await load();
    if (roleOf(module) === 'utility') found.push(module.platform);
  }
  return found;
}

export async function listCalls(data: DashboardData, query: unknown): Promise<CallsPage> {
  const q = callQuery.parse(query);
  const platforms = q.role === 'utility' ? await utilityPlatforms(data) : undefined;
  const page = data.callLog.list({
    limit: q.limit,
    ...(platforms === undefined ? {} : { platforms }),
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

/** The list a query parameter carries, repeated or not, without empty entries. */
const listOf = (value: string | string[] | undefined): string[] =>
  (typeof value === 'string' ? [value] : (value ?? [])).filter((entry) => entry !== '');

/**
 * The search a jobs query asks for, or undefined when it does not filter by search. An empty keyword list (`no_keywords=1`) is the
 * searches with no keyword. Disallowed terms narrow it to one exact search; without them it is any search with these keywords.
 */
function searchFilter(q: {
  found_by?: string | string[] | undefined;
  no_keywords?: '1' | undefined;
  disallowed?: string | string[] | undefined;
  no_disallowed?: '1' | undefined;
}): { keywords: string[]; disallowed?: string[] } | undefined {
  const keywords = q.no_keywords === '1' ? [] : listOf(q.found_by);
  if (q.no_keywords !== '1' && keywords.length === 0) return undefined;
  const disallowed = q.no_disallowed === '1' ? [] : listOf(q.disallowed);
  return q.no_disallowed === '1' || disallowed.length > 0 ? { keywords, disallowed } : { keywords };
}

const jobsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  source: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  board: z.string().max(120).optional(),
  /** Repeated: one entry per keyword of the search (`found_by=react&found_by=vue`). */
  found_by: z.union([z.string().trim().max(100), z.array(z.string().trim().max(100)).max(20)]).optional(),
  /** The searches that had no keyword (a whole company board, the WTTJ matches). */
  no_keywords: z.enum(['1']).optional(),
  /** With found_by: only the search that also had exactly these disallowed terms (repeated, one per term); `no_disallowed=1` for a search with none. */
  disallowed: z.union([z.string().trim().max(100), z.array(z.string().trim().max(100)).max(60)]).optional(),
  no_disallowed: z.enum(['1']).optional(),
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

/** The salary of a stored job, or null. */
function salaryOf(salary: StoredSalary | null) {
  return salary;
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
    ...(searchFilter(q) === undefined ? {} : { search: searchFilter(q) as NonNullable<ReturnType<typeof searchFilter>> }),
    ...(q.sort === undefined ? {} : { sort: q.sort }),
    dir: q.dir,
    offset: (q.page - 1) * q.pageSize,
    limit: q.pageSize,
    withDescription: false,
  });
  const foundBy = new Map<string, SearchRef[]>();
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
      salary: salaryOf(row.salary),
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
    salary: salaryOf(row.salary),
    foundBy: data.store.jobSearches(source, id).map(toJobSearch),
    description: row.description,
    summary: summary.summary,
    summaryKind: summary.kind,
    outline: summary.outline,
    hints: { years: hints.years_hints, remote: hints.remote_hints, salary: hints.salary_text },
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

const searchDetailQuery = z.object({
  since: z.string().max(32).optional(),
  until: z.string().max(32).optional(),
  keywords: z.union([z.string().trim().max(100), z.array(z.string().trim().max(100)).max(20)]).optional(),
  disallowed: z.union([z.string().trim().max(100), z.array(z.string().trim().max(100)).max(60)]).optional(),
});

const toSearchRow = (stat: SearchStat) => ({
  source: stat.platform,
  keywords: stat.keywords,
  disallowed: stat.disallowed,
  runs: stat.runs,
  firstRun: iso(stat.firstRun),
  lastRun: iso(stat.lastRun),
  jobsFound: stat.jobsFound,
  jobsReturned: stat.jobsReturned,
  jobsExcluded: stat.jobsExcluded,
  jobsNew: stat.jobsNew,
  health: searchHealth(stat),
});

/** One search that listed a job: its counts and health, and what it did with that job. */
const toJobSearch = (search: JobSearch) => ({
  keywords: search.keywords,
  disallowed: search.disallowed,
  runs: search.runs,
  lastRun: iso(search.lastRun),
  jobsFound: search.jobsFound,
  jobsReturned: search.jobsReturned,
  jobsExcluded: search.jobsExcluded,
  health: searchHealth(search),
  outcome: search.outcome,
  excludedBy: search.excludedBy,
});

export function listSearches(data: DashboardData, query: unknown): Searches {
  const q = searchesQuery.parse(query);
  const until = parseDate('until', q.until, data.clock() + 1);
  const since = parseDate('since', q.since, until - 7 * DAY_MS);
  const rows = data.store.searchStats({ since, until, ...(q.source === undefined ? {} : { platform: q.source }), limit: 200 });
  return checked(searchesSchema, { searches: rows.map(toSearchRow) });
}

/** The most jobs a search detail lists; the counts are exact whatever is listed. */
const SEARCH_JOBS_LIMIT = 200;

/** One search (a source and its keyword list), with the jobs it listed and how healthy it is. `undefined` when there is no such search. */
export function getSearch(data: DashboardData, source: string, query: unknown): SearchDetailInfo | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(source)) return undefined;
  const q = searchDetailQuery.parse(query);
  const keywords = listOf(q.keywords);
  const disallowed = listOf(q.disallowed);
  const until = parseDate('until', q.until, data.clock() + 1);
  const since = parseDate('since', q.since, until - 7 * DAY_MS);
  const detail = data.store.searchDetail(source, keywords, disallowed, { limit: SEARCH_JOBS_LIMIT + 1, since, until });
  if (detail === null) return undefined;
  const { jobs, ...stat } = detail;
  return checked(searchDetailSchema, {
    ...toSearchRow(stat),
    jobs: jobs.slice(0, SEARCH_JOBS_LIMIT).map((job) => ({
      ...job,
      lastSeen: job.lastSeen === null ? null : iso(job.lastSeen),
    })),
    jobsTruncated: jobs.length > SEARCH_JOBS_LIMIT,
  });
}

// ---------------------------------------------------------------------------------------------------------- ATS discovery

const pageQuery = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
};
const lookupsQuery = z.object(pageQuery);
const companyBoardsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  ats: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  ...pageQuery,
});

export const toCompanyBoard = (row: CompanyBoardRow): CompanyBoard =>
  checked(companyBoardSchema, { id: row.id, company: row.company, ats: row.ats, handle: row.handle, createdAt: iso(row.createdAt) });

/** The past company lookups, newest first; each board found says whether its company is already mapped on that ATS. */
export function listAtsLookups(data: DashboardData, query: unknown): AtsLookups {
  const q = lookupsQuery.parse(query);
  const { rows, total } = data.store.listLookups(q.pageSize, (q.page - 1) * q.pageSize);
  return checked(atsLookupsSchema, {
    total,
    items: rows.map((row) => ({
      id: row.id,
      at: iso(row.ts),
      company: row.company,
      tried: row.tried,
      matches: row.matches.map((match) => ({ ...match, mapped: data.store.findCompanyBoard(row.company, match.ats) !== null })),
    })),
  });
}

/** The companies mapped to a board, A to Z. */
export function listCompanyBoards(data: DashboardData, query: unknown): CompanyBoards {
  const q = companyBoardsQuery.parse(query);
  const { rows, total } = data.store.listCompanyBoards({
    ...(q.q === undefined || q.q === '' ? {} : { q: q.q }),
    ...(q.ats === undefined ? {} : { ats: q.ats }),
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return checked(companyBoardsSchema, { total, items: rows.map(toCompanyBoard) });
}

// ---------------------------------------------------------------------------------------------------------- LinkedIn places

const savedPlacesQuery = z.object({ q: z.string().trim().max(120).optional(), ...pageQuery });

export const toSavedPlace = (place: SavedLocation): SavedPlace =>
  checked(savedPlaceSchema, { alias: place.alias, id: place.id, label: place.label, savedBy: place.by });

/** The past place lookups, newest first; each candidate says whether the name looked up is remembered as it, as another place, or not. */
export async function listPlaceLookups(data: DashboardData, query: unknown): Promise<PlaceLookups> {
  const q = lookupsQuery.parse(query);
  const memory = createPlatformMemory(data.store);
  const { rows, total } = data.store.listPlaceLookups(q.pageSize, (q.page - 1) * q.pageSize);
  const items = [];
  for (const row of rows) {
    const saved = await savedLocation(memory, row.query);
    items.push({
      id: row.id,
      at: iso(row.ts),
      query: row.query,
      hits: row.hits.map((hit) => ({ ...hit, saved: saved === null ? 'none' : saved.id === hit.id ? 'same' : 'other' })),
    });
  }
  return checked(placeLookupsSchema, { total, items });
}

/** The remembered place names, A to Z; `q` keeps those whose name or LinkedIn label contains it. */
export async function listSavedPlaces(data: DashboardData, query: unknown): Promise<SavedPlaces> {
  const q = savedPlacesQuery.parse(query);
  const wanted = (q.q ?? '').toLowerCase();
  const all = (await savedLocations(createPlatformMemory(data.store)))
    .filter(
      (place) => wanted === '' || place.alias.includes(wanted) || place.label.toLowerCase().includes(wanted) || place.id.includes(wanted),
    )
    .sort((a, b) => a.alias.localeCompare(b.alias));
  const start = (q.page - 1) * q.pageSize;
  return checked(savedPlacesSchema, { total: all.length, items: all.slice(start, start + q.pageSize).map(toSavedPlace) });
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
  for (const entry of await describeInstalledModules(data.installed)) {
    const load = data.installed[entry.id];
    if (entry.summary === undefined || load === undefined) continue;
    const module = await load();
    const catalog = buildCatalog(module);
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
      role: entry.summary.role,
      kind: entry.summary.kind,
      enabled: isOn,
      pinned: entry.summary.role === 'utility' ? data.pinned.utilities : data.pinned.adapters,
      hosts: [...entry.summary.allowedHosts],
      tools: catalog.map((tool) => ({
        name: tool.name,
        title: tool.title,
        costMax: tool.limits.rate.cost,
        params: Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      })),
      rateHour: rate?.hour ?? null,
      rateDay: rate?.day ?? null,
      budget: data.budgets.get(entry.id, effectiveRate(module)),
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

// ---------------------------------------------------------------------------------------------------------- docs

/**
 * What the Docs page shows for every installed module, enabled or not: the description, the annotations, the hosts, the arguments
 * read from the tool's JSON Schema, and the worked examples its author wrote. Nothing here comes from the database.
 */
export async function getDocs(data: DashboardData): Promise<Docs> {
  const enabled = new Set(data.registry().enabled.map((adapter) => adapter.id));
  const modules = [];
  for (const entry of await describeInstalledModules(data.installed)) {
    const load = data.installed[entry.id];
    if (entry.summary === undefined || load === undefined) continue;
    const module = await load();
    const catalog = buildCatalog(module);
    modules.push({
      id: entry.id,
      displayName: entry.summary.displayName,
      description: module.description,
      role: entry.summary.role,
      kind: entry.summary.kind,
      enabled: enabled.has(entry.id),
      allowedHosts: [...module.allowedHosts],
      openHttps: module.kind === 'http' && module.openHttps === true,
      tools: catalog.map((tool, index) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: {
          readOnly: tool.annotations.readOnlyHint,
          idempotent: tool.annotations.idempotentHint,
          openWorld: tool.annotations.openWorldHint,
        },
        needsBrowser: tool.needs_browser,
        costMax: tool.limits.rate.cost,
        params: describeParams(tool.inputSchema),
        sampleInput: sampleInput(tool.inputSchema),
        examples: (module.tools[index]?.examples ?? []).map((example) => ({ ...example, input: { ...example.input } })),
      })),
    });
  }
  return checked(docsSchema, { modules });
}

// -------------------------------------------------------------------------------------------------------- overview

export const getSettings = (data: DashboardData): Settings => checked(settingsSchema, data.settings);

/** The searches of the last 7 days in bad health, the ones that waste most first. */
function badSearches(data: DashboardData): { count: number; items: ReturnType<typeof toSearchRow>[] } {
  const now = data.clock();
  const bad = data.store
    .searchStats({ since: now - 7 * DAY_MS, until: now + 1, limit: 200 })
    .map(toSearchRow)
    .filter((row) => row.health.status === 'bad')
    .sort((a, b) => b.health.discardedShare - a.health.discardedShare || b.runs - a.runs);
  return { count: bad.length, items: bad.slice(0, 5) };
}

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
    badSearches: badSearches(data),
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
  /** `utility`: every utility together (the Utility tab). */
  role: z.enum(['utility']).optional(),
});

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The analytics. `session` reads the calls in memory (hourly buckets, with percentiles); `lifetime` and `historical` read the persisted
 * daily totals, which survive a restart (daily buckets; durations are averages and a maximum, since percentiles need every call).
 */
export async function getUsage(data: DashboardData, query: unknown): Promise<Usage> {
  const q = usageQuery.parse(query);
  const platforms = q.role === 'utility' ? await utilityPlatforms(data) : undefined;
  if (q.scope !== 'session') return getPersistedUsage(data, q, platforms);
  return getSessionUsage(data, q, platforms);
}

function getPersistedUsage(data: DashboardData, q: z.infer<typeof usageQuery>, platforms: readonly string[] | undefined): Usage {
  const now = data.clock();
  const to = q.scope === 'historical' && q.to !== undefined && q.to !== '' ? day(parseDate('to', q.to, now)) : day(now);
  const from = q.scope === 'historical' && q.from !== undefined && q.from !== '' ? day(parseDate('from', q.from, now)) : '0000-01-01';
  const rows = data.store
    .dailyUsage(from, to)
    .filter(
      (row) =>
        (q.tool === undefined || row.tool === q.tool) &&
        (q.platform === undefined || row.platform === q.platform) &&
        (platforms === undefined || platforms.includes(row.platform)),
    );
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
function getSessionUsage(data: DashboardData, q: z.infer<typeof usageQuery>, platforms: readonly string[] | undefined): Usage {
  const calls = data.callLog
    .all()
    .filter(
      (call) =>
        call.state === 'done' &&
        (q.tool === undefined || call.tool === q.tool) &&
        (q.platform === undefined || call.platform === q.platform) &&
        (platforms === undefined || platforms.includes(call.platform)),
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
