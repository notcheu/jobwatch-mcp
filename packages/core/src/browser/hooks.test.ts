import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging';
import type { RuntimeHandle } from '../runtime/backend';
import { FINGERPRINT_SCRIPT } from './fingerprint';
import { createBrowserHooks, waitForDevTools, type BrowserHooksOptions } from './hooks';
import type { BrowserConnection } from './session';

const handle: RuntimeHandle = { name: 'jw-linkedin', platform: 'linkedin', address: '172.18.0.5' };
const goodFp = {
  webdriver: false,
  userAgent: 'Chrome/154',
  languages: ['fr-FR'],
  plugins: 5,
  chrome: 'object',
  timezone: 'Europe/Paris',
  globals: [],
};

function setup(over: Partial<BrowserHooksOptions> = {}, fp: unknown = goodFp) {
  let logs = '';
  const sink = new Writable({ write: (c, _e, d) => ((logs += String(c)), d()) });
  const calls: string[] = [];
  const connection: BrowserConnection = {
    session: {
      evaluate: (async (script: string) => (
        calls.push(`evaluate:${script === FINGERPRINT_SCRIPT ? 'fingerprint' : 'other'}`),
        fp
      )) as never,
      goto: async () => undefined,
      waitForSelector: async () => true,
      text: async () => null,
      url: () => 'about:blank',
      maxTabs: 1,
      openTab: async () => Promise.reject(new Error('one tab')),
    },
    park: async () => void calls.push('park'),
    keepSessionCookies: async () => 0,
    shedMemory: async () => void calls.push('shed'),
    quit: async () => void calls.push('quit'),
    disconnect: async () => void calls.push('disconnect'),
  };
  const connect = vi.fn(async (_address: string, _hosts: readonly string[]) => connection);
  const hooks = createBrowserHooks({
    connect,
    logger: createLogger({ level: 'debug', destination: sink }),
    fingerprint: 'enforce',
    expectations: {},
    fetchImpl: (async () => new Response('{}')) as typeof fetch,
    ...over,
  });
  return { hooks, calls, connect, logs: () => logs };
}

describe('waitForDevTools', () => {
  it('returns once DevTools answers on the container IP', async () => {
    const urls: string[] = [];
    await waitForDevTools(
      '172.18.0.5',
      5000,
      (async (url: string) => (urls.push(String(url)), new Response('{}'))) as typeof fetch,
      async () => undefined,
    );
    expect(urls).toEqual(['http://172.18.0.5:9222/json/version']);
  });

  it('retries until it answers', async () => {
    let n = 0;
    const doFetch = (async () => (++n < 3 ? Promise.reject(new Error('ECONNREFUSED')) : new Response('{}'))) as typeof fetch;
    await waitForDevTools('172.18.0.5', 60_000, doFetch, async () => undefined);
    expect(n).toBe(3);
  });

  it('fails at once on a malformed address instead of retrying until the deadline', async () => {
    let calls = 0;
    await expect(
      waitForDevTools('jw-linkedin', 60_000, (async () => (calls++, new Response('{}'))) as typeof fetch, async () => undefined),
    ).rejects.toThrow('must be an IP address');
    expect(calls).toBe(0);
  });

  it('also retries a non-2xx answer, and gives up at the deadline', async () => {
    await expect(
      waitForDevTools('172.18.0.5', 5, (async () => new Response('no', { status: 500 })) as typeof fetch, async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
    ).rejects.toThrow('DevTools did not answer in time');
  });
});

describe('ready hook (startup fingerprint check)', () => {
  it('connects by IP with NO allowed hosts (it only reads about:blank), checks, and always disconnects', async () => {
    const t = setup();
    await t.hooks.ready?.(handle);
    expect(t.connect).toHaveBeenCalledWith('172.18.0.5', []);
    expect(t.calls).toEqual(['evaluate:fingerprint', 'disconnect']);
  });

  it('enforce: an automated-looking browser fails the start, is logged, and still disconnects', async () => {
    const t = setup({}, { ...goodFp, webdriver: true });
    await expect(t.hooks.ready?.(handle)).rejects.toMatchObject({
      code: 'internal',
      message: 'The browser failed its startup fingerprint check.',
    });
    expect(t.logs()).toContain('fingerprint_mismatch');
    expect(t.logs()).toContain('navigator.webdriver is true');
    expect(t.calls.at(-1)).toBe('disconnect');
  });

  it('warn: logs the mismatch and lets the browser through', async () => {
    const t = setup({ fingerprint: 'warn' }, { ...goodFp, webdriver: true });
    await expect(t.hooks.ready?.(handle)).resolves.toBeUndefined();
    expect(t.logs()).toContain('fingerprint_mismatch');
  });

  it('off: skips the check entirely and never connects', async () => {
    const t = setup({ fingerprint: 'off' }, { ...goodFp, webdriver: true });
    await t.hooks.ready?.(handle);
    expect(t.connect).not.toHaveBeenCalled();
  });

  it('uses the configured language list', async () => {
    const t = setup({ expectations: { languages: ['fr-FR', 'en-GB'] } });
    await expect(t.hooks.ready?.(handle)).rejects.toMatchObject({ code: 'internal' });
  });

  it('fails the start when DevTools never answers', async () => {
    const t = setup({
      devtoolsTimeoutMs: 1,
      fetchImpl: (async () => Promise.reject(new Error('refused'))) as typeof fetch,
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    await expect(t.hooks.ready?.(handle)).rejects.toThrow('DevTools did not answer in time');
    expect(t.connect).not.toHaveBeenCalled();
  });
});

describe('quit and onWarn hooks', () => {
  it('quit connects, asks the browser to quit, and detaches', async () => {
    const t = setup();
    await t.hooks.quit?.(handle);
    expect(t.calls).toEqual(['quit', 'disconnect']);
  });

  it('onWarn sheds memory and detaches, even when shedding fails', async () => {
    const t = setup();
    await t.hooks.onWarn?.(handle);
    expect(t.calls).toEqual(['shed', 'disconnect']);
    const failing = setup();
    failing.connect.mockResolvedValueOnce({
      ...(await failing.connect('x', [])),
      shedMemory: async () => {
        throw new Error('cdp gone');
      },
      disconnect: async () => void failing.calls.push('disconnect'),
    });
    await expect(failing.hooks.onWarn?.(handle)).rejects.toThrow('cdp gone');
    expect(failing.calls).toContain('disconnect');
  });
});
