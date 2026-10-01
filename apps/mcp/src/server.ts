import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  CircuitBreaker,
  ConfigError,
  DockerCliBackend,
  RateLimiter,
  RegistryError,
  RuntimeManager,
  Store,
  StoreError,
  createGuard,
  createLogger,
  createMetrics,
  describeConfig,
  loadAdapters,
  loadConfig,
  noRuntime,
  policyFor,
  resolveEnabledAdapters,
  type Clock,
  type ContextProvider,
  type InstalledAdapters,
  type RuntimeBackend,
  type RuntimeHooks,
} from '@jobwatch/core';
import { installed } from '@jobwatch/adapters';
import { createApp } from './app';
import { createMetricsServer } from './metrics-server';

/** The call log keeps 30 days and usage events 2 days: tidy up at startup and every six hours. */
const PRUNE_INTERVAL_MS = 6 * 3600 * 1000;

export interface RunningServer {
  /** The persistent state (usage, breakers, call log). Exposed for tests and for the CLI-style commands of later steps. */
  store: Store;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  /** Present only when a browser adapter is enabled. */
  runtime: RuntimeManager | undefined;
  /** The MCP listener. */
  mcp: HttpServer;
  /** The metrics listener, when enabled. */
  metrics: HttpServer | undefined;
  /** Stop accepting connections and wait for in-flight requests (force after `graceMs`). */
  close(graceMs?: number): Promise<void>;
}

export interface StartOptions {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  /** Tests inject their own installed table and context provider. */
  installed?: InstalledAdapters;
  contexts?: ContextProvider;
  /** Where log lines go; defaults to stdout. */
  logDestination?: NodeJS.WritableStream;
  /** Container runtime for browser adapters; tests pass a fake. Defaults to the docker CLI. */
  runtimeBackend?: RuntimeBackend;
  /** Browser-layer hooks (DevTools readiness, quit, memory shedding): wired in step 6. */
  runtimeHooks?: RuntimeHooks;
  /** Time source for rate limits and breakers; tests pass a controllable one. */
  clock?: Clock;
  /** Overrides JW_PORT (tests pass 0 for a free port). */
  port?: number;
  metricsPort?: number;
}

const listen = (server: HttpServer, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

const closeServer = (server: HttpServer, graceMs: number): Promise<void> =>
  new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });

/**
 * Validate the configuration, load the enabled adapters, and start listening. Fails fast: a bad configuration or a
 * broken enabled adapter stops the process at startup with every problem listed, instead of serving a partial catalog.
 */
