import { z } from '@jobwatch/sdk';
import { ConfigError } from './errors';

/** Ids of adapters, as used in adapters.json and JW_ADAPTERS. Same pattern as `validateAdapter`. */
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackUrl = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

const integer = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Every JW_* variable the router reads (docs/plans/03-router-spec.md, "Configuration"). */
const envSchema = z.object({
  JW_BASE_URL: z.url({
    protocol: /^https?$/,
    error: (issue) =>
      issue.input === undefined
        ? 'is required: the public URL, e.g. https://mcp.example.com'
        : 'must be an http(s) URL, e.g. https://mcp.example.com',
  }),
  JW_AUTH: z.enum(['front', 'none']).default('front'),
  JW_FRONT_SHARED_SECRET: z.string().min(16).optional(),
  JW_LISTEN_HOST: z.string().min(1).default('0.0.0.0'),
  JW_PORT: integer(1024, 65535, 8080),
  JW_RUNTIME: z.enum(['docker', 'systemd-scope']).default('docker'),
  JW_BROWSER_IMAGE: z.string().min(1).default('localhost/jobwatch-browser:1'),
  JW_BROWSER_NETWORK: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .default('jobwatch-browsers'),
  JW_DEFAULT_LOCATION: z.string().trim().max(100).optional(),
  JW_LINKEDIN_GEO_ALIASES: z.string().max(2000).optional(),
  JW_BROWSER_SECCOMP: z.string().startsWith('/').optional(),
  JW_BROWSER_LANG: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .default('fr-FR'),
  JW_BROWSER_ACCEPT_LANGS: z
    .string()
    .regex(/^[A-Za-z0-9,;=.-]{2,512}$/)
    .optional(),
  JW_BROWSER_MAX_TABS: z.coerce.number().int().min(1).default(3),
  JW_LOCAL_CHROME: flag.default(false),
  JW_LOCAL_CHROME_PATH: z.string().min(1).optional(),
  JW_CDP_URL: z.string().min(1).optional(),
  JW_DASHBOARD_PORT: integer(1024, 65535, 8090),
  JW_DASHBOARD_URL: z.url().optional(),
  JW_DASHBOARD_STATIC_DIR: z.string().min(1).optional(),
  JW_DASHBOARD_IDLE_S: integer(60, 86_400, 1800),
  JW_DASHBOARD_SESSION_MAX_S: integer(300, 604_800, 28_800),
  JW_DASHBOARD_WRITE_WINDOW_S: integer(0, 86_400, 600),
  JW_DASHBOARD_OIDC_ISSUER: z.url().default('https://accounts.google.com'),
  JW_DASHBOARD_OIDC_CLIENT_ID: z.string().min(1).max(300).optional(),
  JW_DASHBOARD_OIDC_CLIENT_SECRET: z.string().min(1).max(300).optional(),
  JW_DASHBOARD_CALL_BUFFER: integer(100, 20_000, 2000),
  JW_TOKEN_CHARS_PER_TOKEN: z.coerce.number().min(1).max(10).default(3.5),
  JW_FINGERPRINT: z.enum(['enforce', 'warn', 'off']).default('enforce'),
  JW_PROFILE_VOLUME_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .default('jw-profile-'),
  JW_DATA_DIR: z.string().min(1).default('/data'),
  JW_DB_PATH: z.string().min(1).optional(),
  JW_JOB_RETENTION_DAYS: integer(1, 3650, 30),
  JW_ADAPTERS: z.string().optional(),
  JW_UTILITIES: z.string().optional(),
  JW_IDLE_TTL_S: integer(10, 3600, 120),
  JW_MAX_LIFETIME_S: integer(60, 86_400, 1800),
  JW_QUEUE_TIMEOUT_S: integer(1, 600, 60),
  JW_MEM_HIGH_MB: integer(256, 16_384, 1200),
  JW_MEM_MAX_MB: integer(256, 16_384, 1500),
  JW_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  JW_METRICS_ENABLED: flag.default(false),
  JW_METRICS_PORT: integer(1024, 65535, 9464),
});

