import { ConfigError } from './errors';
import { envSchema, parseEnv, type ParsedEnv } from './env';

/** Ids of adapters, as used in adapters.json and ADAPTERS. Same pattern as `validateAdapter`. */
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackUrl = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

export interface Config {
  baseUrl: string;
  /** `front`: requests arrive through the OAuth front. `none`: local development only (loopback base URL required). */
  auth: 'front' | 'none';
  /** Never log this value; use `describeConfig`. */
  frontSharedSecret: string | undefined;
  listenHost: string;
  port: number;
  runtime: 'docker' | 'systemd-scope';
  browserImage: string;
  /** Internal Docker network the browser containers join (DevTools is never published). */
  browserNetwork: string;
  /** Absolute path of the Chrome seccomp profile as seen by the docker CLI; unset = Docker's default profile. */
  browserSeccomp: string | undefined;
  /** UI language and `navigator.languages` of the browser (copied from the everyday browser, 05 G8). The list is personal: keep it in the untracked .env. */
  browserLang: string;
  browserAcceptLangs: readonly string[] | undefined;
  /**
   * Where the browser comes from. `docker`: a container per platform (default). `local`: Chrome started on this machine
   * (`BROWSER_LOCAL_CHROME`). `attach`: an already running Chrome reached over DevTools (`BROWSER_CDP_URL`, which wins over `BROWSER_LOCAL_CHROME`).
   */
  browserMode: 'docker' | 'local' | 'attach';
  /** `BROWSER_LOCAL_CHROME_PATH`: the Chrome executable of `local` mode; unset = look in the usual places. */
  localBrowserPath: string | undefined;
  /** `ip:port` of the DevTools of the browser to attach to; set in `attach` mode only. Always loopback. */
  browserCdpAddress: string | undefined;
  /** Most tabs the browser may have open at once (`BROWSER_MAX_TABS`, default 3, no upper limit). 1 = single tab: `openTab` refuses. */
  maxTabs: number;
  /** The operator dashboard (docs/plans/17-dashboard.md). Off until `jobwatch dashboard start`. */
  dashboard: {
    port: number;
    /** Where the operator opens it (`DASHBOARD_URL`); default `<BASE_URL origin>/dashboard/`. */
    url: string;
    /** The built interface (`DASHBOARD_STATIC_DIR`); without it a plain page says only the API is up. */
    staticDir: string | undefined;
    /** The dashboard stops itself after this many seconds without a request. */
    idleS: number;
    /** A session never lasts longer than this. */
    sessionMaxS: number;
    /** A write is accepted without signing in again for this long after a sign-in (0 = every write signs in again). */
    writeWindowS: number;
    /** Undefined when no Google client is configured; the dashboard then refuses to start unless the router runs without auth. */
    oidc: { issuer: string; clientId: string; clientSecret: string } | undefined;
  };
  /** Calls kept in memory for the dashboard (`DASHBOARD_CALL_BUFFER`). */
  callBuffer: number;
  /** Characters per token for the estimate of what a result costs Claude (`TOKEN_CHARS_PER_TOKEN`). */
  charsPerToken: number;
  /** `enforce`: refuse to use a browser that fails its startup fingerprint check. */
  fingerprint: 'enforce' | 'warn' | 'off';
  profileVolumePrefix: string;
  dataDir: string;
  /** SQLite file (rate-limit usage, circuit breakers, call log). `:memory:` only in tests. */
  dbPath: string;
  /** Days a stored job posting is kept after it was last seen (read or listed on a search page); older ones are evicted (at start and every six hours). */
  jobRetentionDays: number;
  /** Days a call is kept in the call log, parameters included, before it is deleted (the log rotation). */
  callLogRetentionDays: number;
  /** `CUSTOM_ADAPTERS=on`: the adapters written on the dashboard (JavaScript run in a sandbox) are loaded. Off by default. */
  customAdapters: boolean;
  /** `docker`: a container with no network, no capability and a read-only root (the default). `process`: a bare Node process with the permission model on (no files, no network, no child process) but no container, memory or CPU cap: for local development only. */
  customAdaptersSandbox: 'docker' | 'process';
  /** The image with Node that the sandbox container runs. */
  customAdaptersImage: string;
  /** From ADAPTERS. When defined it overrides adapters.json and the CLI refuses to edit the file. */
  adaptersFromEnv: readonly string[] | undefined;
  /** From UTILITIES. Same rule, for the utilities (tools that fetch no jobs). */
  utilitiesFromEnv: readonly string[] | undefined;
  idleTtlS: number;
  maxLifetimeS: number;
  queueTimeoutS: number;
  memHighMb: number;
  memMaxMb: number;
  logLevel: ParsedEnv['LOG_LEVEL'];
  metrics: { enabled: boolean; port: number };
}

export interface LoadedConfig {
  config: Config;
  /** Non-fatal notes, e.g. a variable that still has its old `JW_` prefix. */
  warnings: string[];
}

