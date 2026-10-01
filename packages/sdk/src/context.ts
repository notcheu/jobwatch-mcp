import type { z } from 'zod';

/**
 * Everything an adapter handler may touch. Nothing else is reachable by design: no Playwright types, no raw CDP,
 * no database, and (by lint rule) no Node network, file or process APIs (03-router-spec.md, "Adapter SDK").
 */

export type PaceKind = 'page' | 'detail';

export interface GotoOptions {
  timeoutMs: number;
  /** Optional selector to wait for after navigation. */
  waitFor?: string;
}

/**
 * The ONLY browser surface adapters see. Implemented once over Playwright/CDP in `@jobwatch/core`
 * (the single file importing playwright-core), so swapping Playwright for Patchright or raw CDP never touches an adapter.
 * There is exactly one tab (06-memory-and-lifecycle-policy.md): `goto` navigates it; nothing can open another.
 */
export interface BrowserSession {
  /** Navigate the single tab. Throws `HostNotAllowedError` unless the URL passes `isUrlAllowed` for the adapter. */
  goto(url: string, options: GotoOptions): Promise<void>;
  /** Run a script (source string or function) in the page. The result must be JSON-serialisable. */
  evaluate<T, A = undefined>(script: string | ((arg: A) => T), arg?: A): Promise<T>;
  /** Resolves true when the selector appears within the timeout, false otherwise (never throws on timeout). */
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  /** `textContent` of the first match, or null. */
  text(selector: string): Promise<string | null>;
  /** Current URL of the tab. */
  url(): string;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** Body as text (already capped by the client). */
  readonly text: string;
  /**
   * Parse the body as JSON and validate it against `schema`. A body that is not JSON or does not match the schema is
   * an `AdapterBroken` error: a changed response shape must never turn into an empty result.
   */
  json<T>(schema: z.ZodType<T>): T;
}

/** `fetch` wrapper: host allowlist, timeout, size cap and per-host pacing are enforced by the engine. */
export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  postJson(url: string, body: unknown, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface BaseContext {
  http: HttpClient;
  log: Logger;
  /** Human-like delay from the platform's pacing policy. */
  pace(kind: PaceKind): Promise<void>;
}

/** Context of a `kind: "http"` adapter: no browser, no container. */
export type HttpAdapterContext = BaseContext;

/** Context of a `kind: "browser"` adapter: the leased single-tab browser session as well. */
export interface BrowserAdapterContext extends BaseContext {
  session: BrowserSession;
}

export type SessionState = 'ok' | 'needs_login' | 'checkpoint' | 'unknown';

/** What an adapter's `sessionCheck` reports. The engine adds the platform and the timestamp. */
export interface SessionStatus {
  state: SessionState;
  note?: string;
}
