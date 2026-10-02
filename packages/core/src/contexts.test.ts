import {
  SDK_API_VERSION,
  defineAdapter,
  defineBrowserTool,
  defineHttpTool,
  z,
  type AdapterModule,
  type BrowserSession,
  type HttpClient,
} from '@jobwatch/sdk';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool } from './call';
import { createContextProvider, createJobStore } from './contexts';
import { Store } from './store/store';
import { createLogger } from './logging';
import { loadAdapters } from './registry';
import type { BrowserConnection } from './browser/session';
import { FakeBackend } from './runtime/fake';
import { RuntimeManager } from './runtime/manager';

const MB = 1024 * 1024;
const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
const output = z.object({ ok: z.boolean() });

function browserAdapter(
  handler: (session: BrowserSession) => Promise<void>,
  extra: Partial<Parameters<typeof defineAdapter>[0]> = {},
): AdapterModule {
  return defineAdapter({
    id: 'web',
    displayName: 'Web',
    description: 'Browser adapter.',
    sdkApi: SDK_API_VERSION,
    platform: 'web',
    kind: 'browser',
    allowedHosts: ['www.web.example.com'],
    tools: [
      defineBrowserTool({
        name: 'web_open',
        title: 'Open (read-only)',
        description: 'Opens a page. Read-only, no side effects.',
        input: z.object({}).strict(),
        output,
        annotations,
        limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048, memory: { highMb: 800, maxMb: 1000 } },
        handler: async (_args, { session }) => (await handler(session), { data: { ok: true }, warnings: [] }),
      }),
    ],
    ...extra,
  } as never);
}
const httpAdapter: AdapterModule = defineAdapter({
  id: 'api',
  displayName: 'Api',
  description: 'Http adapter.',
  sdkApi: SDK_API_VERSION,
  platform: 'api',
  kind: 'http',
  allowedHosts: ['api.example.com'],
  tools: [
    defineHttpTool({
      name: 'api_get',
      title: 'Get (read-only)',
      description: 'Gets. Read-only, no side effects.',
      input: z.object({}).strict(),
      output,
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
      handler: async (_args, { http }) =>
        (await http.get('https://api.example.com/x')).ok ? { data: { ok: true }, warnings: [] } : { data: { ok: false }, warnings: [] },
    }),
  ],
});

let backend: FakeBackend;
let steps: string[];
let logs: string;
const sink = () => new Writable({ write: (c, _e, d) => ((logs += String(c)), d()) });

function connection(session: BrowserSession): BrowserConnection {
  return {
    session,
    park: async () => void steps.push('park'),
    shedMemory: async () => undefined,
    quit: async () => undefined,
    disconnect: async () => void steps.push('disconnect'),
  };
}
const idleSession: BrowserSession = {
  goto: async () => undefined,
  evaluate: (async () => undefined) as never,
  waitForSelector: async () => true,
  text: async () => null,
  url: () => 'about:blank',
};

async function setup(
  adapters: AdapterModule[],
  opts: { connect?: (address: string, hosts: readonly string[]) => Promise<BrowserConnection>; withRuntime?: boolean } = {},
) {
  const logger = createLogger({ level: 'debug', destination: sink() });
  const runtime =
    opts.withRuntime === false
      ? undefined
      : new RuntimeManager(
          backend,
          {
            image: 'img',
            network: 'net',
            profileVolumePrefix: 'p-',
            idleTtlS: 120,
            maxLifetimeS: 1800,
            queueTimeoutS: 60,
            memMaxMb: 1500,
            memHighMb: 1200,
          },
          logger,
        );
  const connect = vi.fn(opts.connect ?? (async () => connection(idleSession)));
  const provider = createContextProvider({
    runtime,
    connect,
    logger,
    createHttp: () =>
      ({
        get: async () => ({ status: 200, ok: true, headers: {}, text: '', json: () => ({}) as never }),
        postJson: async () => ({}) as never,
      }) as HttpClient,
    pacerOptions: { sleep: async () => undefined },
  });
  const registry = await loadAdapters(
    adapters.map((a) => a.id),
    Object.fromEntries(adapters.map((a) => [a.id, async () => a])),
  );
  return { deps: { registry, contexts: provider, logger }, runtime, connect };
}

beforeEach(() => {
  backend = new FakeBackend();
  steps = [];
  logs = '';
});
afterEach(() => vi.useRealTimers());

