import {
  Checkpoint,
  JobwatchError,
  SDK_API_VERSION,
  SessionInvalid,
  defineAdapter,
  defineHttpTool,
  z,
  type McpModule,
  type BrowserAdapter,
  type SessionState,
} from '@jobwatch/sdk';
import type { ContextProvider } from '../call';
import type { CircuitBreaker } from '../limits/breaker';
import type { RateLimiter } from '../limits/ratelimit';
import type { EngineLogger } from '../logging';
import type { RuntimeManager } from '../runtime/manager';
import type { Clock, Store } from '../store/store';
import { createStoredJobTextsTool } from './jobTexts';
import { createStoredJobsTool } from './storedJobs';
import { createStoredSearchesTool } from './storedSearches';

export const OPS_ADAPTER_ID = 'ops';
const MIB = 1024 * 1024;
const STATUS_TTL_MS = 10 * 60 * 1000;
const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;

export interface OpsDeps {
  /** The enabled adapters; a getter because the registry that holds the ops tools is built after this object. */
  enabledAdapters: () => readonly McpModule[];
  /** The browser runtime, or a function that returns it (it can appear while the router runs). */
  runtime: RuntimeManager | undefined | (() => RuntimeManager | undefined);
  store: Store;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  contexts: ContextProvider;
  /** Where the last session check of each platform is kept; pass one to read it from elsewhere. */
  sessionCache?: Map<string, PlatformStatus>;
  clock: Clock;
  logger: EngineLogger;
}

/** What `session_status` last found for one platform (also read by the dashboard, which never triggers a check). */
export interface PlatformStatus {
  platform: string;
  logged_in: boolean;
  state: SessionState;
  checked_at: string;
  cached: boolean;
  note?: string;
}

const statusSchema = z.object({
  platform: z.string(),
  logged_in: z.boolean(),
  state: z.enum(['ok', 'needs_login', 'checkpoint', 'unknown']),
  checked_at: z.string(),
  cached: z.boolean(),
  note: z.string().optional(),
});

const memoryReportSchema = z.object({
  generated_at: z.string(),
  process: z.object({ rss_mb: z.number(), heap_used_mb: z.number(), uptime_s: z.number() }),
  runtime: z.object({
    enabled: z.boolean(),
    state: z.string(),
    platform: z.string().optional(),
    uptime_s: z.number().optional(),
    peak_mb: z.number().optional(),
    waiting: z.number(),
  }),
  platforms: z.array(
    z.object({
      platform: z.string(),
      kind: z.enum(['browser', 'http']),
      rate_hour: z.object({ used: z.number(), limit: z.number() }),
      rate_day: z.object({ used: z.number(), limit: z.number() }),
      breaker: z.object({ reason: z.string(), until: z.string().nullable() }).optional(),
      boards: z
        .array(
          z.object({
            board: z.string(),
            rate_hour: z.object({ used: z.number(), limit: z.number() }),
            rate_day: z.object({ used: z.number(), limit: z.number() }),
          }),
        )
        .optional()
        .describe('Company boards used in the last 24 hours with their own budget, most used first (at most 25).'),
    }),
  ),
  recent_calls: z.array(z.object({ at: z.string(), tool: z.string(), outcome: z.string(), duration_ms: z.number() })),
});

/**
 * The built-in `ops` adapter: `session_status` and `memory_report`. Always loaded, even when no adapter is enabled, so the
 * routine can always ask "are you alive and logged in?". They run on their own platform (`ops`), so a platform whose breaker
 * is open does not block them, and they never touch a site whose breaker says a verification is pending.
 */
