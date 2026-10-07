import { z } from 'zod';

/**
 * The response types of the dashboard API (docs/plans/17-dashboard.md, sections 3 and 5). They are the only shapes that leave the
 * router for the dashboard: a database row is never serialised as it is. Every object is `.strict()` so that a field added by
 * mistake fails the contract test instead of leaking.
 */

const iso = z.string().describe('ISO 8601 date-time, UTC');

export const API_PREFIX = '/dashboard/api/v1';

// ------------------------------------------------------------------------------------------------------ session

export const meSchema = z
  .object({
    /** `local`: the router runs for local development and the dashboard asks for no sign-in. */
    mode: z.enum(['google', 'local']),
    email: z.string().nullable(),
    /** When the last sign-in happened; writes need a recent one. */
    signedInAt: iso.nullable(),
    /** The session ends at this time at the latest. */
    expiresAt: iso.nullable(),
    /** The dashboard stops itself at this time unless it is used. */
    idleStopAt: iso.nullable(),
    /** A write is accepted without signing in again until this time. */
    writableUntil: iso.nullable(),
    version: z.string(),
  })
  .strict();
export type Me = z.infer<typeof meSchema>;

// ------------------------------------------------------------------------------------------------------ calls

export const callRowSchema = z
  .object({
    id: z.number(),
    requestId: z.string(),
    tool: z.string(),
    platform: z.string(),
    state: z.enum(['running', 'done']),
    code: z.string().nullable(),
    startedAt: iso,
    durationMs: z.number().nullable(),
    unitsReserved: z.number(),
    unitsSpent: z.number(),
    responseBytes: z.number(),
    estimatedTokens: z.number(),
    warnings: z.number(),
    /** The keywords of a search call, one entry each; null when the call is not a search. */
    keywords: z.array(z.string()).nullable(),
  })
  .strict();
export type CallRow = z.infer<typeof callRowSchema>;

export const callsPageSchema = z.object({ calls: z.array(callRowSchema), total: z.number(), next: z.number().nullable() }).strict();
export type CallsPage = z.infer<typeof callsPageSchema>;

/** One call in full. Only this response carries the parameters. */
export const callDetailSchema = callRowSchema
  .extend({
    adapter: z.string(),
    argsHash: z.string().nullable(),
    params: z.record(z.string(), z.unknown()).nullable(),
    paramsTruncated: z.boolean(),
    paramsDropped: z.boolean(),
    jobText: z.object({ available: z.number(), returned: z.number() }).strict().nullable(),
  })
  .strict();
export type CallDetail = z.infer<typeof callDetailSchema>;

// ------------------------------------------------------------------------------------------------------ jobs

/** The yearly salary read from the job text: a fixed amount (`min` equals `max`) or a range. The browser formats it in its own locale. */
export const salarySchema = z.object({ min: z.number(), max: z.number(), currency: z.string(), variable: z.number().nullable() }).strict();
export type SalaryInfo = z.infer<typeof salarySchema>;

/** How well a search does: `bad` says why (no result at all, or most of what it lists is dropped by disallowed terms or the salary floor). */
export const searchHealthSchema = z
  .object({
    status: z.enum(['good', 'bad']),
    issues: z.array(z.enum(['no_results', 'mostly_discarded'])),
    /** Jobs dropped by disallowed terms or the salary floor, as a share of the jobs listed (0 to 1). */
    discardedShare: z.number(),
  })
  .strict();
export type SearchHealthInfo = z.infer<typeof searchHealthSchema>;

/** A search is its keywords and its disallowed terms: the same keywords with other terms keeps other jobs. */
export const searchRefSchema = z.object({ keywords: z.array(z.string()), disallowed: z.array(z.string()) }).strict();
export type SearchRef = z.infer<typeof searchRefSchema>;

/** Why a job was dropped: the term, and where it matched (for `salary`, the salary the job states). */
export const excludedBySchema = z.object({ reason: z.enum(['title', 'description', 'salary']), term: z.string() }).strict();
export type ExcludedByInfo = z.infer<typeof excludedBySchema>;

/** A search that listed a job, summarised: its counts and health, and what it did with this job. */
export const jobSearchSchema = searchRefSchema
  .extend({
    /** returned: this job was handed back. excluded: dropped by a disallowed term or the salary floor. other: matched but not returned. */
    outcome: z.enum(['returned', 'excluded', 'other']),
    excludedBy: excludedBySchema.nullable(),
  })
  .strict();
