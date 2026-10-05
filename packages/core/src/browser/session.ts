/**
 * THE ONLY FILE THAT IMPORTS playwright-core (enforced by lint). Everything adapters can do with the browser is the
 * `BrowserSession` built here from the one existing tab; swapping Playwright for Patchright or raw CDP means changing
 * this file and nothing else.
 *
 * Rules (docs/plans/05-browser-runtime.md, docs/plans/06-memory-and-lifecycle-policy.md): connect by IP; use the tab Chrome started with;
 * NEVER `newPage()`; close any other tab that appears; park the tab on about:blank instead of closing it. The exception is a browser
 * that is not ours (`shared`): there we open one tab of our own, touch no other, and close ours when the call ends.
 */
import { isUrlAllowed, type BrowserSession } from '@jobwatch/sdk';
import { devtoolsBaseUrl } from './address';
import { createGuardedSession, type PageLike, type TabSupport } from './pageSession';

export interface BrowserConnection {
  /** Navigation and reading, bound to the adapter's host allowlist. */
  session: BrowserSession;
  /** Navigate the single tab to about:blank: releases the page's renderer memory and keeps the window open. */
  park(): Promise<void>;
  /** Give the allowed hosts' session cookies an expiry so they outlive a browser restart; returns how many were changed. */
  keepSessionCookies(): Promise<number>;
  /** Close stray tabs and collect garbage. Used when memory passes the warn mark. */
  shedMemory(): Promise<void>;
  /** Ask the browser to quit cleanly (Browser.close over CDP). */
  quit(): Promise<void>;
  /** Detach from the browser without quitting it. */
  disconnect(): Promise<void>;
}

/** Opens a CDP connection. Injected, so everything above this file runs against fakes in tests. */
export type ConnectBrowser = (address: string, allowedHosts: readonly string[], options?: ConnectOptions) => Promise<BrowserConnection>;

export interface ConnectOptions {
  /** Most tabs at once; 1 (default) keeps the single-tab rule. */
  maxTabs?: number;
  /**
   * The browser is somebody's own (`JW_CDP_URL`, or a local Chrome): open a tab of ours instead of taking the first one,
   * leave every other tab alone (never close, route or park them), close only the tabs we opened, and leave the cookies as they are.
   */
  shared?: boolean;
}

export const SESSION_COOKIE_TTL_S = 30 * 24 * 3600;

interface CookieLike {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The session cookies (no expiry) that belong to one of the hosts, copied with an expiry `ttlS` seconds from `nowS`. */
export function persistentCopies(cookies: readonly CookieLike[], hosts: readonly string[], nowS: number, ttlS = SESSION_COOKIE_TTL_S) {
  const belongs = (cookie: CookieLike): boolean => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return hosts.some((host) => host === domain || host.endsWith(`.${domain}`));
  };
  return cookies
    .filter((cookie) => cookie.expires === -1 && belongs(cookie))
    .map((cookie) => ({ ...cookie, expires: Math.floor(nowS) + ttlS }));
}

/**
 * Connect to the browser container by IP (DevTools rejects other Host headers, G2). The playwright-core module is loaded
 * on first use, so a router that only serves HTTP adapters never loads it.
 */
export const connectBrowser: ConnectBrowser = async (address, allowedHosts, options = {}) => {
  const maxTabs = Math.max(1, Math.floor(options.maxTabs ?? 1));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(devtoolsBaseUrl(address), { timeout: 15_000 });
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('the browser has no default context');
    const shared = options.shared === true;
    // Our tabs. In a container the browser is ours entirely, so the tab it started with is used and every other one is stray.
    // In a shared browser we open our own tab and only ever close or route the ones in this set.
    const ours = new Set<PageLike>();
    let page: Awaited<ReturnType<typeof context.newPage>>;
    if (shared) {
      page = await context.newPage();
    } else {
      const [first, ...strays] = context.pages();
      if (first === undefined) throw new Error('the browser has no tab');
      page = first;
      for (const stray of strays) await stray.close().catch(() => undefined);
    }
    ours.add(page as unknown as PageLike);

    // Documents and frames only: a navigation to a host the adapter did not declare (a redirect, a link, a popup) is refused.
    // Sub-resources (scripts, images) are the site's own business and load normally; blocking them would also change how
    // the session looks to the site (decision recorded in docs/plans/05-browser-runtime.md).
    // In a shared browser the rule is set on our tabs only: a context-wide route would also block the operator's own tabs.
    const guard = async (route: Parameters<Parameters<typeof context.route>[1]>[0]): Promise<void> => {
      const request = route.request();
      if (request.isNavigationRequest() && !isUrlAllowed(request.url(), allowedHosts)) await route.abort('blockedbyclient');
      else await route.continue();
    };
    if (shared) await page.route('**/*', guard);
    else await context.route('**/*', guard);
    // A popup or target=_blank would be a second tab: close it at once. The only tabs that stay are the ones `openTab` asks for.
    // In a shared browser only a popup of one of our tabs is ours to close; a tab the operator opens meanwhile is theirs.
    let opening = false;
    context.on('page', (opened) => {
      if (opening || ours.has(opened as unknown as PageLike)) return;
      if (!shared) {
        if (opened !== page) void opened.close().catch(() => undefined);
        return;
      }
      void opened
        .opener()
        .then((opener) => (opener !== null && ours.has(opener as unknown as PageLike) ? opened.close() : undefined))
        .catch(() => undefined);
    });

    const tabs: TabSupport | undefined =
      maxTabs <= 1
        ? undefined
        : {
            max: maxTabs,
            open: async () => {
              if (ours.size >= maxTabs || (!shared && context.pages().length >= maxTabs))
                throw new Error(`At most ${maxTabs} tabs may be open.`);
              opening = true;
              try {
                const extra = await context.newPage();
                ours.add(extra as unknown as PageLike);
                if (shared) await extra.route('**/*', guard);
                return extra as unknown as PageLike;
              } finally {
                opening = false;
              }
            },
            close: async (extra) => {
              ours.delete(extra);
              await (extra as unknown as { close(): Promise<void> }).close();
            },
          };
    const closeExtraTabs = async (): Promise<void> => {
      const others = shared
        ? [...ours].filter((tab) => tab !== (page as unknown as PageLike))
        : context.pages().filter((tab) => tab !== page);
      for (const other of others) {
        ours.delete(other as PageLike);
        await (other as unknown as { close(): Promise<void> }).close().catch(() => undefined);
      }
    };
    const session = createGuardedSession(page as unknown as PageLike, allowedHosts, tabs);
    return {
      session,
      park: async () => {
        await closeExtraTabs(); // a tab the adapter left open does not outlive its call
        // A shared browser gets its window back as it was: our tab is closed instead of parked on about:blank.
        if (shared) await page.close();
        else await page.goto('about:blank', { timeout: 10_000, waitUntil: 'domcontentloaded' });
      },
      keepSessionCookies: async () => {
        if (shared) return 0; // the operator's own browser keeps its cookies as it sees fit
        const copies = persistentCopies(await context.cookies(), allowedHosts, Date.now() / 1000);
        if (copies.length > 0) await context.addCookies(copies);
        return copies.length;
      },
      shedMemory: async () => {
        await closeExtraTabs();
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send('HeapProfiler.collectGarbage');
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      },
      quit: async () => {
        if (shared) return; // never quit a browser that is not ours
        const cdp = await browser.newBrowserCDPSession();
        // Chrome exits before it can answer, so the call is expected to fail; the container then stops on its own.
        await cdp.send('Browser.close').catch(() => undefined);
      },
      disconnect: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
};