export function createOpsAdapter(deps: OpsDeps): McpModule {
  const cache = deps.sessionCache ?? new Map<string, PlatformStatus>();
  const sessionAdapters = (): BrowserAdapter[] =>
    deps.enabledAdapters().filter((adapter): adapter is BrowserAdapter => adapter.kind === 'browser' && adapter.sessionCheck !== undefined);

  async function checkOne(adapter: BrowserAdapter): Promise<PlatformStatus> {
    const platform = adapter.platform;
    const now = deps.clock();
    const stamp = new Date(now).toISOString();
    const open = deps.breaker.state(platform);

    // A pending verification must not be provoked by another page load: report it from the breaker, touch nothing.
    if (open?.reason === 'checkpoint') {
      return {
        platform,
        logged_in: false,
        state: 'checkpoint',
        checked_at: stamp,
        cached: true,
        note: `A security verification is pending${open.until ? ` until ${new Date(open.until).toISOString()}` : ''}; the site was not contacted.`,
      };
    }
    const cached = cache.get(platform);
    if (
      cached !== undefined &&
      now - Date.parse(cached.checked_at) < STATUS_TTL_MS &&
      !(open?.reason === 'needs_login' && cached.state === 'ok')
    ) {
      return { ...cached, cached: true };
    }

    let state: SessionState;
    let note: string | undefined;
    try {
      deps.limiter.take(platform, 1);
      const lease = await deps.contexts.acquire(adapter, 'session_status');
      try {
        const sessionCheck = adapter.sessionCheck;
        const ctx = lease.ctx as { session?: Parameters<NonNullable<typeof sessionCheck>>[0] };
        if (sessionCheck === undefined || ctx.session === undefined)
          throw new JobwatchError('internal', 'No browser session is available.');
        const work = sessionCheck(ctx.session);
        const result = await (lease.signal ? raceAbort(work, lease.signal) : work);
        state = result.state;
        note = result.note;
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof Checkpoint) state = 'checkpoint';
      else if (error instanceof SessionInvalid) state = 'needs_login';
      else if (error instanceof JobwatchError) {
        // rate limited, busy, timeout, budget...: not a verdict on the session
        return { platform, logged_in: false, state: 'unknown', checked_at: stamp, cached: false, note: `${error.code}: ${error.message}` };
      } else {
        deps.logger.error({ err: error, platform }, 'session_check_failed');
        return {
          platform,
          logged_in: false,
          state: 'unknown',
          checked_at: stamp,
          cached: false,
          note: 'The session check failed unexpectedly.',
        };
      }
    }

    if (state === 'ok' && open?.reason === 'needs_login') deps.breaker.close(platform);
    else if (state === 'needs_login') deps.breaker.open(platform, 'needs_login');
    else if (state === 'checkpoint') deps.breaker.open(platform, 'checkpoint');

    const status: PlatformStatus = {
      platform,
      logged_in: state === 'ok',
      state,
      checked_at: stamp,
      cached: false,
      ...(note ? { note } : {}),
    };
    // Only a healthy answer is cached: after a lost session the user signs in again and expects the next check to see it.
    if (state === 'ok') cache.set(platform, status);
    else cache.delete(platform);
    return status;
  }

  const sessionStatus = defineHttpTool({
    name: 'session_status',
    title: 'Session status (read-only)',
    description:
      'Reports whether the signed-in browser sessions (for example LinkedIn) are usable: ok, needs_login or checkpoint. May load one page per platform; answers from a 10 minute cache. Read-only, changes no account.',
    input: z
      .object({
        platform: z
          .string()
          .max(32)
          .regex(/^[a-z][a-z0-9-]{0,31}$/),
      })
      .strict(),
    output: z.object({ results: z.array(statusSchema).max(16) }),
    annotations,
    limits: { timeoutS: 90, cost: 1, outputMaxBytes: 16_384 },
    handler: async ({ platform }) => {
      const available = sessionAdapters();
      const targets = platform === 'all' ? available : available.filter((adapter) => adapter.platform === platform);
      if (platform !== 'all' && targets.length === 0) {
        const known = [...new Set(available.map((adapter) => adapter.platform))];
        throw new JobwatchError(
          'invalid_arguments',
          `No enabled adapter with a session for "${platform}". Known: ${known.length === 0 ? 'none' : known.join(', ')}, or "all".`,
        );
      }
      const seen = new Set<string>();
      const results: PlatformStatus[] = [];
      for (const adapter of targets) {
        if (seen.has(adapter.platform)) continue;
        seen.add(adapter.platform);
        results.push(await checkOne(adapter));
      }
      const warnings = results.filter((r) => r.state !== 'ok').map((r) => `${r.platform}: ${r.state}`);
      return { data: { results }, warnings };
    },
  });

  const memoryReport = defineHttpTool({
    name: 'memory_report',
    title: 'Memory and limits report (read-only)',
    description:
      'Reports the router state: browser runtime state and peak memory, rate-limit usage, open circuit breakers and the most recent calls. Read-only, reveals no arguments or credentials.',
    input: z.object({}).strict(),
    output: memoryReportSchema,
    annotations,
    limits: { timeoutS: 10, cost: 1, outputMaxBytes: 32_768 },
    handler: async () => {
      const now = deps.clock();
      const runtime = typeof deps.runtime === 'function' ? deps.runtime() : deps.runtime;
      const status = runtime?.status();
      const current = status?.current;
      const platforms = deps
        .enabledAdapters()
        .reduce<Map<string, McpModule>>(
          (map, adapter) => (map.has(adapter.platform) ? map : map.set(adapter.platform, adapter)),
          new Map(),
        );
      const data = {
        generated_at: new Date(now).toISOString(),
        process: {
          rss_mb: Math.round(process.memoryUsage().rss / MIB),
          heap_used_mb: Math.round(process.memoryUsage().heapUsed / MIB),
          uptime_s: Math.round(process.uptime()),
        },
        runtime: {
          enabled: runtime !== undefined,
          state: current?.state ?? 'cold',
          ...(current ? { platform: current.platform } : {}),
          ...(current?.startedAt ? { uptime_s: Math.round((now - current.startedAt) / 1000) } : {}),
          ...(current ? { peak_mb: Math.round(current.peakBytes / MIB) } : {}),
          waiting: status?.waiting ?? 0,
        },
        platforms: [...platforms.values()].map((adapter) => {
          const rate = deps.limiter.status(adapter.platform);
          const breaker = deps.breaker.state(adapter.platform);
          // The boards of a platform with a budget per board (an ATS), those used in the last 24 hours, busiest first.
          const boards =
            adapter.keyRate === undefined
              ? []
              : deps.store
                  .usageKeys(adapter.platform, now - 24 * 3600 * 1000)
                  .map((board) => ({
                    board,
                    ...(({ hour, day }) => ({ rate_hour: hour, rate_day: day }))(deps.limiter.status(`${adapter.platform}#${board}`)),
                  }))
                  .sort((a, b) => b.rate_day.used - a.rate_day.used || a.board.localeCompare(b.board))
                  .slice(0, 25);
          return {
            platform: adapter.platform,
            kind: adapter.kind,
            rate_hour: rate.hour,
            rate_day: rate.day,
            ...(boards.length > 0 ? { boards } : {}),
            ...(breaker
              ? { breaker: { reason: breaker.reason, until: breaker.until === null ? null : new Date(breaker.until).toISOString() } }
              : {}),
          };
        }),
        recent_calls: deps.store
          .recentCalls(20)
          .map((call) => ({ at: new Date(call.ts).toISOString(), tool: call.tool, outcome: call.outcome, duration_ms: call.durationMs })),
      };
      return { data, warnings: [] };
    },
  });

  return defineAdapter({
    id: OPS_ADAPTER_ID,
    displayName: 'Router operations',
    description:
      'Built-in read-only tools about the router itself: session status, a memory and limits report, and the jobs already stored (a list by date, and their text).',
    sdkApi: SDK_API_VERSION,
    platform: OPS_ADAPTER_ID,
    kind: 'http',
    allowedHosts: ['ops.invalid'],
    tools: [
      sessionStatus,
      memoryReport,
      createStoredJobsTool(deps.store, deps.clock),
      createStoredSearchesTool(deps.store, deps.clock),
      createStoredJobTextsTool(deps.store),
    ],
  });
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const toError = (): Error =>
    signal.reason instanceof Error ? signal.reason : new JobwatchError('internal', 'The browser stopped unexpectedly.');
  if (signal.aborted) return Promise.reject(toError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(toError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
