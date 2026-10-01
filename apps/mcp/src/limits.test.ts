import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_API_VERSION, SessionInvalid, defineAdapter, defineHttpTool, z, type AdapterModule } from '@jobwatch/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeContexts } from './fixtures';
import { connectClient, installedFixtures, startTestServer, type TestServer } from './harness';
import { start } from './server';

const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;
let behaviour: () => Promise<{ data: { n: number }; warnings: string[] }>;

const budgeted: AdapterModule = defineAdapter({
  id: 'budgeted',
  displayName: 'Budgeted',
  description: 'Adapter with a tiny budget.',
  sdkApi: SDK_API_VERSION,
  platform: 'budgeted',
  kind: 'http',
  allowedHosts: ['api.budgeted.example.com'],
  rate: { perHour: 3, perDay: 10 },
  tools: [
    defineHttpTool({
      name: 'budgeted_run',
      title: 'Run (read-only)',
      description: 'Runs once. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ n: z.number() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
      handler: async () => behaviour(),
    }),
  ],
});

let now: number;
let server: TestServer;
const text = (result: unknown): Record<string, unknown> =>
  JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  behaviour = async () => ({ data: { n: 1 }, warnings: [] });
});
afterEach(async () => {
  await server?.stop();
});

const boot = (env: Record<string, string> = {}) =>
  startTestServer(env, ['budgeted'], { installed: { ...installedFixtures, budgeted: async () => budgeted }, clock: () => now });