type ParsedEnv = z.infer<typeof envSchema>;

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
   * (`JW_LOCAL_CHROME`). `attach`: an already running Chrome reached over DevTools (`JW_CDP_URL`, which wins over `JW_LOCAL_CHROME`).
   */
  browserMode: 'docker' | 'local' | 'attach';
  /** `JW_LOCAL_CHROME_PATH`: the Chrome executable of `local` mode; unset = look in the usual places. */
  localBrowserPath: string | undefined;
  /** `ip:port` of the DevTools of the browser to attach to; set in `attach` mode only. Always loopback. */
  browserCdpAddress: string | undefined;
  /** Most tabs the browser may have open at once (`JW_BROWSER_MAX_TABS`, default 3, no upper limit). 1 = single tab: `openTab` refuses. */
  maxTabs: number;
  /** The operator dashboard (docs/plans/17-dashboard.md). Off until `jobwatch dashboard start`. */
  dashboard: {
    port: number;
    /** Where the operator opens it (`JW_DASHBOARD_URL`); default `<JW_BASE_URL origin>/dashboard/`. */
    url: string;
    /** The built interface (`JW_DASHBOARD_STATIC_DIR`); without it a plain page says only the API is up. */
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
  /** Calls kept in memory for the dashboard (`JW_DASHBOARD_CALL_BUFFER`). */
  callBuffer: number;
  /** Characters per token for the estimate of what a result costs Claude (`JW_TOKEN_CHARS_PER_TOKEN`). */
  charsPerToken: number;
  /** `enforce`: refuse to use a browser that fails its startup fingerprint check. */
  fingerprint: 'enforce' | 'warn' | 'off';
  profileVolumePrefix: string;
  dataDir: string;
  /** SQLite file (rate-limit usage, circuit breakers, call log). `:memory:` only in tests. */
  dbPath: string;
  /** Days a stored job posting is kept after it was last seen (read or listed on a search page); older ones are evicted (at start and every six hours). */
  jobRetentionDays: number;
  /** From JW_ADAPTERS. When defined it overrides adapters.json and the CLI refuses to edit the file. */
  adaptersFromEnv: readonly string[] | undefined;
  /** From JW_UTILITIES. Same rule, for the utilities (tools that fetch no jobs). */
  utilitiesFromEnv: readonly string[] | undefined;
  idleTtlS: number;
  maxLifetimeS: number;
  queueTimeoutS: number;
  memHighMb: number;
  memMaxMb: number;
  logLevel: ParsedEnv['JW_LOG_LEVEL'];
  metrics: { enabled: boolean; port: number };
}

export interface LoadedConfig {
  config: Config;
  /** Non-fatal notes, e.g. unknown JW_* variables (usually typos). */
  warnings: string[];
}

