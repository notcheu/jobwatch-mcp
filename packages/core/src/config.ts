import { z } from '@jobwatch/sdk';
import { ConfigError } from './errors';

/** Ids of adapters, as used in adapters.json and JW_ADAPTERS. Same pattern as `validateAdapter`. */
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackUrl = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

const integer = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Every JW_* variable the router reads (03-router-spec.md, "Configuration"). */
const envSchema = z.object({
  JW_BASE_URL: z.url({ protocol: /^https?$/ }),
  JW_AUTH: z.enum(['front', 'none']).default('front'),
  JW_FRONT_SHARED_SECRET: z.string().min(16).optional(),
  JW_LISTEN_HOST: z.string().min(1).default('0.0.0.0'),
  JW_PORT: integer(1024, 65535, 8080),
  JW_RUNTIME: z.enum(['docker', 'systemd-scope']).default('docker'),
  JW_BROWSER_IMAGE: z.string().min(1).default('localhost/jobwatch-browser:1'),
  JW_PROFILE_VOLUME_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .default('jw-profile-'),
  JW_DATA_DIR: z.string().min(1).default('/data'),
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
  profileVolumePrefix: string;
  dataDir: string;
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
      profileVolumePrefix: parsed.JW_PROFILE_VOLUME_PREFIX,
      dataDir: parsed.JW_DATA_DIR,
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

/** A copy of the configuration that is safe to log or print (secrets replaced). */
export function describeConfig(config: Config): Record<string, unknown> {
  return { ...config, frontSharedSecret: config.frontSharedSecret === undefined ? undefined : '[redacted]' };
}
