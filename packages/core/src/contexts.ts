import {
  JobwatchError,
  type AdapterModule,
  type BaseContext,
  type BrowserAdapterContext,
  type BrowserSession,
  type HttpClient,
  type JobStore,
} from '@jobwatch/sdk';
import type { ContextProvider } from './call';
import { DEFAULT_BROWSER_PACING, NO_PACING, createPacer, type PacerOptions } from './browser/pacer';
import type { ConnectBrowser } from './browser/session';
import { createHttpClient } from './http/client';
import { createAdapterLogger, type EngineLogger } from './logging';
import type { RuntimeManager } from './runtime/manager';
import { Store } from './store/store';

/** The units one call has spent. Created per call, read by the engine when the call ends, however it ends. */
interface Meter {
  units: number;
}

export interface ContextProviderDeps {
  /** Undefined when no browser adapter is enabled. */
  runtime: RuntimeManager | undefined;
  connect: ConnectBrowser;
  logger: EngineLogger;
  /** Overridable for tests. */
  createHttp?: (options: { allowedHosts: readonly string[]; openHttps: boolean; onOpenHost: (hostname: string) => void }) => HttpClient;
  pacerOptions?: PacerOptions;
  /** Where adapters remember the jobs they opened. Omitted only in tests: a private in-memory store is used. */
  store?: Store;
  clock?: () => number;
  /** Most tabs the browser may have open at once (`JW_BROWSER_MAX_TABS` when `JW_BROWSER_MULTITAB` is on). Default 1. */
  maxTabs?: number;
}

/** The platform-scoped view of the store an adapter gets as `ctx.jobs`. */
export function createJobStore(store: Store, platform: string, clock: () => number = Date.now): JobStore {
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    known: async (ids) => store.knownJobs(platform, ids),
    get: async (id) => {
      const row = store.getJob(platform, id);
      return row === null
        ? null
        : {
            ...row,
            source: platform,
            board: row.board ?? null,
            firstSeen: iso(row.firstSeen),
            fetchedAt: iso(row.fetchedAt),
            lastSeen: iso(row.lastSeen),
          };
    },
    put: async (job) => store.putJob(platform, job, clock()),
    touch: async (ids) => store.touchJobs(platform, ids, clock()),
  };
}

/**
 * Builds the `AdapterContext` of one call. HTTP adapters get an allowlisted `HttpClient`. Browser adapters additionally get
 * the leased single-tab `BrowserSession`; the lease is released (tab parked, connection dropped, runtime handed back) when the
 * call ends, whatever happened. The returned `signal` fires when the runtime dies or is killed for memory.
 */
export function createContextProvider(deps: ContextProviderDeps): ContextProvider {
  const httpClients = new Map<string, HttpClient>();
  const pacers = new Map<string, ReturnType<typeof createPacer>>();
  const jobStore = deps.store ?? Store.open(':memory:');

  /** Count every request that goes through a client: attempts, not successes (the request may have reached the site). */
  const metered = (client: HttpClient, meter: Meter): HttpClient => ({
    get: (url, request) => {
      meter.units += 1;
      return client.get(url, request);
    },
    postJson: (url, body, request) => {
      meter.units += 1;
      return client.postJson(url, body, request);
    },
  });

  const httpFor = (adapter: AdapterModule): HttpClient => {
    let client = httpClients.get(adapter.id);
    if (client === undefined) {
      const openHttps = adapter.kind === 'http' && adapter.openHttps === true;
      const options = {
        allowedHosts: adapter.allowedHosts,
        openHttps,
        // Audit trail: which hosts outside the listed ones an open adapter reached (host only, never the path or the query).
        onOpenHost: (hostname: string) => deps.logger.info({ adapter: adapter.id, host: hostname }, 'open_https_request'),
      };
      client = (deps.createHttp ?? ((o) => createHttpClient(o)))(options);
      httpClients.set(adapter.id, client);
    }
    return client;
  };
  const pacerFor = (adapter: AdapterModule) => {
    let pacer = pacers.get(adapter.id);
    if (pacer === undefined) {
      pacer = createPacer(adapter.pacing ?? (adapter.kind === 'browser' ? DEFAULT_BROWSER_PACING : NO_PACING), deps.pacerOptions);
      pacers.set(adapter.id, pacer);
    }
    return pacer;
  };

  return {
    async acquire(adapter, _requestId) {
      const meter: Meter = { units: 0 };
      const spent = (): number => meter.units;
      const base: BaseContext = {
        http: metered(httpFor(adapter), meter),
        spend: (units = 1) => {
          if (!Number.isInteger(units) || units < 1) throw new RangeError('spend takes a positive whole number of units');
          meter.units += units;
        },
        jobs: createJobStore(jobStore, adapter.platform, deps.clock),
        log: createAdapterLogger(deps.logger, adapter.id),
        pace: pacerFor(adapter),
      };
      if (adapter.kind === 'http') return { ctx: base, release: async () => undefined, spent };

      if (deps.runtime === undefined) throw new JobwatchError('internal', 'No browser runtime is available.');
      const budgets = adapter.tools.map((tool) => tool.limits.memory).filter((memory) => memory !== undefined);
      const memory =
        budgets.length === 0
          ? undefined
          : { highMb: Math.max(...budgets.map((b) => b.highMb)), maxMb: Math.max(...budgets.map((b) => b.maxMb)) };
      const lease = await deps.runtime.lease(adapter.platform, memory ? { memory } : {});
      let connection: Awaited<ReturnType<ConnectBrowser>>;
      try {
        connection = await deps.connect(lease.handle.address, adapter.allowedHosts, { maxTabs: deps.maxTabs ?? 1 });
      } catch (error) {
        deps.logger.error({ err: error, platform: adapter.platform }, 'browser_connect_failed');
        await lease.release();
        throw new JobwatchError('internal', `Could not connect to the ${adapter.platform} browser.`, {
          details: { platform: adapter.platform },
        });
      }
      // every page load is a unit: the session the adapter sees counts them
      const counted = countPageLoads(connection.session, meter);
      const ctx: BrowserAdapterContext = { ...base, session: counted };
      return {
        ctx,
        spent,
        signal: lease.signal,
        release: async () => {
          if (adapter.keepSessionCookies === true) {
            await connection
              .keepSessionCookies()
              .then((count) => deps.logger.debug({ platform: adapter.platform, count }, 'session_cookies_kept'))
              .catch((error: unknown) => deps.logger.warn({ err: error }, 'keep_session_cookies_failed'));
          }
          // Park first so the page's memory is freed even if the next call is a long way off; every step is best-effort.
          await connection.park().catch((error: unknown) => deps.logger.warn({ err: error }, 'park_failed'));
          await connection.disconnect().catch((error: unknown) => deps.logger.warn({ err: error }, 'disconnect_failed'));
          await lease.release();
        },
      };
    },
  };
}

/** The session with every page load counted on the meter; a tab opened from it is counted the same way. */
function countPageLoads<S extends BrowserSession>(session: S, meter: Meter): S {
  const goto = session.goto.bind(session);
  const openTab = session.openTab.bind(session);
  return Object.assign(Object.create(Object.getPrototypeOf(session) as object) as S, session, {
    goto: (url: string, options: Parameters<S['goto']>[1]) => {
      meter.units += 1;
      return goto(url, options);
    },
    openTab: async () => countPageLoads(await openTab(), meter),
  });
}
