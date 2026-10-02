/**
 * THE ONLY FILE THAT IMPORTS playwright-core (enforced by lint). Everything adapters can do with the browser is the
 * `BrowserSession` built here from the one existing tab; swapping Playwright for Patchright or raw CDP means changing
 * this file and nothing else.
 *
 * Rules (05-browser-runtime.md, 06-memory-and-lifecycle-policy.md): connect by IP; use the tab Chrome started with;
 * NEVER `newPage()`; close any other tab that appears; park the tab on about:blank instead of closing it.
 */
import { isUrlAllowed, type BrowserSession } from '@jobwatch/sdk';
import { devtoolsBaseUrl } from './address';
import { createGuardedSession, type PageLike } from './pageSession';

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
export type ConnectBrowser = (address: string, allowedHosts: readonly string[]) => Promise<BrowserConnection>;

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
export const connectBrowser: ConnectBrowser = async (address, allowedHosts) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(devtoolsBaseUrl(address), { timeout: 15_000 });
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('the browser has no default context');
    const [page, ...strays] = context.pages();
    if (page === undefined) throw new Error('the browser has no tab');
    for (const stray of strays) await stray.close().catch(() => undefined);

    // Documents and frames only: a navigation to a host the adapter did not declare (a redirect, a link, a popup) is refused.
    // Sub-resources (scripts, images) are the site's own business and load normally; blocking them would also change how
    // the session looks to the site (decision recorded in 05-browser-runtime.md).
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !isUrlAllowed(request.url(), allowedHosts)) await route.abort('blockedbyclient');
      else await route.continue();
    });
    // A popup or target=_blank would be a second tab: close it at once.
    context.on('page', (opened) => {
      if (opened !== page) void opened.close().catch(() => undefined);
    });

    const session = createGuardedSession(page as unknown as PageLike, allowedHosts);
    return {
      session,
      park: async () => {
        await page.goto('about:blank', { timeout: 10_000, waitUntil: 'domcontentloaded' });
      },
      keepSessionCookies: async () => {
        const copies = persistentCopies(await context.cookies(), allowedHosts, Date.now() / 1000);
        if (copies.length > 0) await context.addCookies(copies);
        return copies.length;
      },
      shedMemory: async () => {
        for (const other of context.pages()) if (other !== page) await other.close().catch(() => undefined);
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send('HeapProfiler.collectGarbage');
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      },
      quit: async () => {
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