describe('HTTP adapters', () => {
  it('get an allowlisted HttpClient, a logger and a pacer, and never touch the runtime', async () => {
    const t = await setup([httpAdapter], { withRuntime: false });
    const { outcome } = await callTool(t.deps, 'api_get', {});
    expect(outcome.code).toBe('ok');
    expect(t.connect).not.toHaveBeenCalled();
    expect(backend.calls).toEqual([]);
  });

  it('build the client with the adapter allowedHosts, once per adapter', async () => {
    const createHttp = vi.fn(
      () =>
        ({
          get: async () => ({ status: 200, ok: true, headers: {}, text: '', json: () => ({}) as never }),
          postJson: async () => ({}) as never,
        }) as HttpClient,
    );
    const logger = createLogger({ level: 'silent' });
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp });
    await (await provider.acquire(httpAdapter, 'r1')).release();
    await (await provider.acquire(httpAdapter, 'r2')).release();
    expect(createHttp).toHaveBeenCalledTimes(1);
    expect(createHttp).toHaveBeenCalledWith(expect.objectContaining({ allowedHosts: ['api.example.com'], openHttps: false }));
  });
});

describe('open https adapters', () => {
  it('builds the client open only for an adapter that declares openHttps, and logs the hosts it reaches', async () => {
    const createHttp = vi.fn(
      (_options: { openHttps: boolean; onOpenHost: (host: string) => void }) =>
        ({
          get: async () => ({ status: 200, ok: true, headers: {}, text: '', json: () => ({}) as never }),
          postJson: async () => ({}) as never,
        }) as HttpClient,
    );
    const logger = createLogger({ level: 'silent' });
    const info = vi.spyOn(logger, 'info');
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp });
    await (await provider.acquire({ ...httpAdapter, openHttps: true }, 'r1')).release();
    const options = createHttp.mock.calls[0]?.[0];
    expect(options?.openHttps).toBe(true);
    options?.onOpenHost('careers.bsport.io');
    expect(info).toHaveBeenCalledWith({ adapter: httpAdapter.id, host: 'careers.bsport.io' }, 'open_https_request');
  });
});