export type JobSearch = z.infer<typeof jobSearchSchema>;

export const jobRowSchema = z
  .object({
    source: z.string(),
    id: z.string(),
    board: z.string().nullable(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string(),
    firstSeen: iso,
    fetchedAt: iso,
    lastSeen: iso,
    descriptionChars: z.number(),
    salary: salarySchema.nullable(),
    /** The searches that listed the job (an empty keyword list is a search without keywords). */
    foundBy: z.array(searchRefSchema),
  })
  .strict();
export type JobRow = z.infer<typeof jobRowSchema>;

export const jobsPageSchema = z.object({ jobs: z.array(jobRowSchema), total: z.number(), page: z.number(), pageSize: z.number() }).strict();
export type JobsPage = z.infer<typeof jobsPageSchema>;

export const jobDetailSchema = jobRowSchema
  .extend({
    /** The searches that listed the job, with the counts of each and what happened to this job in it. */
    foundBy: z.array(jobSearchSchema),
    description: z.string(),
    summary: z.string(),
    summaryKind: z.enum(['sections', 'excerpt']).nullable(),
    outline: z.array(z.object({ part: z.string(), chars: z.number() }).strict()),
    hints: z
      .object({
        years: z.array(z.number()),
        remote: z.array(z.string()),
        salary: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type JobDetail = z.infer<typeof jobDetailSchema>;

// ------------------------------------------------------------------------------------------------------ searches

export const searchRowSchema = z
  .object({
    source: z.string(),
    /** The keywords of the search, lower case and sorted (any of them matches); empty for a search without keywords. */
    keywords: z.array(z.string()),
    /** Its disallowed terms, lower case and sorted; empty when it had none. */
    disallowed: z.array(z.string()),
    runs: z.number(),
    firstRun: iso,
    lastRun: iso,
    jobsFound: z.number(),
    jobsReturned: z.number(),
    /** Dropped because of a disallowed term or a salary floor. */
    jobsExcluded: z.number(),
    jobsNew: z.number(),
    health: searchHealthSchema,
  })
  .strict();
export type SearchRow = z.infer<typeof searchRowSchema>;

export const searchJobSchema = z
  .object({
    id: z.string(),
    /** The stored job's title, else the one recorded when the search dropped it; null when neither exists. */
    title: z.string().nullable(),
    /** False when the job's text is not in the database (dropped before its page was read, or evicted): there is no job page to open. */
    stored: z.boolean(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string().nullable(),
    lastSeen: iso.nullable(),
    /** returned: handed back to Claude. excluded: dropped by a disallowed term or the salary floor. other: listed but not returned (a limit, only_new, a filter). */
    outcome: z.enum(['returned', 'excluded', 'other']),
    /** For an excluded job: the term that dropped it and where it was found; null when the search did not record it. */
    excludedBy: excludedBySchema.nullable(),
    timesListed: z.number(),
  })
  .strict();
export type SearchJob = z.infer<typeof searchJobSchema>;

export const searchDetailSchema = searchRowSchema
  .extend({
    jobs: z.array(searchJobSchema),
    /** True when the list holds only the first jobs of a longer one. */
    jobsTruncated: z.boolean(),
  })
  .strict();
export type SearchDetailInfo = z.infer<typeof searchDetailSchema>;
export const searchesSchema = z.object({ searches: z.array(searchRowSchema) }).strict();
export type Searches = z.infer<typeof searchesSchema>;

// ------------------------------------------------------------------------------------------------------ tools and status

const usageSchema = z.object({ used: z.number(), limit: z.number() }).strict();

/** One window of a module's budget: what applies, where it comes from, and the variable that would pin it (it wins over the rest). */
export const budgetValueSchema = z
  .object({
    value: z.number(),
    source: z.enum(['env', 'config', 'default']),
    /** What it is when nothing is set: the defaults file, else what the module declares. */
    default: z.number(),
    envVar: z.string(),
  })
  .strict();
export type BudgetValue = z.infer<typeof budgetValueSchema>;
export const budgetSchema = z.object({ hourly: budgetValueSchema, daily: budgetValueSchema }).strict();
export type Budget = z.infer<typeof budgetSchema>;
export const budgetUpdatedSchema = z.object({ id: z.string(), budget: budgetSchema }).strict();
export type BudgetUpdated = z.infer<typeof budgetUpdatedSchema>;

export const toolStateSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    platform: z.string(),
    /** An adapter fetches jobs; a utility is a helper tool that fetches none (it has a budget all the same). */
    role: z.enum(['adapter', 'utility']),
    kind: z.enum(['browser', 'http']),
    enabled: z.boolean(),
    /** True when ADAPTERS (for an adapter) or UTILITIES (for a utility) pins the list: the switch is disabled, the page says why. */
    pinned: z.boolean(),
    hosts: z.array(z.string()),
    tools: z.array(z.object({ name: z.string(), title: z.string(), costMax: z.number(), params: z.array(z.string()) }).strict()),
    rateHour: usageSchema.nullable(),
    rateDay: usageSchema.nullable(),
    /** The request budget, enabled or not. */
    budget: budgetSchema,
    boards: z.array(z.object({ board: z.string(), rateHour: usageSchema, rateDay: usageSchema }).strict()),
    breaker: z.object({ reason: z.string(), until: iso.nullable() }).strict().nullable(),
    /** What the last `session_status` found, if it ran; the dashboard never runs a check. */
    session: z
      .object({ state: z.enum(['ok', 'needs_login', 'checkpoint', 'unknown']), checkedAt: iso, note: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type ToolState = z.infer<typeof toolStateSchema>;

export const toolsSchema = z
  .object({
    adapters: z.array(toolStateSchema),
    runtime: z
      .object({
        enabled: z.boolean(),
        state: z.string(),
        platform: z.string().nullable(),
        peakMb: z.number().nullable(),
        waiting: z.number(),
      })
      .strict(),
  })
  .strict();
export type Tools = z.infer<typeof toolsSchema>;

// ------------------------------------------------------------------------------------------------------ docs

export const paramDocSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    default: z.unknown(),
    enum: z.array(z.string()).nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    description: z.string(),
  })
  .strict();
export type ParamDoc = z.infer<typeof paramDocSchema>;

export const toolExampleSchema = z.object({ title: z.string(), prompt: z.string(), input: z.record(z.string(), z.unknown()) }).strict();
export type ToolExample = z.infer<typeof toolExampleSchema>;

export const toolDocSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    annotations: z.object({ readOnly: z.boolean(), idempotent: z.boolean(), openWorld: z.boolean() }).strict(),
    needsBrowser: z.boolean(),
    /** Budget units one call reserves at most. */
    costMax: z.number(),
    params: z.array(paramDocSchema),
    /** The smallest accepted input: the required arguments with placeholders. */
    sampleInput: z.record(z.string(), z.unknown()),
    examples: z.array(toolExampleSchema),
  })
  .strict();
export type ToolDoc = z.infer<typeof toolDocSchema>;

export const moduleDocSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    description: z.string(),
    role: z.enum(['adapter', 'utility']),
    kind: z.enum(['browser', 'http']),
    /** Whether the router currently plugs it in: the page only shows it, it cannot change it. */
    enabled: z.boolean(),
    allowedHosts: z.array(z.string()),
    /** An HTTP module that may reach any public https host. */
    openHttps: z.boolean(),
    tools: z.array(toolDocSchema),
  })
  .strict();
export type ModuleDoc = z.infer<typeof moduleDocSchema>;

export const docsSchema = z.object({ modules: z.array(moduleDocSchema) }).strict();
export type Docs = z.infer<typeof docsSchema>;

// ------------------------------------------------------------------------------------------------------ changes

export const adapterToggleSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    /** The list of enabled adapters after the change. */
    enabledAdapters: z.array(z.string()),
    addedTools: z.array(z.string()),
    removedTools: z.array(z.string()),
    /** The server is stateless: Claude sees the new tool list when its connector refreshes or reconnects. */
    reconnectNeeded: z.boolean(),
  })
  .strict();
