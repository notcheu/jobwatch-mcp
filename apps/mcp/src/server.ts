import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  ConfigError,
  RegistryError,
  createLogger,
  createMetrics,
  describeConfig,
  loadAdapters,
  loadConfig,
  noRuntime,
  resolveEnabledAdapters,
  type ContextProvider,
  type InstalledAdapters,
} from '@jobwatch/core';
import { installed } from '@jobwatch/adapters';
import { createApp } from './app';
import { createMetricsServer } from './metrics-server';

export interface RunningServer {
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

  const app = createApp({ registry, contexts: options.contexts ?? noRuntime, logger, metrics, version: options.version, config });
  const mcpServer = createHttpServer(app);
  await listen(mcpServer, options.port ?? config.port, config.listenHost);

  const metricsServer = metrics ? createMetricsServer(metrics) : undefined;
  if (metricsServer) await listen(metricsServer, options.metricsPort ?? config.metrics.port, config.listenHost);

  const address = mcpServer.address();
  logger.info(
    { port: typeof address === 'object' && address ? address.port : config.port, metrics: metricsServer !== undefined },
    'listening',
  );

  return {
    mcp: mcpServer,
    metrics: metricsServer,
    close: async (graceMs = 10_000) => {
      await Promise.all([closeServer(mcpServer, graceMs), metricsServer ? closeServer(metricsServer, graceMs) : Promise.resolve()]);
      logger.info('stopped');
    },
  };
}

/** Print configuration and registry problems as readable text. Returns true when the error was one of those. */
export function reportStartupError(error: unknown, write: (text: string) => void): boolean {
  if (error instanceof ConfigError || error instanceof RegistryError) {
    write(`${error.message}\n`);
    return true;
  }
  return false;
}