describe('browser adapters', () => {
  it('lease the runtime, connect by IP with the adapter hosts, and give the handler the session', async () => {
    const seen: string[] = [];
    const t = await setup([browserAdapter(async (session) => void seen.push(session.url()))]);
    const { outcome } = await callTool(t.deps, 'web_open', {});
    expect(outcome.code).toBe('ok');
    expect(t.connect).toHaveBeenCalledWith(expect.stringMatching(/^172\.18\.0\./), ['www.web.example.com']);
    expect(seen).toEqual(['about:blank']);
  });

  it('start the runtime with the largest per-tool memory budget', async () => {
    const t = await setup([browserAdapter(async () => undefined)]);
    await callTool(t.deps, 'web_open', {});
    expect(backend.containers.get('jw-web')?.spec).toMatchObject({ memoryMb: 1000, memoryReservationMb: 800 });
  });

  it('release in order: park the tab, drop the connection, hand the runtime back (idle grace)', async () => {
    const t = await setup([browserAdapter(async () => undefined)]);
    await callTool(t.deps, 'web_open', {});
    expect(steps).toEqual(['park', 'disconnect']);
    expect(t.runtime?.status().current?.state).toBe('idle_grace');
  });

  it('release even when the handler fails, and a failing park or disconnect does not stop the rest', async () => {
    const failing: BrowserConnection = {
      ...connection(idleSession),
      park: async () => {
        throw new Error('page crashed');
      },
      disconnect: async () => {
        throw new Error('already gone');
      },
    };
    const t = await setup(
      [
        browserAdapter(async () => {
          throw new Error('handler bug');
        }),
      ],
      { connect: async () => failing },
    );
    const { outcome } = await callTool(t.deps, 'web_open', {});
    expect(outcome.code).toBe('internal');
    expect(t.runtime?.status().current?.state).toBe('idle_grace'); // the lease was still released
    expect(logs).toContain('park_failed');
    expect(logs).toContain('disconnect_failed');
  });

  it('a connection failure releases the lease and returns a generic error naming only the platform', async () => {
    const t = await setup([browserAdapter(async () => undefined)], {
      connect: async () => {
        throw new Error('ECONNREFUSED 172.18.0.5:9222 secret-detail');
      },
    });
    const { result, outcome } = await callTool(t.deps, 'web_open', {});
    expect(outcome.code).toBe('internal');
    expect(result.content[0]?.text).toContain('Could not connect to the web browser.');
    expect(result.content[0]?.text).not.toContain('secret-detail');
    expect(result.content[0]?.text).not.toContain('172.18');
    expect(t.runtime?.status().current?.state).toBe('idle_grace');
  });

  it('fail clearly when no browser runtime exists', async () => {
    const t = await setup([browserAdapter(async () => undefined)], { withRuntime: false });
    expect((await callTool(t.deps, 'web_open', {})).outcome.code).toBe('internal');
  });

  it('two calls reuse the warm runtime: one cold start', async () => {
    const t = await setup([browserAdapter(async () => undefined)]);
    await callTool(t.deps, 'web_open', {});
    await callTool(t.deps, 'web_open', {});
    expect(backend.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it('use the adapter pacing for ctx.pace', async () => {
    vi.useFakeTimers();
    const slept: number[] = [];
    const logger = createLogger({ level: 'silent' });
    const provider = createContextProvider({
      runtime: undefined,
      connect: vi.fn(),
      logger,
      createHttp: () => ({}) as HttpClient,
      pacerOptions: { sleep: async (ms) => void slept.push(ms), random: () => 0, now: () => Date.now() },
    });
    const lease = await provider.acquire({ ...httpAdapter, pacing: { minMs: 1200, maxMs: 1200 } } as AdapterModule, 'r');
    await lease.ctx.pace('page');
    vi.advanceTimersByTime(100);
    await lease.ctx.pace('page');
    expect(slept).toEqual([1100]);
  });
});

describe('a runtime killed under a running call', () => {
  beforeEach(() => vi.useFakeTimers());

  it('fails the call at once with budget_exceeded, without waiting for the tool timeout', async () => {
    const t = await setup([browserAdapter(() => new Promise<void>(() => undefined))]);
    const pending = callTool(t.deps, 'web_open', {});
    await vi.advanceTimersByTimeAsync(10);
    backend.memory.set('jw-web', 960 * MB); // 96% of the 1000 MB cap of this tool
    await vi.advanceTimersByTimeAsync(5000);
    const { outcome } = await pending;
    expect(outcome.code).toBe('budget_exceeded');
    expect(outcome.durationMs).toBeLessThan(5500);
    expect(backend.running).toEqual([]);
  });

  it('fails the call with oom_killed when the kernel kills the browser', async () => {
    const t = await setup([browserAdapter(() => new Promise<void>(() => undefined))]);
    const pending = callTool(t.deps, 'web_open', {});
    await vi.advanceTimersByTimeAsync(10);
    backend.die('jw-web', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).outcome.code).toBe('oom_killed');
  });

  it('still releases everything afterwards', async () => {
    const t = await setup([browserAdapter(() => new Promise<void>(() => undefined))]);
    const pending = callTool(t.deps, 'web_open', {});
    await vi.advanceTimersByTimeAsync(10);
    backend.die('jw-web', true);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(steps).toEqual(['park', 'disconnect']);
    const next = browserAdapter(async () => undefined);
    void next;
    expect(t.runtime?.status().waiting).toBe(0);
  });
});

describe('createJobStore', () => {
  it('scopes jobs to the platform and reports ISO times', async () => {
    const store = Store.open(':memory:');
    let now = Date.parse('2026-10-01T10:00:00Z');
    const linkedin = createJobStore(store, 'linkedin', () => now);
    const apec = createJobStore(store, 'apec', () => now);
    await linkedin.put({ id: '4000000001', title: 'T', company: 'C', location: null, url: 'https://x.test/1', description: 'D' });
    await apec.put({
      id: '4000000009',
      board: 'acme',
      title: 'T',
      company: 'C',
      location: null,
      url: 'https://x.test/9',
      description: 'D',
    });
    expect(await apec.get('4000000009')).toMatchObject({ source: 'apec', board: 'acme' });
    now += 3600_000;
    await linkedin.put({ id: '4000000001', title: 'T2', company: 'C', location: null, url: 'https://x.test/1', description: 'D2' });
    expect(await linkedin.known(['4000000001', '4000000009'])).toEqual(new Set(['4000000001']));
    expect(await apec.known(['4000000001'])).toEqual(new Set());
    expect(await linkedin.get('4000000001')).toMatchObject({
      title: 'T2',
      firstSeen: '2026-10-01T10:00:00.000Z',
      fetchedAt: '2026-10-01T11:00:00.000Z',
    });
    expect(await apec.get('4000000001')).toBeNull();
    expect(await linkedin.get('4000000001')).toMatchObject({ source: 'linkedin', board: null });
    store.close();
  });
});

describe('the call meter', () => {
  const logger = createLogger({ level: 'silent' });
  const fakeHttp = (): HttpClient =>
    ({
      get: async () => ({ status: 200, ok: true, headers: {}, text: '', json: () => ({}) as never }),
      postJson: async () => ({ status: 200, ok: true, headers: {}, text: '', json: () => ({}) as never }),
    }) as HttpClient;

  it('counts every HTTP request an adapter makes, successful or not, and what it reports with spend', async () => {
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp: fakeHttp });
    const lease = await provider.acquire(httpAdapter, 'r1');
    expect(lease.spent?.()).toBe(0);
    await lease.ctx.http.get('https://api.example.com/a');
    await lease.ctx.http.postJson('https://api.example.com/b', {});
    expect(lease.spent?.()).toBe(2);
    lease.ctx.spend();
    lease.ctx.spend(3);
    expect(lease.spent?.()).toBe(6);
    await lease.release();
  });

  it('counts a request that throws: it may have reached the site', async () => {
    const failing = (): HttpClient =>
      ({ get: async () => Promise.reject(new Error('network')), postJson: async () => Promise.reject(new Error('network')) }) as HttpClient;
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp: failing });
    const lease = await provider.acquire(httpAdapter, 'r1');
    await expect(lease.ctx.http.get('https://api.example.com/a')).rejects.toThrow('network');
    expect(lease.spent?.()).toBe(1);
    await lease.release();
  });

  it('refuses a spend that is not a positive whole number', async () => {
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp: fakeHttp });
    const lease = await provider.acquire(httpAdapter, 'r1');
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => lease.ctx.spend(bad), String(bad)).toThrow(RangeError);
    expect(lease.spent?.()).toBe(0);
    await lease.release();
  });

  it('keeps one meter per call', async () => {
    const provider = createContextProvider({ runtime: undefined, connect: vi.fn(), logger, createHttp: fakeHttp });
    const a = await provider.acquire(httpAdapter, 'a');
    const b = await provider.acquire(httpAdapter, 'b');
    await a.ctx.http.get('https://api.example.com/x');
    expect([a.spent?.(), b.spent?.()]).toEqual([1, 0]);
  });
});

