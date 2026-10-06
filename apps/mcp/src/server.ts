import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import {
  AttachBackend,
  CircuitBreaker,
  LocalBackend,
  createAttachHooks,
  ConfigError,
  DockerCliBackend,
  CallLog,
  connectBrowser,
  controlSocketPath,
  createRegistryHolder,
  startControlServer,
  type RegistryHolder,
  type ReloadResult,
  createBrowserHooks,
  createContextProvider,
  createOpsAdapter,
  RateLimiter,
  callTool,
  RegistryError,
  RuntimeManager,
  Store,
  StoreError,
  createGuard,
  createLogger,
  createMetrics,
  describeConfig,
  loadModules,
  loadConfig,
  type ConnectBrowser,
  policyFor,
  Budgets,
  BudgetLocked,
  type BudgetDefaults,
  effectiveRate,
  isPinned,
  pinVariable,
  resolveEnabledModules,
  setModulesEnabled,
  type PlatformStatus,
  type Clock,
  type ContextProvider,
  type ContextProviderDeps,
  type InstalledModules,
  type RuntimeBackend,
  type RuntimeHooks,
} from '@jobwatch/core';
import { budgetDefaults, installedModules } from '@jobwatch/mcp-modules';
import { roleOf, type McpModule } from '@jobwatch/sdk';
import { createApp, type AppDeps } from './app';
import { DashboardManager } from './dashboard/manager';
import { ChangeRefused, registerWrites } from './dashboard/writes';
import { createMetricsServer } from './metrics-server';

/** The call log keeps 30 days and usage events 2 days: tidy up at startup and every six hours. */
const PRUNE_INTERVAL_MS = 6 * 3600 * 1000;

export interface RunningServer {
  /** The persistent state (usage, breakers, call log). Exposed for tests and for the CLI-style commands of later steps. */
  store: Store;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  /** The last calls, in memory (what the dashboard shows). */
  callLog: CallLog;
  /** The on-demand dashboard listener (off until started). */
  dashboard: DashboardManager;
  /** Present once a browser adapter has been enabled. */
  readonly runtime: RuntimeManager | undefined;
  /** Re-read the list of enabled adapters and swap the registry without a restart. Refused when `ADAPTERS` pins the list. */
  reloadAdapters(): Promise<ReloadResult>;
  /** The MCP listener. */
  mcp: HttpServer;
  /** Where the MCP endpoint is: the address the process listens on, and the public URL clients use (`BASE_URL`), both ending in `/mcp`. */
  endpoints: { listen: string; public: string };
  /** The metrics listener, when enabled. */
  metrics: HttpServer | undefined;
  /** Stop accepting connections and wait for in-flight requests (force after `graceMs`). */
  close(graceMs?: number): Promise<void>;
}

export interface StartOptions {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  /** Tests inject their own installed table and context provider (which replaces the real one built from the runtime). */
  installed?: InstalledModules;
  contexts?: ContextProvider;
  /** Replaces the HTTP client adapters get (tests only: no real request leaves the machine). */
  createHttp?: ContextProviderDeps['createHttp'];
  /** Where log lines go; defaults to stdout. */
  logDestination?: NodeJS.WritableStream;
  /** Container runtime for browser adapters; tests pass a fake. Defaults to the docker CLI. */
  runtimeBackend?: RuntimeBackend;
  /** Replaces the browser-layer hooks (DevTools readiness, quit, memory shedding). Tests only. */
  runtimeHooks?: RuntimeHooks;
  /** Replaces the CDP connection (playwright-core). Tests only. */
  connectBrowser?: ConnectBrowser;
  /** Time source for rate limits and breakers; tests pass a controllable one. */
  clock?: Clock;
  /** Overrides PORT (tests pass 0 for a free port). */
  port?: number;
  metricsPort?: number;
  /** Path of the control socket; `false` disables it (tests). Default: `control.sock` in the data directory. */
  controlSocket?: string | false;
  /** Default budgets per module id (`budgets.json` of mcp-modules). Tests that inject `installed` get none unless they pass some. */
  budgetDefaults?: BudgetDefaults;
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