export type AdapterToggle = z.infer<typeof adapterToggleSchema>;

/** What clearing an adapter's stored data removed. */
export const dataClearedSchema = z.object({ id: z.string(), jobs: z.number(), searches: z.number() }).strict();
export type DataCleared = z.infer<typeof dataClearedSchema>;

export const restartSchema = z.object({ restarting: z.boolean() }).strict();
export type Restart = z.infer<typeof restartSchema>;

// ------------------------------------------------------------------------------------------------------ ATS discovery

/** The ATS a company can be mapped to: the ones the company-board tools read. */
export const ATS_IDS = ['greenhouse', 'lever', 'ashby', 'teamtailor'] as const;
export const atsSchema = z.enum(ATS_IDS);
export type Ats = z.infer<typeof atsSchema>;

/** A company lookup (`ats_find`): what was tried and the boards found. `mapped`: the company already has a board on that ATS. */
export const atsLookupSchema = z
  .object({
    id: z.number(),
    at: z.string(),
    company: z.string(),
    tried: z.array(z.string()),
    matches: z.array(
      z.object({ ats: z.string(), handle: z.string(), jobs: z.number(), boardUrl: z.string(), mapped: z.boolean() }).strict(),
    ),
  })
  .strict();
export type AtsLookup = z.infer<typeof atsLookupSchema>;
export const atsLookupsSchema = z.object({ items: z.array(atsLookupSchema), total: z.number() }).strict();
export type AtsLookups = z.infer<typeof atsLookupsSchema>;

