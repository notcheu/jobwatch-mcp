import { JobwatchError, type AdapterModule, type BaseContext, type BrowserAdapterContext, type HttpClient } from '@jobwatch/sdk';
import type { ContextProvider } from './call';
import { DEFAULT_BROWSER_PACING, NO_PACING, createPacer, type PacerOptions } from './browser/pacer';
import type { ConnectBrowser } from './browser/session';
import { createHttpClient } from './http/client';
import { createAdapterLogger, type EngineLogger } from './logging';
import type { RuntimeManager } from './runtime/manager';

export interface ContextProviderDeps {
  /** Undefined when no browser adapter is enabled. */
  runtime: RuntimeManager | undefined;
  connect: ConnectBrowser;
  logger: EngineLogger;
  /** Overridable for tests. */
  createHttp?: (allowedHosts: readonly string[]) => HttpClient;
  pacerOptions?: PacerOptions;
}

/**
 * Builds the `AdapterContext` of one call. HTTP adapters get an allowlisted `HttpClient`. Browser adapters additionally get
 * the leased single-tab `BrowserSession`; the lease is released (tab parked, connection dropped, runtime handed back) when the
 * call ends, whatever happened. The returned `signal` fires when the runtime dies or is killed for memory.
 */
export function createContextProvider(deps: ContextProviderDeps): ContextProvider {
  const httpClients = new Map<string, HttpClient>();
  const pacers = new Map<string, ReturnType<typeof createPacer>>();

  const httpFor = (adapter: AdapterModule): HttpClient => {
    let client = httpClients.get(adapter.id);
    if (client === undefined) {
      client = (deps.createHttp ?? ((allowedHosts) => createHttpClient({ allowedHosts })))(adapter.allowedHosts);
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
      const base: BaseContext = { http: httpFor(adapter), log: createAdapterLogger(deps.logger, adapter.id), pace: pacerFor(adapter) };
      if (adapter.kind === 'http') return { ctx: base, release: async () => undefined };

      if (deps.runtime === undefined) throw new JobwatchError('internal', 'No browser runtime is available.');
      const budgets = adapter.tools.map((tool) => tool.limits.memory).filter((memory) => memory !== undefined);
      const memory =
        budgets.length === 0
          ? undefined
          : { highMb: Math.max(...budgets.map((b) => b.highMb)), maxMb: Math.max(...budgets.map((b) => b.maxMb)) };
      const lease = await deps.runtime.lease(adapter.platform, memory ? { memory } : {});
      let connection: Awaited<ReturnType<ConnectBrowser>>;
      try {
        connection = await deps.connect(lease.handle.address, adapter.allowedHosts);
      } catch (error) {
        deps.logger.error({ err: error, platform: adapter.platform }, 'browser_connect_failed');
        await lease.release();
        throw new JobwatchError('internal', `Could not connect to the ${adapter.platform} browser.`, {
          details: { platform: adapter.platform },
        });
      }
      const ctx: BrowserAdapterContext = { ...base, session: connection.session };
      return {
        ctx,
        signal: lease.signal,
        release: async () => {
          // Park first so the page's memory is freed even if the next call is a long way off; every step is best-effort.
          await connection.park().catch((error: unknown) => deps.logger.warn({ err: error }, 'park_failed'));
          await connection.disconnect().catch((error: unknown) => deps.logger.warn({ err: error }, 'disconnect_failed'));
          await lease.release();
        },
      };
    },
  };
}
