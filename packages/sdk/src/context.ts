import type { z } from 'zod';

/**
 * Everything an adapter handler may touch. Nothing else is reachable by design: no Playwright types, no raw CDP,
 * no database, and (by lint rule) no Node network, file or process APIs (docs/plans/03-router-spec.md, "Adapter SDK").
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
 * There is exactly one tab by default (docs/plans/06-memory-and-lifecycle-policy.md): `goto` navigates it and nothing can open
 * another. `openTab()` adds tabs only when the operator allows more than one (`JW_BROWSER_MAX_TABS`, default 3), up to `maxTabs`.
 */
export interface BrowserSession {
  /** Navigate the single tab. Throws `HostNotAllowedError` unless the URL passes `isUrlAllowed` for the adapter. */
  goto(url: string, options: GotoOptions): Promise<void>;
  /**
   * Run a script in the page and return its JSON-serialisable result. A STRING is a function expression that is CALLED with
   * `arg` (`'(ids) => ids.length'`), the form `linkedin-extract.js` already has; `arg` then travels as JSON. A real function is
   * passed to the browser as is. (A bare expression such as `'1 + 1'` is not supported: wrap it, `'() => 1 + 1'`.)
   */
  evaluate<T, A = undefined>(script: string | ((arg: A) => T), arg?: A): Promise<T>;
  /** Resolves true when the selector appears within the timeout, false otherwise (never throws on timeout). */
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  /** `textContent` of the first match, or null. */
  text(selector: string): Promise<string | null>;
  /** Current URL of the tab. */
  url(): string;
  /** Most tabs that may be open at once, this one included. 1 (the default) means `openTab` always refuses. */
  readonly maxTabs: number;
  /**
   * Open one more tab with the same host allowlist, budget metering and error mapping. Throws when multi-tab is off or when
   * `maxTabs` tabs are already open. Close it with `close()` as soon as you are done: every tab costs memory, and any tab left
   * open is closed by the engine when the call ends.
   */
  openTab(): Promise<BrowserTab>;
}

/** An extra tab: the same surface as the session, plus `close`. */
export interface BrowserTab extends BrowserSession {
  close(): Promise<void>;
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

/** A job posting an adapter wants to remember. Third-party text: stored as data, never interpreted. */
export interface NewJob {
  /** Platform-local id (digits for LinkedIn). 1 to 64 of letters, digits, `_`, `-`. */
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string;
  /**
   * Where, within the platform, the posting was found: the company handle at an ATS (`bsport` on Teamtailor, `algolia` on
   * Greenhouse), `null` for a platform that is one big board (LinkedIn, Apec). The platform itself is recorded by the engine from
   * the adapter, never trusted from here. At most 120 characters.
   */
  board?: string | null;
  /** Capped by the engine (20 000 characters). */
  description: string;
}

export interface StoredJob extends NewJob {
  /** The platform the job was found on (`linkedin`, `teamtailor`, `apec`...): the adapter's platform, set by the engine. */
  source: string;
  board: string | null;
  /**
   * ISO times: first stored; last time the page was read (`fetchedAt`); last time the job was seen anywhere, search card
   * included (`lastSeen`, always >= `fetchedAt`). Retention counts from `lastSeen`.
   */
  firstSeen: string;
  fetchedAt: string;
  lastSeen: string;
}

/**
 * The adapter's memory of jobs it already opened, scoped to its platform by the engine (an adapter cannot read another
 * platform's rows). Stored jobs are evicted after `JW_JOB_RETENTION_DAYS`; a later search then treats them as new again.
 * Convention (LinkedIn, `docs/plans/07-adapter-linkedin.md`): store a job as soon as its page was read and its title was accepted, whether or
 * not its description then matched the caller's terms. A stored job is never read from the page again: it is judged from here,
 * with whatever terms the next call brings. Do not store what you only saw on a search card: that read is free to repeat.
 */
export interface JobStore {
  /** Which of `ids` are stored. Order and duplicates are irrelevant. */
  known(ids: readonly string[]): Promise<Set<string>>;
  get(id: string): Promise<StoredJob | null>;
  /**
   * Record that these jobs were seen just now (on a search page, say): refreshes `lastSeen` of the ones that are stored, so a
   * posting that is still listed is never evicted. Ids that are not stored are ignored.
   */
  touch(ids: readonly string[]): Promise<void>;
  /** Insert, or replace and refresh `fetchedAt` and `lastSeen` (keeps `firstSeen`). */
  put(job: NewJob): Promise<void>;
  /**
   * Remember a search: its keywords and the ids it listed, so that a later summary can say which keyword brought which job in.
   * `query` is the search text the caller typed (empty when there is none, for a whole-board listing); `found` is every id the
   * search listed, `returned` the ones it handed back to the caller. Never pass anything else: no credentials, no page content.
   */
  recordSearch(search: { query: string; found: readonly string[]; returned: readonly string[] }): Promise<void>;
}

export interface BaseContext {
  http: HttpClient;
  jobs: JobStore;
  log: Logger;
  /** Human-like delay from the platform's pacing policy. */
  pace(kind: PaceKind): Promise<void>;
  /**
   * Tell the engine the call just touched the site in a way it cannot see by itself, for `units` budget units (default 1): a request
   * made from inside the page, a "next page" button pressed. HTTP requests (`ctx.http`) and page loads (`session.goto`) are counted
   * automatically; do not report those. The count is what a failed call is charged, so report BEFORE the request can fail.
   */
  spend(units?: number): void;
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