/** A company the operator mapped to its board on an ATS. */
export const companyBoardSchema = z
  .object({ id: z.number(), company: z.string(), ats: z.string(), handle: z.string(), createdAt: z.string() })
  .strict();
export type CompanyBoard = z.infer<typeof companyBoardSchema>;
export const companyBoardsSchema = z.object({ items: z.array(companyBoardSchema), total: z.number() }).strict();
export type CompanyBoards = z.infer<typeof companyBoardsSchema>;
export const companyBoardRemovedSchema = z.object({ id: z.number() }).strict();

// ------------------------------------------------------------------------------------------------------ LinkedIn places

/**
 * A lookup of a place (a `linkedin_locations` query, or a search that looked a name up by itself) with what LinkedIn suggested. Per
 * candidate, `saved` says what the name is remembered as: `none`, `same` (this candidate), or `other` (another place).
 */
export const placeLookupSchema = z
  .object({
    id: z.number(),
    at: z.string(),
    query: z.string(),
    hits: z.array(z.object({ id: z.string(), label: z.string(), saved: z.enum(['none', 'same', 'other']) }).strict()),
  })
  .strict();
export const placeLookupsSchema = z.object({ items: z.array(placeLookupSchema), total: z.number() }).strict();
export type PlaceLookups = z.infer<typeof placeLookupsSchema>;

/** A name remembered for a LinkedIn place: by the operator, or by a search that looked it up (`auto`). */
export const savedPlaceSchema = z
  .object({ alias: z.string(), id: z.string(), label: z.string(), savedBy: z.enum(['operator', 'auto']) })
  .strict();
export type SavedPlace = z.infer<typeof savedPlaceSchema>;
export const savedPlacesSchema = z.object({ items: z.array(savedPlaceSchema), total: z.number() }).strict();
export type SavedPlaces = z.infer<typeof savedPlacesSchema>;
export const savedPlaceRemovedSchema = z.object({ alias: z.string() }).strict();

// ------------------------------------------------------------------------------------------------------ custom adapters

/** The handle of a custom adapter: its module id is `custom-<handle>`, its tool `custom_<handle>`. */
export const customHandleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,23}$/, '2 to 24 lower-case letters and digits, starting with a letter');

