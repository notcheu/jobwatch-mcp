import { pino, type Logger as PinoLogger, type LevelWithSilentOrString } from 'pino';
import { redactUrl, type Logger } from '@jobwatch/sdk';

export type EngineLogger = PinoLogger;

/** Keys whose values must never reach a log line, matched case-insensitively anywhere in the key name. */
const SENSITIVE_KEY = /(cookie|token|secret|password|passwd|authorization|session|credential|api[-_]?key|li_at)/i;

/** Pino-level redaction for objects logged by the engine itself (request headers and common secret fields, one level deep). */
const PINO_REDACT = [
  'authorization',
  'cookie',
  'password',
  'token',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.token',
  '*.secret',
];

export interface LoggerOptions {
  level: LevelWithSilentOrString;
  /** Where to write; defaults to stdout. Tests pass a stream. */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions): EngineLogger {
  return pino(
    {
      level: options.level,
      redact: { paths: PINO_REDACT, censor: '[redacted]' },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination,
  );
}

/**
 * Sanitize the free-form fields an adapter passes to its logger: sensitive keys are replaced and URL values lose their
 * query string, userinfo and fragment (a session id often travels in a query string).
 */
export function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) out[key] = '[redacted]';
    else if (typeof value === 'string' && /^https?:\/\//i.test(value)) out[key] = redactUrl(value);
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else out[key] = '[object omitted]';
  }
  return out;
}

/** The SDK `Logger` an adapter receives: tagged with the adapter id and always sanitized. */
export function createAdapterLogger(base: EngineLogger, adapterId: string): Logger {
  const child = base.child({ adapter: adapterId });
  return {
    debug: (message, fields) => child.debug(sanitizeFields(fields), message),
    info: (message, fields) => child.info(sanitizeFields(fields), message),
    warn: (message, fields) => child.warn(sanitizeFields(fields), message),
    error: (message, fields) => child.error(sanitizeFields(fields), message),
  };
}