describe('rate limiting over HTTP', () => {
  it('refuses the call after the budget with rate_limited and a retry time, then recovers', async () => {
    server = await boot();
    const client = await connectClient(server.url);
    for (let i = 0; i < 3; i += 1) expect((await client.callTool({ name: 'budgeted_run', arguments: {} })).isError).toBeFalsy();
    const refused = await client.callTool({ name: 'budgeted_run', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatchObject({ code: 'rate_limited', retry_after_s: 3600 });
    now += 3601 * 1000;
    expect((await client.callTool({ name: 'budgeted_run', arguments: {} })).isError).toBeFalsy();
    await client.close();
  });

  it('counts calls from different clients against the same platform budget', async () => {
    server = await boot();
    const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
    await a.callTool({ name: 'budgeted_run', arguments: {} });
    await b.callTool({ name: 'budgeted_run', arguments: {} });
    await a.callTool({ name: 'budgeted_run', arguments: {} });
    expect(text(await b.callTool({ name: 'budgeted_run', arguments: {} }))['code']).toBe('rate_limited');
    await a.close();
    await b.close();
  });

  it('never lets concurrent calls overshoot the budget', async () => {
    server = await boot();
    const clients = await Promise.all(Array.from({ length: 6 }, () => connectClient(server.url)));
    const results = await Promise.all(clients.map((client) => client.callTool({ name: 'budgeted_run', arguments: {} })));
    expect(results.filter((r) => !r.isError)).toHaveLength(3);
    expect(results.filter((r) => r.isError)).toHaveLength(3);
    await Promise.all(clients.map((client) => client.close()));
  });
});

describe('circuit breaker over HTTP', () => {
  it('a lost session opens the breaker: the next call is refused without running the tool', async () => {
    server = await boot();
    const client = await connectClient(server.url);
    behaviour = async () => {
      throw new SessionInvalid();
    };
    expect(text(await client.callTool({ name: 'budgeted_run', arguments: {} }))['code']).toBe('needs_login');
    let runs = 0;
    behaviour = async () => {
      runs += 1;
      return { data: { n: 1 }, warnings: [] };
    };
    expect(text(await client.callTool({ name: 'budgeted_run', arguments: {} }))['code']).toBe('needs_login');
    expect(runs).toBe(0);
    server.running.breaker.close('budgeted');
    expect((await client.callTool({ name: 'budgeted_run', arguments: {} })).isError).toBeFalsy();
    await client.close();
  });

  it('is visible in the metrics while open and gone when closed', async () => {
    server = await boot({ JW_METRICS_ENABLED: 'true' });
    const client = await connectClient(server.url);
    behaviour = async () => {
      throw new SessionInvalid();
    };
    await client.callTool({ name: 'budgeted_run', arguments: {} });
    const open = await (await fetch(server.metricsUrl as URL)).text();
    expect(open).toContain('jw_breaker_open{platform="budgeted",reason="needs_login"} 1');
    server.running.breaker.close('budgeted');
    expect(await (await fetch(server.metricsUrl as URL)).text()).not.toContain('jw_breaker_open{');
    await client.close();
  });

  it('logs when a breaker opens', async () => {
    server = await boot();
    const client = await connectClient(server.url);
    behaviour = async () => {
      throw new SessionInvalid();
    };
    await client.callTool({ name: 'budgeted_run', arguments: {} });
    expect(server.logs()).toContain('breaker_opened');
    await client.close();
  });
});

describe('call log', () => {
  it('records every call with its outcome and an arguments hash, and nothing else about the arguments', async () => {
    server = await boot();
    const client = await connectClient(server.url);
    await client.callTool({ name: 'budgeted_run', arguments: {} });
    await client.callTool({ name: 'budgeted_run', arguments: { sneaky: 'secret-value' } });
    const calls = server.running.store.recentCalls(10);
    expect(calls.map((c) => c.outcome).reverse()).toEqual(['ok', 'invalid_arguments']);
    expect(calls[0]).toMatchObject({ tool: 'budgeted_run', adapter: 'budgeted', platform: 'budgeted', ts: now });
    expect(JSON.stringify(calls)).not.toContain('secret-value');
    await client.close();
  });

  it('does not record protocol errors for tools that do not exist', async () => {
    server = await boot();
    const client = await connectClient(server.url);
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow();
    expect(server.running.store.countCalls()).toBe(0);
    await client.close();
  });
});

describe('persistence across a restart (a real database file)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jw-restart-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bootOnDisk = (extraEnv: Record<string, string> = {}) =>
    startTestServer({ JW_DB_PATH: join(dir, 'state', 'jobwatch.sqlite'), ...extraEnv }, ['budgeted'], {
      installed: { budgeted: async () => budgeted },
      clock: () => now,
    });

  it('remembers the spent budget and an open breaker after the router restarts', async () => {
    server = await bootOnDisk();
    let client = await connectClient(server.url);
    for (let i = 0; i < 3; i += 1) await client.callTool({ name: 'budgeted_run', arguments: {} });
    server.running.breaker.open('budgeted', 'checkpoint');
    await client.close();
    await server.stop();

    server = await bootOnDisk();
    expect(server.logs()).toContain('breaker_still_open');
    client = await connectClient(server.url);
    expect(text(await client.callTool({ name: 'budgeted_run', arguments: {} }))['code']).toBe('checkpoint');
    server.running.breaker.close('budgeted');
    expect(text(await client.callTool({ name: 'budgeted_run', arguments: {} }))['code']).toBe('rate_limited');
    await client.close();
  });

  it('creates the database with mode 0600 inside a directory it creates', async () => {
    server = await bootOnDisk();
    expect((await stat(join(dir, 'state', 'jobwatch.sqlite'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to start when the database cannot be opened, with a message that says what to check', async () => {
    await expect(
      startTestServer({ JW_DB_PATH: '/proc/nowhere/jobwatch.sqlite' }, ['budgeted'], { installed: { budgeted: async () => budgeted } }),
    ).rejects.toThrow(/Is JW_DATA_DIR writable\?/);
  });

  it('closes the database on shutdown so the WAL is flushed', async () => {
    server = await bootOnDisk();
    const client = await connectClient(server.url);
    await client.callTool({ name: 'budgeted_run', arguments: {} });
    await client.close();
    await server.stop();
    expect(() => server.running.store.countCalls()).toThrow();
  });
});

describe('start() is usable without the harness', () => {
  it('defaults the database to <JW_DATA_DIR>/jobwatch.sqlite', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'jw-default-db-'));
    try {
      const running = await start({
        env: { JW_BASE_URL: 'http://127.0.0.1:18999', JW_AUTH: 'none', JW_LISTEN_HOST: '127.0.0.1', JW_ADAPTERS: '', JW_DATA_DIR: dir2 },
        version: 't',
        installed: {},
        contexts: fakeContexts,
        logDestination: { write: () => true } as unknown as NodeJS.WritableStream,
        port: 0,
      });
      expect((await stat(join(dir2, 'jobwatch.sqlite'))).isFile()).toBe(true);
      await running.close(500);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