describe('the call meter for a browser adapter', () => {
  it('counts every page load, whether or not it succeeds, and the units the adapter reports', async () => {
    let fail = false;
    const session: BrowserSession = {
      ...idleSession,
      goto: async () => {
        if (fail) throw new Error('navigation failed');
      },
    };
    const logger = createLogger({ level: 'silent' });
    const runtime = new RuntimeManager(
      backend,
      {
        image: 'img',
        network: 'net',
        profileVolumePrefix: 'p-',
        idleTtlS: 120,
        maxLifetimeS: 1800,
        queueTimeoutS: 60,
        memMaxMb: 1500,
        memHighMb: 1200,
      },
      logger,
    );
    const provider = createContextProvider({
      runtime,
      connect: async () => connection(session),
      logger,
      createHttp: () => ({}) as HttpClient,
      pacerOptions: { sleep: async () => undefined },
    });
    const browser = defineAdapter({
      id: 'site',
      displayName: 'Site',
      description: 'A browser adapter.',
      sdkApi: SDK_API_VERSION,
      platform: 'site',
      kind: 'browser',
      allowedHosts: ['www.example.com'],
      tools: [],
    });
    const lease = await provider.acquire(browser, 'r1');
    const browserCtx = lease.ctx as unknown as { session: BrowserSession; spend: (n?: number) => void };
    await browserCtx.session.goto('https://www.example.com/a', { timeoutMs: 1000 });
    fail = true;
    await expect(browserCtx.session.goto('https://www.example.com/b', { timeoutMs: 1000 })).rejects.toThrow('navigation failed');
    browserCtx.spend(2);
    expect(lease.spent?.()).toBe(4);
    await browserCtx.session.evaluate('() => 1');
    expect(lease.spent?.()).toBe(4); // evaluating a script is not a page load
    await lease.release();
  });
});