/** Parse `ADAPTERS` (or `UTILITIES`). Empty string means "explicitly none enabled". Returns problems instead of throwing. */
export function parseAdapterList(raw: string, variable = 'ADAPTERS'): { ids: string[]; problems: string[] } {
  const ids: string[] = [];
  const problems: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id === '') continue;
    if (!ADAPTER_ID_PATTERN.test(id)) problems.push(`${variable}: "${id}" is not a valid id`);
    else if (ids.includes(id)) problems.push(`${variable}: "${id}" is listed twice`);
    else ids.push(id);
  }
  return { ids, problems };
}

/** `ip:port` of a loopback DevTools URL (`http://127.0.0.1:9222`, `http://localhost:9222`), or undefined when it is anything else. */
function parseCdpUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  if (url.protocol !== 'http:' || !/^127(\.\d{1,3}){3}$/.test(host) || url.port === '') return undefined;
  return `${host}:${url.port}`;
}

/**
 * Validate the environment. Pure: pass `process.env` (or a test object). Throws `ConfigError` listing every problem at once.
 * Messages carry variable names and reasons only, never the offending values.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): LoadedConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const result = parseEnv(env);
  if (!result.ok) throw new ConfigError(result.problems);
  const parsed = result.data;
  warnings.push(...result.warnings);

  const baseUrl = new URL(parsed.BASE_URL);
  if (baseUrl.protocol === 'http:' && !isLoopbackUrl(baseUrl))
    problems.push('BASE_URL: http is only allowed for localhost, 127.0.0.1 or [::1]; use https');
  if (parsed.CUSTOM_ADAPTERS === 'on' && parsed.CUSTOM_ADAPTERS_SANDBOX === 'process' && parsed.AUTH !== 'none')
    problems.push(
      'CUSTOM_ADAPTERS_SANDBOX=process runs the scripts of custom adapters in a bare Node process, with no container and no memory or CPU cap: it is only for local development (AUTH=none); use docker',
    );
  if (parsed.AUTH === 'none' && !isLoopbackUrl(baseUrl)) {
    problems.push(
      'AUTH=none is only allowed when BASE_URL is a loopback address (local development); the public deployment must use the OAuth front',
    );
  }
  if (parsed.BROWSER_MEM_HIGH_MB >= parsed.BROWSER_MEM_MAX_MB) problems.push('BROWSER_MEM_HIGH_MB must be lower than BROWSER_MEM_MAX_MB');
  if (parsed.METRICS_ENABLED && parsed.METRICS_PORT === parsed.PORT)
    problems.push('METRICS_PORT must differ from PORT: metrics are never served on the MCP port');

  let browserCdpAddress: string | undefined;
  if (parsed.BROWSER_CDP_URL !== undefined) {
    browserCdpAddress = parseCdpUrl(parsed.BROWSER_CDP_URL);
    if (browserCdpAddress === undefined)
      problems.push('BROWSER_CDP_URL: must be a loopback http URL with a port, e.g. http://127.0.0.1:9222');
    if (parsed.BROWSER_LOCAL_CHROME)
      warnings.push('BROWSER_LOCAL_CHROME is ignored because BROWSER_CDP_URL is set: the running Chrome is used');
  }
  if (parsed.BROWSER_LOCAL_CHROME_PATH !== undefined && !parsed.BROWSER_LOCAL_CHROME && parsed.BROWSER_CDP_URL === undefined)
    warnings.push('BROWSER_LOCAL_CHROME_PATH is ignored unless BROWSER_LOCAL_CHROME=true');

  let adaptersFromEnv: string[] | undefined;
  if (env['ADAPTERS'] !== undefined) {
    const list = parseAdapterList(env['ADAPTERS']);
    problems.push(...list.problems);
    adaptersFromEnv = list.ids;
  }
  let utilitiesFromEnv: string[] | undefined;
  if (env['UTILITIES'] !== undefined) {
    const list = parseAdapterList(env['UTILITIES'], 'UTILITIES');
    problems.push(...list.problems);
    utilitiesFromEnv = list.ids;
  }

  if (problems.length > 0) throw new ConfigError(problems);

  // The dashboard signs in with its own Google client when it has one, else with the connector's (the OAuth front's) client.
  const dashboardClientId = parsed.DASHBOARD_OIDC_CLIENT_ID ?? parsed.OIDC_CLIENT_ID;
  const dashboardClientSecret = parsed.DASHBOARD_OIDC_CLIENT_SECRET ?? parsed.OIDC_CLIENT_SECRET;

  return {
    warnings,
    config: {
      baseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/$/, ''),
      auth: parsed.AUTH,
      frontSharedSecret: parsed.FRONT_SHARED_SECRET,
      listenHost: parsed.LISTEN_HOST,
      port: parsed.PORT,
      runtime: parsed.BROWSER_RUNTIME,
      browserImage: parsed.BROWSER_IMAGE,
      browserNetwork: parsed.BROWSER_NETWORK,
      browserSeccomp: parsed.BROWSER_SECCOMP,
      browserLang: parsed.BROWSER_LANG,
      browserAcceptLangs: parsed.BROWSER_ACCEPT_LANGS?.split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      browserMode: browserCdpAddress !== undefined ? 'attach' : parsed.BROWSER_LOCAL_CHROME ? 'local' : 'docker',
      localBrowserPath: parsed.BROWSER_LOCAL_CHROME_PATH,
      browserCdpAddress,
      maxTabs: parsed.BROWSER_MAX_TABS,
      dashboard: {
        port: parsed.DASHBOARD_PORT,
        // Behind the reverse proxy the dashboard is at BASE_URL/dashboard/. With AUTH=none there is no proxy: it is on its own port.
        url:
          parsed.DASHBOARD_URL ??
          (parsed.AUTH === 'none'
            ? `${baseUrl.protocol}//${baseUrl.hostname}:${parsed.DASHBOARD_PORT}/dashboard/`
            : `${baseUrl.origin}/dashboard/`),
        staticDir: parsed.DASHBOARD_STATIC_DIR,
        idleS: parsed.DASHBOARD_IDLE_S,
        sessionMaxS: parsed.DASHBOARD_SESSION_MAX_S,
        writeWindowS: parsed.DASHBOARD_WRITE_WINDOW_S,
        oidc:
          dashboardClientId !== undefined && dashboardClientSecret !== undefined
            ? {
                issuer: parsed.DASHBOARD_OIDC_ISSUER ?? parsed.OIDC_ISSUER_URL ?? 'https://accounts.google.com',
                clientId: dashboardClientId,
                clientSecret: dashboardClientSecret,
              }
            : undefined,
      },
      callBuffer: parsed.DASHBOARD_CALL_BUFFER,
      charsPerToken: parsed.TOKEN_CHARS_PER_TOKEN,
      fingerprint: parsed.BROWSER_FINGERPRINT,
      profileVolumePrefix: parsed.BROWSER_PROFILE_VOLUME_PREFIX,
      dataDir: parsed.DATA_DIR,
      jobRetentionDays: parsed.JOB_RETENTION_DAYS,
      callLogRetentionDays: parsed.CALL_LOG_RETENTION_DAYS,
      customAdapters: parsed.CUSTOM_ADAPTERS === 'on',
      customAdaptersSandbox: parsed.CUSTOM_ADAPTERS_SANDBOX,
      customAdaptersImage: parsed.CUSTOM_ADAPTERS_IMAGE,
      dbPath: parsed.DB_PATH ?? `${parsed.DATA_DIR.replace(/\/+$/, '')}/jobwatch.sqlite`,
      adaptersFromEnv,
      utilitiesFromEnv,
      idleTtlS: parsed.BROWSER_IDLE_TTL_S,
      maxLifetimeS: parsed.BROWSER_MAX_LIFETIME_S,
      queueTimeoutS: parsed.BROWSER_QUEUE_TIMEOUT_S,
      memHighMb: parsed.BROWSER_MEM_HIGH_MB,
      memMaxMb: parsed.BROWSER_MEM_MAX_MB,
      logLevel: parsed.LOG_LEVEL,
      metrics: { enabled: parsed.METRICS_ENABLED, port: parsed.METRICS_PORT },
    },
  };
}

/** The only settings the CLI needs. It must work without the public base URL, which only the server requires. */
export interface StorageSettings {
  dataDir: string;
  /** From ADAPTERS; when defined it overrides adapters.json. */
  adaptersFromEnv: readonly string[] | undefined;
  /** From UTILITIES; when defined it overrides the `utilities` of adapters.json. */
  utilitiesFromEnv: readonly string[] | undefined;
}

