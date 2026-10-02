import { HostNotAllowedError, JobwatchError, UpstreamError } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { createGuardedSession, mapBrowserError, type PageLike } from './pageSession';

interface Call {
  method: string;
  args: unknown[];
}

function fakePage(over: Partial<PageLike> = {}): { page: PageLike; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };
  const page: PageLike = {
    goto: record('goto', null),
    evaluate: record('evaluate', { ok: true }),
    waitForSelector: record('waitForSelector', null),
    textContent: record('textContent', 'Hello'),
    url: () => 'https://www.example.com/a',
    ...over,
  } as PageLike;
  return { page, calls };
}
const hosts = ['www.example.com'];
const timeoutError = Object.assign(new Error('page.goto: Timeout 15000ms exceeded.'), { name: 'TimeoutError' });

describe('goto', () => {
  it('navigates an allowed URL with the domcontentloaded wait and the requested timeout', async () => {
    const { page, calls } = fakePage();
    await createGuardedSession(page, hosts).goto('https://www.example.com/jobs?x=1', { timeoutMs: 15_000 });
    expect(calls[0]).toEqual({
      method: 'goto',
      args: ['https://www.example.com/jobs?x=1', { timeout: 15_000, waitUntil: 'domcontentloaded' }],
    });
  });

  it('REFUSES every URL outside the allowlist without touching the page', async () => {
    const { page, calls } = fakePage();
    const session = createGuardedSession(page, hosts);
    for (const url of [
      'https://evil.example/',
      'http://www.example.com/',
      'https://www.example.com.evil.com/',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'chrome://settings',
      'https://user@www.example.com/',
      'https://www.example.com:8443/',
    ]) {
      await expect(session.goto(url, { timeoutMs: 1000 }), url).rejects.toBeInstanceOf(HostNotAllowedError);
    }
    expect(calls).toEqual([]);
  });

  it('waits for the optional selector within the remaining time', async () => {
    const { page, calls } = fakePage();
    await createGuardedSession(page, hosts).goto('https://www.example.com/', { timeoutMs: 10_000, waitFor: '#results' });
    expect(calls.map((c) => c.method)).toEqual(['goto', 'waitForSelector']);
    expect(calls[1]?.args[0]).toBe('#results');
    expect((calls[1]?.args[1] as { timeout: number }).timeout).toBeLessThanOrEqual(10_000);
  });

  it('caps the timeout at two minutes and refuses nonsense', async () => {
    const { page, calls } = fakePage();
    const session = createGuardedSession(page, hosts);
    await session.goto('https://www.example.com/', { timeoutMs: 9_999_999 });
    expect((calls[0]?.args[1] as { timeout: number }).timeout).toBe(120_000);
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(session.goto('https://www.example.com/', { timeoutMs })).rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('maps a timeout to the timeout code and a network error to upstream_error, with no URL in the message', async () => {
    const slow = createGuardedSession(
      fakePage({
        goto: async () => {
          throw timeoutError;
        },
      }).page,
      hosts,
    );
    await expect(slow.goto('https://www.example.com/', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'timeout' });
    const down = createGuardedSession(
      fakePage({
        goto: async () => {
          throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://www.example.com/?li_at=SECRET');
        },
      }).page,
      hosts,
    );
    const error = await down.goto('https://www.example.com/', { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(JSON.stringify((error as JobwatchError).toBody())).not.toContain('SECRET');
  });
});

describe('reading the page', () => {
  it('evaluate wraps a string script as a function expression CALLED with the argument (Playwright would otherwise just return the function)', async () => {
    const seen: unknown[][] = [];
    const { page } = fakePage({ evaluate: async (...args: unknown[]) => (seen.push(args), 42) });
    const session = createGuardedSession(page, hosts);
    expect(await session.evaluate<number, { ids: string[] }>('(a) => a.ids.length', { ids: ['1', '2'] })).toBe(42);
    expect(seen[0]).toEqual(['((a) => a.ids.length)({"ids":["1","2"]})']);
    await session.evaluate('() => document.title');
    expect(seen[1]).toEqual(['(() => document.title)()']);
  });

  it('evaluate passes a real function and its argument straight through', async () => {
    const seen: unknown[][] = [];
    const { page } = fakePage({ evaluate: async (...args: unknown[]) => (seen.push(args), 'ok') });
    const fn = (n: number) => n + 1;
    expect(await createGuardedSession(page, hosts).evaluate(fn, 1)).toBe('ok');
    expect(seen[0]).toEqual([fn, 1]);
  });

  it('a string argument is JSON-encoded, never spliced in as code', async () => {
    const seen: unknown[][] = [];
    const { page } = fakePage({ evaluate: async (...args: unknown[]) => (seen.push(args), null) });
    await createGuardedSession(page, hosts).evaluate('(s) => s', '"); document.cookie; ("');
    expect(seen[0]).toEqual(['((s) => s)("\\"); document.cookie; (\\"")']);
  });

  it('waitForSelector resolves true when found and false on timeout, but still reports a crash', async () => {
    expect(await createGuardedSession(fakePage().page, hosts).waitForSelector('#a', 500)).toBe(true);
    expect(
      await createGuardedSession(
        fakePage({
          waitForSelector: async () => {
            throw timeoutError;
          },
        }).page,
        hosts,
      ).waitForSelector('#a', 500),
    ).toBe(false);
    const crashed = createGuardedSession(
      fakePage({
        waitForSelector: async () => {
          throw new Error('Target crashed');
        },
      }).page,
      hosts,
    );
    await expect(crashed.waitForSelector('#a', 500)).rejects.toMatchObject({
      code: 'internal',
      message: 'The browser page crashed or was closed.',
    });
  });

  it('text returns the content, null when the element never shows up, and uses a short timeout', async () => {
    const { page, calls } = fakePage();
    expect(await createGuardedSession(page, hosts).text('h1')).toBe('Hello');
    expect(calls[0]?.args[1]).toEqual({ timeout: 1000 });
    expect(
      await createGuardedSession(
        fakePage({
          textContent: async () => {
            throw timeoutError;
          },
        }).page,
        hosts,
      ).text('h1'),
    ).toBeNull();
  });

  it('rejects empty and oversized selectors', async () => {
    const session = createGuardedSession(fakePage().page, hosts);
    for (const selector of ['', 'a'.repeat(501)]) {
      await expect(session.waitForSelector(selector, 100)).rejects.toMatchObject({ code: 'internal' });
      await expect(session.text(selector)).rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('url() reports the tab', () => {
    expect(createGuardedSession(fakePage().page, hosts).url()).toBe('https://www.example.com/a');
  });

  it('exposes no way to leave the page: the session has exactly these members, and openTab refuses unless multi-tab is on', () => {
    expect(Object.keys(createGuardedSession(fakePage().page, hosts)).sort()).toEqual([
      'evaluate',
      'goto',
      'maxTabs',
      'openTab',
      'text',
      'url',
      'waitForSelector',
    ]);
  });
});

describe('mapBrowserError', () => {
  it('leaves engine errors alone', () => {
    const own = new JobwatchError('rate_limited', 'x');
    expect(mapBrowserError(own)).toBe(own);
  });

  it.each([
    ['Target page, context or browser has been closed', 'internal'],
    ['Page crashed', 'internal'],
    ['Connection closed while reading from the driver', 'internal'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x', 'upstream_error'],
    ['Timeout 30000ms exceeded.', 'timeout'],
    ['something nobody expected', 'internal'],
  ])('%s -> %s', (message, code) => {
    expect(mapBrowserError(new Error(message))).toMatchObject({ code });
  });

  it('keeps the original as the cause for the log and never in the message', () => {
    const original = new Error('boom with https://x/?token=SECRET');
    const mapped = mapBrowserError(original) as JobwatchError;
    expect(mapped.cause).toBe(original);
    expect(mapped.message).not.toContain('SECRET');
  });

  it('copes with non-Error throws', () => {
    expect(mapBrowserError('a string')).toMatchObject({ code: 'internal' });
    expect(mapBrowserError(undefined)).toMatchObject({ code: 'internal' });
  });
});

describe('tabs', () => {
  const tabSupport = (max: number) => {
    const opened: ReturnType<typeof fakePage>[] = [];
    const closed: PageLike[] = [];
    return {
      opened,
      closed,
      support: {
        max,
        open: async () => {
          const extra = fakePage({ url: () => 'https://www.example.com/tab' });
          opened.push(extra);
          return extra.page;
        },
        close: async (page: PageLike) => void closed.push(page),
      },
    };
  };

  it('is one tab by default: maxTabs is 1 and openTab refuses', async () => {
    const session = createGuardedSession(fakePage().page, hosts);
    expect(session.maxTabs).toBe(1);
    await expect(session.openTab()).rejects.toThrow('JW_BROWSER_MULTITAB');
  });

  it('opens a tab that has the same allowlist and can be closed once', async () => {
    const t = tabSupport(3);
    const session = createGuardedSession(fakePage().page, hosts, t.support);
    expect(session.maxTabs).toBe(3);
    const tab = await session.openTab();
    await tab.goto('https://www.example.com/jobs', { timeoutMs: 5000 });
    expect(t.opened[0]?.calls[0]?.method).toBe('goto');
    await expect(tab.goto('https://evil.example.org/', { timeoutMs: 5000 })).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(tab.url()).toBe('https://www.example.com/tab');
    await tab.close();
    await tab.close();
    expect(t.closed).toHaveLength(1);
  });

  it('a tab cannot open another tab', async () => {
    const session = createGuardedSession(fakePage().page, hosts, tabSupport(3).support);
    const tab = await session.openTab();
    await expect(tab.openTab()).rejects.toBeInstanceOf(JobwatchError);
  });

  it('turns a failure to open (the limit) into a client-safe error', async () => {
    const session = createGuardedSession(fakePage().page, hosts, {
      max: 2,
      open: async () => Promise.reject(new Error('At most 2 tabs may be open.')),
      close: async () => undefined,
    });
    await expect(session.openTab()).rejects.toBeInstanceOf(JobwatchError);
  });
});
