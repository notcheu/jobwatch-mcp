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
  JW_DASHBOARD_PORT: integer(1024, 65535, 8090),
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
  /** UI language and `navigator.languages` of the browser (copied from the everyday browser, 05 G8). The list is personal: keep it in the untracked deploy/.env. */
  browserLang: string;
  browserAcceptLangs: readonly string[] | undefined;
  /** Most tabs the browser may have open at once (`JW_BROWSER_MAX_TABS`, default 3, no upper limit). 1 = single tab: `openTab` refuses. */
  maxTabs: number;
  /** The operator dashboard (docs/plans/17-dashboard.md). Off until `jobwatch dashboard start`. */
  dashboard: {
    port: number;
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

/** Parse `JW_ADAPTERS`. Empty string means "explicitly none enabled". Returns problems instead of throwing. */
export function parseAdapterList(raw: string): { ids: string[]; problems: string[] } {
  const ids: string[] = [];
  const problems: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id === '') continue;
    if (!ADAPTER_ID_PATTERN.test(id)) problems.push(`JW_ADAPTERS: "${id}" is not a valid adapter id`);
    else if (ids.includes(id)) problems.push(`JW_ADAPTERS: "${id}" is listed twice`);
    else ids.push(id);
  }
  return { ids, problems };
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

  let adaptersFromEnv: string[] | undefined;
  if (env['JW_ADAPTERS'] !== undefined) {
    const list = parseAdapterList(env['JW_ADAPTERS']);
    problems.push(...list.problems);
    adaptersFromEnv = list.ids;
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
      maxTabs: parsed.JW_BROWSER_MAX_TABS,
      dashboard: {
        port: parsed.JW_DASHBOARD_PORT,
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
}

const storageSchema = z.object({ JW_DATA_DIR: z.string().min(1).default('/data') });

/** Parse JW_DATA_DIR and JW_ADAPTERS only. Throws `ConfigError`; same rules as `loadConfig` for these two variables. */
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
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return { dataDir: result.data.JW_DATA_DIR, adaptersFromEnv };
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
