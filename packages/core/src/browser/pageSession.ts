import { JobwatchError, UpstreamError, assertUrlAllowed, type BrowserSession, type BrowserTab, type GotoOptions } from '@jobwatch/sdk';

/**
 * The few Playwright `Page` methods the session needs. A structural type, so the logic below is tested with a fake page and
 * `session.ts` (the only file that imports playwright-core) just hands over the real one.
 */
export interface PageLike {
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
  evaluate(script: string | ((arg: never) => unknown), arg?: unknown): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number; state: 'attached' }): Promise<unknown>;
  textContent(selector: string, options: { timeout: number }): Promise<string | null>;
  url(): string;
}

const MAX_SELECTOR_CHARS = 500;
const MAX_TIMEOUT_MS = 120_000;
const TEXT_TIMEOUT_MS = 1000;

/** Turn a Playwright failure into a client-safe error. The original stays as `cause` for the log; messages here carry no URLs. */
export function mapBrowserError(error: unknown): Error {
  if (error instanceof JobwatchError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || /^Timeout \d+ms exceeded/.test(message))
    return new JobwatchError('timeout', 'The page did not load or respond in time.', { cause: error });
  if (/net::ERR_/.test(message)) return new UpstreamError('The page could not be reached.', { cause: error });
  if (
    /Target (page, context or browser )?(has been )?closed|Target crashed|Page crashed|browser has been closed|Connection closed/i.test(
      message,
    )
  ) {
    return new JobwatchError('internal', 'The browser page crashed or was closed.', { cause: error });
  }
  return new JobwatchError('internal', 'The browser reported an unexpected error.', { cause: error });
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms < 1) throw new JobwatchError('internal', 'An adapter passed an invalid timeout.');
  return Math.min(Math.floor(ms), MAX_TIMEOUT_MS);
}

function checkSelector(selector: string): void {
  if (selector.length === 0 || selector.length > MAX_SELECTOR_CHARS)
    throw new JobwatchError('internal', 'An adapter passed an invalid selector.');
}

/**
 * The `BrowserSession` adapters receive. By default there is exactly ONE tab and this object can only navigate it. With
 * `tabs` (multi-tab on) it can also open extra tabs, each guarded by the same allowlist, up to `tabs.max`. Every `goto` is
 * checked against the adapter's host allowlist first (https only, exact host).
 * The same allowlist is enforced a second time, on every navigation the page makes by itself (redirects, links), by the
 * request router that `session.ts` installs.
 */
/** What `createGuardedSession` needs to open extra tabs: the limit, and a way to get a new page and to close it again. */
export interface TabSupport<P extends PageLike = PageLike> {
  max: number;
  /** Open a page; it throws when the limit is reached. */
  open(): Promise<P>;
  close(page: P): Promise<void>;
}

export function createGuardedSession(page: PageLike, allowedHosts: readonly string[], tabs?: TabSupport): BrowserSession {
  return {
    maxTabs: Math.max(1, tabs?.max ?? 1),

    async openTab(): Promise<BrowserTab> {
      if (tabs === undefined || tabs.max <= 1)
        throw new JobwatchError('internal', 'Multi-tab is off (JW_BROWSER_MULTITAB): only one tab is allowed.');
      let opened: PageLike;
      try {
        opened = await tabs.open();
      } catch (error) {
        throw mapBrowserError(error);
      }
      // an extra tab cannot open further tabs: only the session can, so the limit is checked in one place
      const inner = createGuardedSession(opened, allowedHosts);
      let closed = false;
      return Object.assign(Object.create(inner) as BrowserSession, inner, {
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          await tabs.close(opened).catch(() => undefined);
        },
        openTab: () => Promise.reject(new JobwatchError('internal', 'A tab cannot open another tab: ask the session.')),
      }) as BrowserTab;
    },

    async goto(url: string, options: GotoOptions): Promise<void> {
      const target = assertUrlAllowed(url, allowedHosts);
      const timeout = clampTimeout(options.timeoutMs);
      const started = Date.now();
      try {
        await page.goto(target.toString(), { timeout, waitUntil: 'domcontentloaded' });
        if (options.waitFor !== undefined) {
          checkSelector(options.waitFor);
          await page.waitForSelector(options.waitFor, { timeout: Math.max(1, timeout - (Date.now() - started)), state: 'attached' });
        }
      } catch (error) {
        throw mapBrowserError(error);
      }
    },

    async evaluate<T, A = undefined>(script: string | ((arg: A) => T), arg?: A): Promise<T> {
      try {
        // Playwright evaluates a STRING as an expression, so `'() => 1'` would return the function itself, not 1 (found by the
        // integration test against a real browser). The contract is: a string is a function expression, called with `arg`
        // (this is how `linkedin-extract.js` is written). The argument travels as JSON, so it must be JSON-serialisable.
        if (typeof script === 'string') return (await page.evaluate(`(${script})(${arg === undefined ? '' : JSON.stringify(arg)})`)) as T;
        return (await page.evaluate(script as (arg: never) => unknown, arg)) as T;
      } catch (error) {
        throw mapBrowserError(error);
      }
    },

    async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
      checkSelector(selector);
      try {
        await page.waitForSelector(selector, { timeout: clampTimeout(timeoutMs), state: 'attached' });
        return true;
      } catch (error) {
        const mapped = mapBrowserError(error);
        if (mapped instanceof JobwatchError && mapped.code === 'timeout') return false;
        throw mapped;
      }
    },

    async text(selector: string): Promise<string | null> {
      checkSelector(selector);
      try {
        return await page.textContent(selector, { timeout: TEXT_TIMEOUT_MS });
      } catch (error) {
        const mapped = mapBrowserError(error);
        if (mapped instanceof JobwatchError && mapped.code === 'timeout') return null;
        throw mapped;
      }
    },

    url: () => page.url(),
  };
}