/** Parse `JW_ADAPTERS` (or `JW_UTILITIES`). Empty string means "explicitly none enabled". Returns problems instead of throwing. */
export function parseAdapterList(raw: string, variable = 'JW_ADAPTERS'): { ids: string[]; problems: string[] } {
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

  // An empty value means "not set" (docker compose passes `VAR=` for unset interpolations).
  const present = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => key.startsWith('JW_') && value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    for (const issue of result.error.issues) problems.push(`${issue.path.join('.') || 'config'}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const parsed = result.data;

  for (const key of Object.keys(present)) {
    if (!(key in envSchema.shape)) warnings.push(`${key} is not a known setting and is ignored (typo?)`);
  }

  const baseUrl = new URL(parsed.JW_BASE_URL);
  if (baseUrl.protocol === 'http:' && !isLoopbackUrl(baseUrl))
    problems.push('JW_BASE_URL: http is only allowed for localhost, 127.0.0.1 or [::1]; use https');
  if (parsed.JW_AUTH === 'none' && !isLoopbackUrl(baseUrl)) {
    problems.push(
      'JW_AUTH=none is only allowed when JW_BASE_URL is a loopback address (local development); the public deployment must use the OAuth front',
    );
  }
  if (parsed.JW_MEM_HIGH_MB >= parsed.JW_MEM_MAX_MB) problems.push('JW_MEM_HIGH_MB must be lower than JW_MEM_MAX_MB');
  if (parsed.JW_METRICS_ENABLED && parsed.JW_METRICS_PORT === parsed.JW_PORT)
    problems.push('JW_METRICS_PORT must differ from JW_PORT: metrics are never served on the MCP port');

  let browserCdpAddress: string | undefined;
  if (parsed.JW_CDP_URL !== undefined) {
    browserCdpAddress = parseCdpUrl(parsed.JW_CDP_URL);
    if (browserCdpAddress === undefined) problems.push('JW_CDP_URL: must be a loopback http URL with a port, e.g. http://127.0.0.1:9222');
    if (parsed.JW_LOCAL_CHROME) warnings.push('JW_LOCAL_CHROME is ignored because JW_CDP_URL is set: the running Chrome is used');
  }
  if (parsed.JW_LOCAL_CHROME_PATH !== undefined && !parsed.JW_LOCAL_CHROME && parsed.JW_CDP_URL === undefined)
    warnings.push('JW_LOCAL_CHROME_PATH is ignored unless JW_LOCAL_CHROME=true');

  let adaptersFromEnv: string[] | undefined;
  if (env['JW_ADAPTERS'] !== undefined) {
    const list = parseAdapterList(env['JW_ADAPTERS']);
    problems.push(...list.problems);
    adaptersFromEnv = list.ids;
  }
  let utilitiesFromEnv: string[] | undefined;
  if (env['JW_UTILITIES'] !== undefined) {
    const list = parseAdapterList(env['JW_UTILITIES'], 'JW_UTILITIES');
    problems.push(...list.problems);
    utilitiesFromEnv = list.ids;
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    warnings,
    config: {
      baseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/$/, ''),
      auth: parsed.JW_AUTH,
      frontSharedSecret: parsed.JW_FRONT_SHARED_SECRET,
      listenHost: parsed.JW_LISTEN_HOST,
      port: parsed.JW_PORT,
      runtime: parsed.JW_RUNTIME,
      browserImage: parsed.JW_BROWSER_IMAGE,
      browserNetwork: parsed.JW_BROWSER_NETWORK,
      browserSeccomp: parsed.JW_BROWSER_SECCOMP,
      browserLang: parsed.JW_BROWSER_LANG,
      browserAcceptLangs: parsed.JW_BROWSER_ACCEPT_LANGS?.split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      browserMode: browserCdpAddress !== undefined ? 'attach' : parsed.JW_LOCAL_CHROME ? 'local' : 'docker',
      localBrowserPath: parsed.JW_LOCAL_CHROME_PATH,
      browserCdpAddress,
      maxTabs: parsed.JW_BROWSER_MAX_TABS,
      dashboard: {
        port: parsed.JW_DASHBOARD_PORT,
        url: parsed.JW_DASHBOARD_URL ?? `${baseUrl.origin}/dashboard/`,
        staticDir: parsed.JW_DASHBOARD_STATIC_DIR,
        idleS: parsed.JW_DASHBOARD_IDLE_S,
        sessionMaxS: parsed.JW_DASHBOARD_SESSION_MAX_S,
        writeWindowS: parsed.JW_DASHBOARD_WRITE_WINDOW_S,
        oidc:
          parsed.JW_DASHBOARD_OIDC_CLIENT_ID !== undefined && parsed.JW_DASHBOARD_OIDC_CLIENT_SECRET !== undefined
            ? {
                issuer: parsed.JW_DASHBOARD_OIDC_ISSUER,
                clientId: parsed.JW_DASHBOARD_OIDC_CLIENT_ID,
                clientSecret: parsed.JW_DASHBOARD_OIDC_CLIENT_SECRET,
              }
            : undefined,
      },
      callBuffer: parsed.JW_DASHBOARD_CALL_BUFFER,
      charsPerToken: parsed.JW_TOKEN_CHARS_PER_TOKEN,
      fingerprint: parsed.JW_FINGERPRINT,
      profileVolumePrefix: parsed.JW_PROFILE_VOLUME_PREFIX,
      dataDir: parsed.JW_DATA_DIR,
      jobRetentionDays: parsed.JW_JOB_RETENTION_DAYS,
      dbPath: parsed.JW_DB_PATH ?? `${parsed.JW_DATA_DIR.replace(/\/+$/, '')}/jobwatch.sqlite`,
      adaptersFromEnv,
      utilitiesFromEnv,
      idleTtlS: parsed.JW_IDLE_TTL_S,
      maxLifetimeS: parsed.JW_MAX_LIFETIME_S,
      queueTimeoutS: parsed.JW_QUEUE_TIMEOUT_S,
      memHighMb: parsed.JW_MEM_HIGH_MB,
      memMaxMb: parsed.JW_MEM_MAX_MB,
      logLevel: parsed.JW_LOG_LEVEL,
      metrics: { enabled: parsed.JW_METRICS_ENABLED, port: parsed.JW_METRICS_PORT },
    },
  };
}

/** The only settings the CLI needs. It must work without the public base URL, which only the server requires. */
export interface StorageSettings {
  dataDir: string;
  /** From JW_ADAPTERS; when defined it overrides adapters.json. */
  adaptersFromEnv: readonly string[] | undefined;
  /** From JW_UTILITIES; when defined it overrides the `utilities` of adapters.json. */
  utilitiesFromEnv: readonly string[] | undefined;
}

const storageSchema = z.object({ JW_DATA_DIR: z.string().min(1).default('/data') });

/** Parse JW_DATA_DIR, JW_ADAPTERS and JW_UTILITIES only. Throws `ConfigError`; same rules as `loadConfig` for these two variables. */
export function loadStorageSettings(env: Readonly<Record<string, string | undefined>>): StorageSettings {
  const problems: string[] = [];
  const result = storageSchema.safeParse({ JW_DATA_DIR: env['JW_DATA_DIR'] === '' ? undefined : env['JW_DATA_DIR'] });
  if (!result.success) problems.push(...result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`));
  let adaptersFromEnv: string[] | undefined;
  if (env['JW_ADAPTERS'] !== undefined) {
    const list = parseAdapterList(env['JW_ADAPTERS']);
    problems.push(...list.problems);
    adaptersFromEnv = list.ids;
  }
  let utilitiesFromEnv: string[] | undefined;
  if (env['JW_UTILITIES'] !== undefined) {
    const list = parseAdapterList(env['JW_UTILITIES'], 'JW_UTILITIES');
    problems.push(...list.problems);
    utilitiesFromEnv = list.ids;
  }
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return { dataDir: result.data.JW_DATA_DIR, adaptersFromEnv, utilitiesFromEnv };
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