  const enabled = await resolveEnabledModules(config);
  // Two passes: the ops tools need the limiter, breaker and runtime, which are built from the enabled adapters.
  const table = options.installed ?? installedModules;
  const enabledOnly = await loadModules(enabled.ids, table);
  if (enabled.ids.length === 0)
    logger.warn('No adapters are enabled: only the built-in ops tools are listed. Enable one with `jobwatch adapters enable <id>`.');
  if (config.auth === 'front' && config.frontSharedSecret === undefined) {
    logger.warn('FRONT_SHARED_SECRET is not set: relying on network isolation, only the OAuth front may reach this port.');
  }
  if (config.auth === 'none') logger.warn('AUTH=none: no authentication. Local development only; never expose this port.');

  const metrics = config.metrics.enabled ? createMetrics({ version: options.version }) : undefined;
  metrics?.setEnabledAdapters(enabledOnly.adapters.length);

  // Persistent state. Fails fast (the process exits) when the database cannot be opened: running without a rate limiter or
  // breaker would mean nothing stops us from hammering a platform after a checkpoint.
  const clock = options.clock ?? Date.now;
  const store = Store.open(config.dbPath, { jobRetentionDays: config.jobRetentionDays }); // applies the pending schema migrations
  logger.info({ schemaVersion: store.schemaVersion, dbPath: config.dbPath }, 'database_ready');
  const breaker = new CircuitBreaker(store, clock, (platform, row) => {
    metrics?.setBreaker(platform, row?.reason);
    if (row !== undefined)
      logger.warn({ platform, reason: row.reason, until: row.until === null ? null : new Date(row.until).toISOString() }, 'breaker_opened');
    else logger.info({ platform }, 'breaker_closed');
  });
  let policyAdapters = enabledOnly.adapters;
  // The budget of every installed module: the environment, then what the dashboard saved, then budgets.json. A bad value stops the start.
  const budgets = await Budgets.load({
    dataDir: config.dataDir,
    env: options.env,
    ids: Object.keys(table),
    defaults: options.budgetDefaults ?? (options.installed === undefined ? budgetDefaults : {}),
  });
  const limiter = new RateLimiter(store, clock, (platform) =>
    policyFor(policyAdapters, (id, declared) => budgets.policy(id, declared))(platform),
  );
  for (const open of breaker.all()) {
    metrics?.setBreaker(open.platform, open.reason);
    logger.warn({ platform: open.platform, reason: open.reason, since: new Date(open.openedAt).toISOString() }, 'breaker_still_open');
  }
  const pruneNow = (): void => {
    try {
      const removed = store.prune(clock());
      if (removed.calls > 0 || removed.usage > 0 || removed.jobs > 0) logger.info(removed, 'pruned');
    } catch (error) {
      logger.error({ err: error }, 'prune_failed');
    }
  };
  pruneNow();
  const pruneTimer = setInterval(pruneNow, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  // The browser runtime exists only when an enabled adapter needs one: a router with HTTP adapters only never touches docker. It is
  // created the first time one is needed, at startup or when an adapter is enabled while the router runs.
  let runtime: RuntimeManager | undefined;
  // Where the browser comes from: a container (default), a Chrome started on this machine, or one already running that we attach to.
  const browserBackend = (): RuntimeBackend => {
    if (config.browserMode === 'attach' && config.browserCdpAddress !== undefined) return new AttachBackend(config.browserCdpAddress);
    if (config.browserMode === 'local')
      return new LocalBackend({
        ...(config.localBrowserPath ? { executable: config.localBrowserPath } : {}),
        profilesDir: join(config.dataDir, 'browser-profiles'),
      });
    return new DockerCliBackend(undefined, config.browserNetwork);
  };
  const ensureRuntime = async (): Promise<void> => {
    if (runtime !== undefined) return;
    runtime = new RuntimeManager(
      options.runtimeBackend ?? browserBackend(),
      {
        image: config.browserImage,
        network: config.browserNetwork,
        ...(config.browserSeccomp ? { seccompProfile: config.browserSeccomp } : {}),
        profileVolumePrefix: config.profileVolumePrefix,
        // Handed to the container; the language list is personal and comes from the untracked .env (05 G8).
        env: {
          CHROME_LANG: config.browserLang,
          ...(config.browserAcceptLangs ? { ACCEPT_LANGS: config.browserAcceptLangs.join(',') } : {}),
        },
        idleTtlS: config.idleTtlS,
        maxLifetimeS: config.maxLifetimeS,
        queueTimeoutS: config.queueTimeoutS,
        memMaxMb: config.memMaxMb,
        memHighMb: config.memHighMb,
      },
      logger,
      options.runtimeHooks ??
        (config.browserMode !== 'docker'
          ? createAttachHooks()
          : createBrowserHooks({
              connect: options.connectBrowser ?? connectBrowser,
              logger,
              fingerprint: config.fingerprint,
              expectations: config.browserAcceptLangs ? { languages: config.browserAcceptLangs } : {},
            })),
      (event) => metrics?.recordRuntime(event),
    );
    // Containers left by a previous router (crash, kill -9) would hold RAM and a profile lock. A docker that is not reachable
    // is logged, not fatal: the router comes up and every browser call fails with a clear error until docker is back.
    await runtime.reapOrphans().catch((error: unknown) => logger.error({ err: error }, 'orphan_reap_failed'));
  };
  if (enabledOnly.adapters.some((adapter) => adapter.kind === 'browser')) await ensureRuntime();

  const contexts =
    options.contexts ??
    createContextProvider({
      runtime: () => runtime,
      connect: options.connectBrowser ?? connectBrowser,
      logger,
      store,
      clock,
      maxTabs: config.maxTabs,
      sharedBrowser: config.browserMode !== 'docker',
      ...(options.createHttp === undefined ? {} : { createHttp: options.createHttp }),
    });
  // The holder is created after `ops`, which needs it: the ops tools read the live list of enabled adapters through this function.
  const live: { holder?: RegistryHolder } = {};
  const sessionCache = new Map<string, PlatformStatus>();
  const ops = createOpsAdapter({
    sessionCache,
    enabledAdapters: () => live.holder?.current().enabled ?? enabledOnly.adapters,
    runtime: () => runtime,
    store,
    limiter,
    breaker,
    contexts,
    clock,
    logger,
  });
  const registry = await loadModules(enabled.ids, table, [ops]);
  policyAdapters = registry.adapters;
  const holder = createRegistryHolder(
    registry,
    (ids) => loadModules(ids, table, [ops]),
    async (next) => {
      // validated before the swap; a browser adapter needs the runtime to exist from its first call
      if (next.enabled.some((adapter) => adapter.kind === 'browser')) await ensureRuntime();
      policyAdapters = next.adapters;
      metrics?.setEnabledAdapters(next.enabled.length);
    },
  );
  logger.info({ enabled: enabled.ids, source: enabled.source, tools: [...registry.tools.keys()] }, 'adapters_loaded');

  // The last calls, in memory, for the dashboard (docs/plans/17-dashboard.md). Their parameters are kept nowhere else.
  const callLog = new CallLog(config.callBuffer);
  live.holder = holder;
  const appDeps: AppDeps = {
    registry: holder.view,
    contexts,
    logger,
    metrics,
    version: options.version,
    config,
    guard: createGuard(limiter, breaker),
    started: (call) => callLog.start(call),
    tokenCharsPerToken: config.charsPerToken,
    record: (outcome) => {
      callLog.finish(outcome);
      try {
        store.recordDailyUsage({
          ts: clock(),
          tool: outcome.tool,
          platform: outcome.platform,
          error: outcome.code !== 'ok',
          responseBytes: outcome.detail?.responseBytes ?? 0,
          tokens: outcome.detail?.estimatedTokens ?? 0,
          units: outcome.detail?.unitsSpent ?? 0,
          durationMs: outcome.durationMs,
          textAvailable: outcome.detail?.jobText?.available ?? 0,
          textReturned: outcome.detail?.jobText?.returned ?? 0,
        });
      } catch (error) {
        logger.warn({ err: error }, 'daily_usage_failed'); // a lost total never fails a call
      }
      store.recordCall({
        ts: clock(),
        requestId: outcome.requestId,
        tool: outcome.tool,
        adapter: outcome.adapter,
        platform: outcome.platform,
        outcome: outcome.code,
        durationMs: outcome.durationMs,
        argsHash: outcome.argsHash,
      });
    },
  };
  const app = createApp(appDeps);

  /** Run one of the registry's tools from the host (the control socket): the same guard, budget, log and call history as an MCP call. */
  const runTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!holder.current().tools.has(name))
      throw new Error(`The tool ${name} is not available: enable its adapter first (jobwatch adapters enable linkedin-geo).`);
    const { result } = await callTool(appDeps, name, args);
    if (result.isError) {
      const failure = JSON.parse(result.content[0]?.text ?? '{}') as { message?: string };
      throw new Error(failure.message ?? 'The tool failed.');
    }
    return { ...result.structuredContent, warnings: result._meta?.jobwatch.warnings ?? [] };
  };
  const mcpServer = createHttpServer(app);
  await listen(mcpServer, options.port ?? config.port, config.listenHost);

  const metricsServer = metrics ? createMetricsServer(metrics) : undefined;
  if (metricsServer) await listen(metricsServer, options.metricsPort ?? config.metrics.port, config.listenHost);

  const address = mcpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const endpoints = {
    listen: `http://${config.listenHost.includes(':') ? `[${config.listenHost}]` : config.listenHost}:${port}/mcp`,
    public: `${config.baseUrl}/mcp`,
  };
  logger.info({ port, url: endpoints.listen, metrics: metricsServer !== undefined }, 'listening');

  /** Hot reload (docs/plans/17-dashboard.md, section 6.4): re-read `adapters.json` and swap the registry. */
  const pinnedByEnv = config.adaptersFromEnv !== undefined || config.utilitiesFromEnv !== undefined;
  const reloadAdapters = async (): Promise<ReloadResult> => {
    // A list set by ADAPTERS or UTILITIES stays as the variable says; the other one is re-read from the file.
    const wanted = await resolveEnabledModules(config);
    const result = await holder.reload(wanted.ids);
    logger.info({ enabled: result.enabled, added: result.addedAdapters, removed: result.removedAdapters }, 'adapters_reloaded');
    return result;
  };

  /**
   * Forget what one adapter stored (jobs and searches) so its next call starts fresh (docs/plans/17-dashboard.md). Operator only: the CLI
   * and the dashboard call it, never an MCP tool. Utilities store no jobs, so they are refused.
   */
  const clearAdapterData = async (id: string): Promise<{ platform: string; jobs: number; searches: number }> => {
    const load = (table as Readonly<Record<string, (() => Promise<McpModule>) | undefined>>)[id];
    if (load === undefined) throw new ChangeRefused(404, 'not_found', 'No such adapter is installed.');
    const module = await load();
    if (roleOf(module) === 'utility')
      throw new ChangeRefused(400, 'not_an_adapter', 'A utility stores no jobs, so there is nothing to clear.');
    const cleared = store.clearPlatform(module.platform);
    logger.info({ adapter: id, platform: module.platform, ...cleared }, 'adapter_data_cleared');
    return { platform: module.platform, ...cleared };
  };

  // The host-side commands (`jobwatch adapters enable ...` reloads a running router) reach the router through a Unix socket in the
  // data directory. A router without a writable data directory (tests, read-only setups) simply has no control channel.
  // The dashboard listener starts only when the host asks for it through the control socket (docs/plans/17-dashboard.md).
  const dashboard = new DashboardManager(
    {
      port: config.dashboard.port,
      host: config.auth === 'front' ? '0.0.0.0' : config.listenHost,
      url: config.dashboard.url,
      publicOrigin: new URL(config.baseUrl).origin,
      authRequired: config.auth === 'front',
      oidc: config.dashboard.oidc,
      idleS: config.dashboard.idleS,
      sessionMaxS: config.dashboard.sessionMaxS,
      writeWindowS: config.dashboard.writeWindowS,
      staticDir: config.dashboard.staticDir,
    },
    {
      version: options.version,
      clock,
      store,
      callLog,
      limiter,
      breaker,
      registry: () => holder.current(),
      installed: table,
      budgets,
      pinned: { adapters: isPinned(config, 'adapters'), utilities: isPinned(config, 'utilities') },
      runtime: () => runtime,
      sessionStates: () => sessionCache,
      settings: {
        signIn: config.auth === 'front' ? 'google' : 'none',
        idleStopMinutes: Math.round(config.dashboard.idleS / 60),
        sessionMaxHours: Math.round(config.dashboard.sessionMaxS / 3600),
        writeWindowMinutes: Math.round(config.dashboard.writeWindowS / 60),
        callBuffer: config.callBuffer,
        charsPerToken: config.charsPerToken,
        jobRetentionDays: config.jobRetentionDays,
        maxTabs: config.maxTabs,
        browser: { idleStopSeconds: config.idleTtlS, memoryHighMb: config.memHighMb, memoryMaxMb: config.memMaxMb },
        adaptersPinned: pinnedByEnv,
      },
    },
    logger,
    clock,
    {
      writes: (router) =>
        registerWrites(
          router,
          {
            setAdapter: async (id, enabled) => {
              const load = (table as Readonly<Record<string, (() => Promise<McpModule>) | undefined>>)[id];
              if (load === undefined) throw new ChangeRefused(404, 'not_found', 'No such adapter or utility is installed.');
              const group = roleOf(await load()) === 'utility' ? 'utilities' : 'adapters';
              if (isPinned(config, group))
                throw new ChangeRefused(409, 'pinned', `${pinVariable(group)} sets the enabled list; unset it to change it from here.`);
              const groupIds = (
                await Promise.all(Object.entries(table).map(async ([key, loader]) => [key, roleOf(await loader())] as const))
              )
                .filter(([, role]) => (role === 'utility') === (group === 'utilities'))
                .map(([key]) => key)
                .sort();
              await setModulesEnabled(config, groupIds, [id], enabled, group);
              try {
                const result = await reloadAdapters();
                return { enabledAdapters: result.enabled, addedTools: result.addedTools, removedTools: result.removedTools };
              } catch (error) {
                // the file was written but the list does not load: put it back so the next start is not broken
                await setModulesEnabled(config, groupIds, [id], !enabled, group).catch(() => undefined);
                throw new ChangeRefused(
                  422,
                  'not_loadable',
                  error instanceof Error ? (error.message.split('\n')[0] ?? 'The adapter did not load.') : 'The adapter did not load.',
                );
              }
            },
            setBudget: async (id, change) => {
              const load = (table as Readonly<Record<string, (() => Promise<McpModule>) | undefined>>)[id];
              if (load === undefined) throw new ChangeRefused(404, 'not_found', 'No such adapter or utility is installed.');
              try {
                return await budgets.set(id, change, effectiveRate(await load()));
              } catch (error) {
                if (error instanceof BudgetLocked) throw new ChangeRefused(409, 'env_locked', error.message);
                throw error;
              }
            },
            clearData: async (id) => {
              const { jobs, searches } = await clearAdapterData(id);
              return { jobs, searches };
            },
            running: () => callLog.all().filter((call) => call.state === 'running').length,
            restart: () => void process.kill(process.pid, 'SIGTERM'),
          },
          logger,
        ),
    },
  );

  const controlServer =
    options.controlSocket === false
      ? undefined
      : await startControlServer(
          options.controlSocket ?? controlSocketPath(config.dataDir),
          {
            ping: async () => ({ version: options.version }),
            'adapters.reload': async () => ({ ...(await reloadAdapters()) }),
            'data.clear': async (request) => {
              try {
                return { ...(await clearAdapterData(String(request['adapter'] ?? ''))) };
              } catch (error) {
                throw error instanceof ChangeRefused ? new Error(error.message) : error;
              }
            },
            'dashboard.start': async (request) => ({
              ...(await dashboard.start(typeof request['ttlMinutes'] === 'number' ? { ttlMinutes: request['ttlMinutes'] } : {})),
            }),
            'dashboard.stop': async () => ({ ...(await dashboard.stop()) }),
            'dashboard.status': async () => ({ ...dashboard.status() }),
            // places: look up, remember and forget names for LinkedIn locations, through the linkedin_locations tool
            'linkedin-geo.lookup': (request) => runTool('linkedin_locations', { query: String(request['query'] ?? '') }),
            'linkedin-geo.save': (request) =>
              runTool('linkedin_locations', {
                save_as: String(request['alias'] ?? ''),
                id: String(request['id'] ?? ''),
                ...(typeof request['label'] === 'string' && request['label'] !== '' ? { label: request['label'] } : {}),
              }),
            'linkedin-geo.forget': (request) => runTool('linkedin_locations', { forget: String(request['alias'] ?? '') }),
            'linkedin-geo.list': () => runTool('linkedin_locations', { list: true }),
          },
          (error) => logger.warn({ err: error }, 'control_socket_error'),
        ).catch((error: unknown) => {
          logger.warn({ err: error }, 'control_socket_unavailable');
          return undefined;
        });

  let closing: Promise<void> | undefined;
  return {
    store,
    limiter,
    breaker,
    callLog,
    dashboard,
    get runtime() {
      return runtime;
    },
    reloadAdapters,
    mcp: mcpServer,
    endpoints,
    metrics: metricsServer,
    close: (graceMs = 10_000) => {
      closing ??= (async () => {
        clearInterval(pruneTimer);
        await dashboard.stop('shutdown');
        await controlServer?.close();
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