/** An adapter written on the dashboard. The script is only in the detail, never in the list. */
export const customAdapterSchema = z
  .object({
    handle: z.string(),
    id: z.string(),
    tool: z.string(),
    name: z.string(),
    kind: z.enum(['http', 'browser']),
    url: z.string(),
    host: z.string(),
    enabled: z.boolean(),
    /** Why it is not loaded although it is enabled (a bad address, an invalid definition); null when it is fine or off. */
    problem: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type CustomAdapter = z.infer<typeof customAdapterSchema>;

export const customAdaptersSchema = z
  .object({
    /** `CUSTOM_ADAPTERS=on`. When off, nothing here is loaded and every change is refused. */
    available: z.boolean(),
    sandbox: z.enum(['docker', 'process']),
    items: z.array(customAdapterSchema),
  })
  .strict();
export type CustomAdapters = z.infer<typeof customAdaptersSchema>;

export const customAdapterDetailSchema = customAdapterSchema
  .extend({
    script: z.string(),
    /** Who changed it and what they did, newest first. The script itself is never in it, only its hash. */
    events: z.array(z.object({ at: z.string(), actor: z.string(), action: z.string(), sha256: z.string().nullable() }).strict()),
  })
  .strict();
export type CustomAdapterDetail = z.infer<typeof customAdapterDetailSchema>;

/** One attribute, method or global in the reference next to the editor. */
export const docItemSchema = z
  .object({
    name: z.string(),
    /** Short, for the collapsed row. */
    type: z.string(),
    /** In full, for the expanded row; the short one when omitted. */
    fullType: z.string().optional(),
    description: z.string(),
    optional: z.boolean().optional(),
  })
  .strict();
/** An object or type a script works with, as a table of its attributes. */
export const docBlockSchema = z.object({ id: z.string(), title: z.string(), summary: z.string(), items: z.array(docItemSchema) }).strict();
export type DocBlock = z.infer<typeof docBlockSchema>;
export type DocItem = z.infer<typeof docItemSchema>;

/** What the editor starts from for a kind of context: the script, and the reference to read beside it. */
export const customAdapterSampleSchema = z
  .object({ kind: z.enum(['http', 'browser']), script: z.string(), docs: z.array(docBlockSchema) })
  .strict();
export type CustomAdapterSample = z.infer<typeof customAdapterSampleSchema>;
export const customAdapterRemovedSchema = z.object({ handle: z.string() }).strict();

// ------------------------------------------------------------------------------------------------------ overview and usage

export const overviewSchema = z
  .object({
    version: z.string(),
    uptimeS: z.number(),
    health: z.object({ completed: z.number(), failed: z.number(), rateLimited: z.number(), active: z.number() }).strict(),
    tokensReturned: z.number(),
    callsInMemory: z.number(),
    callBufferSize: z.number(),
    storedJobs: z.number(),
    runtimeState: z.string(),
    enabledAdapters: z.number(),
    /** Searches of the last 7 days in bad health: how many, and the worst ones first. */
    badSearches: z.object({ count: z.number(), items: z.array(searchRowSchema) }).strict(),
  })
  .strict();
export type Overview = z.infer<typeof overviewSchema>;

export const usageSchemaResponse = z
  .object({
    /** session: the calls in memory; lifetime and historical: the persisted daily totals (no percentiles, no per-call data). */
    scope: z.enum(['session', 'lifetime', 'historical']),
    granularity: z.enum(['hour', 'day']),
    since: iso.nullable(),
    totals: z
      .object({
        calls: z.number(),
        errors: z.number(),
        responseBytes: z.number(),
        estimatedTokens: z.number(),
        unitsSpent: z.number(),
        textAvailableChars: z.number(),
        textReturnedChars: z.number(),
        durationP50Ms: z.number().nullable(),
        durationP95Ms: z.number().nullable(),
        durationMaxMs: z.number().nullable(),
      })
      .strict(),
    byTool: z.array(
      z
        .object({
          tool: z.string(),
          platform: z.string(),
          calls: z.number(),
          errors: z.number(),
          estimatedTokens: z.number(),
          avgTokens: z.number(),
          avgDurationMs: z.number().nullable(),
          maxDurationMs: z.number().nullable(),
          avgUnitsSpent: z.number(),
        })
        .strict(),
    ),
    series: z.array(z.object({ bucket: iso, calls: z.number(), errors: z.number(), estimatedTokens: z.number() }).strict()),
  })
  .strict();
export type Usage = z.infer<typeof usageSchemaResponse>;

// ------------------------------------------------------------------------------------------------------ settings

/** The limits that are in force, read only. Nothing here is a secret: the Google client secret and every token are left out. */
export const settingsSchema = z
  .object({
    signIn: z.enum(['google', 'none']),
    idleStopMinutes: z.number(),
    sessionMaxHours: z.number(),
    writeWindowMinutes: z.number(),
    callBuffer: z.number(),
    charsPerToken: z.number(),
    jobRetentionDays: z.number(),
    /** Days a call is kept in the call log, parameters included, before it is deleted. */
    callLogRetentionDays: z.number(),
    maxTabs: z.number(),
    browser: z.object({ idleStopSeconds: z.number(), memoryHighMb: z.number(), memoryMaxMb: z.number() }).strict(),
    adaptersPinned: z.boolean(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

// ------------------------------------------------------------------------------------------------------ errors

export const apiErrorSchema = z.object({ error: z.string(), message: z.string() }).strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