export async function start(options: StartOptions): Promise<RunningServer> {
  const { config, warnings } = loadConfig(options.env);
  const logger = createLogger({ level: config.logLevel, ...(options.logDestination ? { destination: options.logDestination } : {}) });
  for (const warning of warnings) logger.warn(warning);
  logger.info({ config: describeConfig(config) }, 'config_loaded');

  const enabled = await resolveEnabledAdapters(config);
  const registry = await loadAdapters(enabled.ids, options.installed ?? installed);
  logger.info({ enabled: enabled.ids, source: enabled.source, tools: [...registry.tools.keys()] }, 'adapters_loaded');
  if (enabled.ids.length === 0)
    logger.warn('No adapters are enabled: the tool list is empty. Enable one with `jobwatch adapters enable <id>`.');
  if (config.auth === 'front' && config.frontSharedSecret === undefined) {
    logger.warn('JW_FRONT_SHARED_SECRET is not set: relying on network isolation, only the OAuth front may reach this port.');
  }
  if (config.auth === 'none') logger.warn('JW_AUTH=none: no authentication. Local development only; never expose this port.');

  const metrics = config.metrics.enabled ? createMetrics({ version: options.version }) : undefined;
  metrics?.setEnabledAdapters(registry.adapters.length);

  // Persistent state. Fails fast (the process exits) when the database cannot be opened: running without a rate limiter or
  // breaker would mean nothing stops us from hammering a platform after a checkpoint.
  const clock = options.clock ?? Date.now;
  const store = Store.open(config.dbPath);
  const breaker = new CircuitBreaker(store, clock, (platform, row) => {
    metrics?.setBreaker(platform, row?.reason);
    if (row !== undefined)
      logger.warn({ platform, reason: row.reason, until: row.until === null ? null : new Date(row.until).toISOString() }, 'breaker_opened');
    else logger.info({ platform }, 'breaker_closed');
  });
  const limiter = new RateLimiter(store, clock, policyFor(registry.adapters));
  for (const open of breaker.all()) {
    metrics?.setBreaker(open.platform, open.reason);
    logger.warn({ platform: open.platform, reason: open.reason, since: new Date(open.openedAt).toISOString() }, 'breaker_still_open');
  }
  const pruneNow = (): void => {
    try {
      const removed = store.prune(clock());
      if (removed.calls > 0 || removed.usage > 0) logger.info(removed, 'pruned');
    } catch (error) {
      logger.error({ err: error }, 'prune_failed');
    }
  };
  pruneNow();
  const pruneTimer = setInterval(pruneNow, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  // The browser runtime exists only when an enabled adapter needs one: a router with HTTP adapters only never touches docker.
  const needsBrowser = registry.adapters.some((adapter) => adapter.kind === 'browser');
  let runtime: RuntimeManager | undefined;
  if (needsBrowser) {
    runtime = new RuntimeManager(
      options.runtimeBackend ?? new DockerCliBackend(undefined, config.browserNetwork),
      {
        image: config.browserImage,
        network: config.browserNetwork,
        ...(config.browserSeccomp ? { seccompProfile: config.browserSeccomp } : {}),
        profileVolumePrefix: config.profileVolumePrefix,
        idleTtlS: config.idleTtlS,
        maxLifetimeS: config.maxLifetimeS,
        queueTimeoutS: config.queueTimeoutS,
        memMaxMb: config.memMaxMb,
        memHighMb: config.memHighMb,
      },
      logger,
      options.runtimeHooks,
      (event) => metrics?.recordRuntime(event),
    );
    // Containers left by a previous router (crash, kill -9) would hold RAM and a profile lock. A docker that is not reachable
    // is logged, not fatal: the router comes up and every browser call fails with a clear error until docker is back.
    await runtime.reapOrphans().catch((error: unknown) => logger.error({ err: error }, 'orphan_reap_failed'));
  }

  const app = createApp({
    registry,
    contexts: options.contexts ?? noRuntime,
    logger,
    metrics,
    version: options.version,
    config,
    guard: createGuard(limiter, breaker),
    record: (outcome) =>
      store.recordCall({
        ts: clock(),
        requestId: outcome.requestId,
        tool: outcome.tool,
        adapter: outcome.adapter,
        platform: outcome.platform,
        outcome: outcome.code,
        durationMs: outcome.durationMs,
        argsHash: outcome.argsHash,
      }),
  });
  const mcpServer = createHttpServer(app);
  await listen(mcpServer, options.port ?? config.port, config.listenHost);

  const metricsServer = metrics ? createMetricsServer(metrics) : undefined;
  if (metricsServer) await listen(metricsServer, options.metricsPort ?? config.metrics.port, config.listenHost);

  const address = mcpServer.address();
  logger.info(
    { port: typeof address === 'object' && address ? address.port : config.port, metrics: metricsServer !== undefined },
    'listening',
  );

  let closing: Promise<void> | undefined;
  return {
    store,
    limiter,
    breaker,
    runtime,
    mcp: mcpServer,
    metrics: metricsServer,
    close: (graceMs = 10_000) => {
      closing ??= (async () => {
        clearInterval(pruneTimer);
        await runtime?.shutdown();
        await Promise.all([closeServer(mcpServer, graceMs), metricsServer ? closeServer(metricsServer, graceMs) : Promise.resolve()]);
        store.close();
        logger.info('stopped');
      })();
      return closing;
    },
  };
}

/** Print configuration and registry problems as readable text. Returns true when the error was one of those. */
export function reportStartupError(error: unknown, write: (text: string) => void): boolean {
  if (error instanceof ConfigError || error instanceof RegistryError || error instanceof StoreError) {
    write(`${error.message}\n`);
    return true;
  }
  return false;
}