const storageSchema = envSchema.pick({ DATA_DIR: true });

/** Parse DATA_DIR, ADAPTERS and UTILITIES only. Throws `ConfigError`; same rules as `loadConfig` for these two variables. */
export function loadStorageSettings(env: Readonly<Record<string, string | undefined>>): StorageSettings {
  const problems: string[] = [];
  const result = storageSchema.safeParse({ DATA_DIR: env['DATA_DIR'] === '' ? undefined : env['DATA_DIR'] });
  if (!result.success) problems.push(...result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`));
  let adaptersFromEnv: string[] | undefined;
  if (env['ADAPTERS'] !== undefined) {
    const list = parseAdapterList(env['ADAPTERS']);
    problems.push(...list.problems);
    adaptersFromEnv = list.ids;
  }
  let utilitiesFromEnv: string[] | undefined;
  if (env['UTILITIES'] !== undefined) {
    const list = parseAdapterList(env['UTILITIES'], 'UTILITIES');
    problems.push(...list.problems);
    utilitiesFromEnv = list.ids;
  }
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return { dataDir: result.data.DATA_DIR, adaptersFromEnv, utilitiesFromEnv };
}

/** A copy of the configuration that is safe to log or print (secrets replaced). */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    frontSharedSecret: config.frontSharedSecret === undefined ? undefined : '[redacted]',
    dashboard: {
      ...config.dashboard,
      oidc: config.dashboard.oidc === undefined ? undefined : { ...config.dashboard.oidc, clientSecret: '[redacted]' },
    },
  };
}
