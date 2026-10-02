/**
 * Error model shared by the engine and the adapters (docs/plans/03-router-spec.md, "Error model").
 * Tool errors reach the client as `{ code, message, retry_after_s, details }`.
 * NEVER put cookies, tokens, full URLs with session parameters, or raw HTML in a message or in `details`
 * (use `redactUrl` for URLs).
 */
export const ERROR_CODES = [
  'invalid_arguments',
  'needs_login',
  'checkpoint',
  'rate_limited',
  'busy',
  'budget_exceeded',
  'oom_killed',
  'timeout',
  'adapter_broken',
  'upstream_error',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retry_after_s: number | null;
  details: Record<string, unknown>;
}

export interface ErrorOptions {
  retryAfterS?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class JobwatchError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterS: number | null;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryAfterS = options.retryAfterS ?? null;
    this.details = options.details ?? {};
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, retry_after_s: this.retryAfterS, details: this.details };
  }
}

/** The platform session is gone: the user must sign in again. Opens the circuit breaker (`needs_login`). */
export class SessionInvalid extends JobwatchError {
  constructor(message = 'The platform session is not signed in.', options?: ErrorOptions) {
    super('needs_login', message, options);
  }
}

/** The platform asked for a security verification (captcha, challenge). Opens the breaker for hours (`checkpoint`). */
export class Checkpoint extends JobwatchError {
  constructor(message = 'The platform asked for a security verification.', options?: ErrorOptions) {
    super('checkpoint', message, options);
  }
}

/** The page or API no longer looks like what the adapter expects (selector drift, shape change). Never an empty result. */
export class AdapterBroken extends JobwatchError {
  constructor(message: string, options?: ErrorOptions) {
    super('adapter_broken', message, options);
  }
}

/** The remote site failed in a way that is not our fault (HTTP 5xx, network error). */
export class UpstreamError extends JobwatchError {
  constructor(message: string, options?: ErrorOptions) {
    super('upstream_error', message, options);
  }
}

/** An adapter tried to reach a host or scheme it did not declare. This is a bug in the adapter, never user input. */
export class HostNotAllowedError extends JobwatchError {
  constructor(host: string) {
    super('internal', `Blocked request to a host that is not in the adapter's allowedHosts: ${host}`);
  }
}
