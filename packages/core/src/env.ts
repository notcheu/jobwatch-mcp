import { z } from '@jobwatch/sdk';

const integer = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Every environment variable the server reads, with its type, range and default. The one place that says what is valid
 * (documented in docs/environment-variables.md). Variables of other tools in the environment are ignored.
 */
export const envSchema = z.object({
  BASE_URL: z.url({
    protocol: /^https?$/,
    error: (issue) =>
      issue.input === undefined
        ? 'is required: the public URL, e.g. https://mcp.example.com'
        : 'must be an http(s) URL, e.g. https://mcp.example.com',
  }),
  AUTH: z.enum(['front', 'none']).default('front'),
  FRONT_SHARED_SECRET: z.string().min(16).optional(),
  LISTEN_HOST: z.string().min(1).default('0.0.0.0'),
  PORT: integer(1024, 65535, 8080),
  BROWSER_RUNTIME: z.enum(['docker', 'systemd-scope']).default('docker'),
  BROWSER_IMAGE: z.string().min(1).default('localhost/jobwatch-browser:1'),
  BROWSER_NETWORK: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .default('jobwatch-browsers'),
  DEFAULT_LOCATION: z.string().trim().max(100).optional(),
  LINKEDIN_GEO_ALIASES: z.string().max(2000).optional(),
  BROWSER_SECCOMP: z.string().startsWith('/').optional(),
  BROWSER_LANG: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .default('fr-FR'),
  BROWSER_ACCEPT_LANGS: z
    .string()
    .regex(/^[A-Za-z0-9,;=.-]{2,512}$/)
    .optional(),
  BROWSER_MAX_TABS: z.coerce.number().int().min(1).default(3),
  BROWSER_LOCAL_CHROME: flag.default(false),
  BROWSER_LOCAL_CHROME_PATH: z.string().min(1).optional(),
  BROWSER_CDP_URL: z.string().min(1).optional(),
  DASHBOARD_PORT: integer(1024, 65535, 8090),
  DASHBOARD_URL: z.url().optional(),
  DASHBOARD_STATIC_DIR: z.string().min(1).optional(),
  DASHBOARD_IDLE_S: integer(60, 86_400, 1800),
  DASHBOARD_SESSION_MAX_S: integer(300, 604_800, 28_800),
  DASHBOARD_WRITE_WINDOW_S: integer(0, 86_400, 600),
  // The OAuth front's own settings, shared through the same .env: the dashboard signs in with this client unless it has one of its own.
  OIDC_ISSUER_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).max(300).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).max(300).optional(),
  DASHBOARD_OIDC_ISSUER: z.url().optional(),
  DASHBOARD_OIDC_CLIENT_ID: z.string().min(1).max(300).optional(),
  DASHBOARD_OIDC_CLIENT_SECRET: z.string().min(1).max(300).optional(),
  DASHBOARD_CALL_BUFFER: integer(100, 20_000, 2000),
  TOKEN_CHARS_PER_TOKEN: z.coerce.number().min(1).max(10).default(3.5),
  BROWSER_FINGERPRINT: z.enum(['enforce', 'warn', 'off']).default('enforce'),
  BROWSER_PROFILE_VOLUME_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .default('jw-profile-'),
  DATA_DIR: z.string().min(1).default('/data'),
  DB_PATH: z.string().min(1).optional(),
  JOB_RETENTION_DAYS: integer(1, 3650, 30),
  ADAPTERS: z.string().optional(),
  UTILITIES: z.string().optional(),
  BROWSER_IDLE_TTL_S: integer(10, 3600, 120),
  BROWSER_MAX_LIFETIME_S: integer(60, 86_400, 1800),
  BROWSER_QUEUE_TIMEOUT_S: integer(1, 600, 60),
  BROWSER_MEM_HIGH_MB: integer(256, 16_384, 1200),
  BROWSER_MEM_MAX_MB: integer(256, 16_384, 1500),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  METRICS_ENABLED: flag.default(false),
  METRICS_PORT: integer(1024, 65535, 9464),
});

export type ParsedEnv = z.infer<typeof envSchema>;

/** The names the server reads, for the tests and the docs check. */
export const ENV_NAMES: readonly string[] = Object.keys(envSchema.shape);

export type EnvResult = { ok: true; data: ParsedEnv; warnings: string[] } | { ok: false; problems: string[] };

/**
 * Validate an environment (`process.env` or a test object). An empty value counts as "not set" (docker compose passes `VAR=` for unset
 * interpolations). Collects every problem at once and never echoes a value. The variables used to carry a `JW_` prefix: one that is
 * still set is reported, because it is no longer read.
 */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): EnvResult {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const warnings = Object.keys(present)
    .filter((key) => key.startsWith('JW_'))
    .map((key) => `${key} is not read any more: the JW_ prefix was dropped (${key.slice(3)})`);
  const result = envSchema.safeParse(present);
  if (!result.success)
    return { ok: false, problems: result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`) };
  return { ok: true, data: result.data, warnings };
}
