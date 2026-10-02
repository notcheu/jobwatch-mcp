import {
  Checkpoint,
  SDK_API_VERSION,
  SessionInvalid,
  defineAdapter,
  defineBrowserTool,
  z,
  type AdapterModule,
  type BaseContext,
  type BrowserSession,
  type SessionStatus,
} from '@jobwatch/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, type CallDeps, type ContextProvider } from '../call';
import { CircuitBreaker } from '../limits/breaker';
import { createGuard, policyFor } from '../limits/guard';
import { RateLimiter } from '../limits/ratelimit';
import { createLogger } from '../logging';
import { loadAdapters } from '../registry';
import { FakeBackend } from '../runtime/fake';
import { RuntimeManager } from '../runtime/manager';
import { Store } from '../store/store';
import { createOpsAdapter } from './ops';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
let check: () => Promise<SessionStatus>;
let checks: number;
let acquired: number;
let released: number;

function webAdapter(platform = 'web', withCheck = true): AdapterModule {
  return defineAdapter({
    id: platform,
    displayName: platform,
    description: platform,
    sdkApi: SDK_API_VERSION,
    platform,
    kind: 'browser',
    allowedHosts: [`www.${platform}.example.com`],
    ...(withCheck ? { sessionCheck: async () => (checks++, check()) } : {}),
    tools: [
      defineBrowserTool({
        name: `${platform}_noop`,
        title: 'Noop (read-only)',
        description: 'Does nothing. Read-only, no side effects.',
        input: z.object({}).strict(),
        output: z.object({ ok: z.boolean() }),
        annotations,
        limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
        handler: async () => ({ data: { ok: true }, warnings: [] }),
      }),
    ],
  } as never);
}
const httpOnly: AdapterModule = defineAdapter({
  id: 'plain',
  displayName: 'Plain',
  description: 'Plain.',
  sdkApi: SDK_API_VERSION,
  platform: 'plain',
  kind: 'http',
  allowedHosts: ['api.plain.example.com'],
  tools: [
    defineBrowserTool({
      name: 'plain_noop',
      title: 'Noop (read-only)',
      description: 'Nothing. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }) as never,
  ],
} as never);

const boardPlatform: AdapterModule = defineAdapter({
  id: 'boards',
  displayName: 'Boards',
  description: 'A platform with a budget per company board.',
  sdkApi: SDK_API_VERSION,
  platform: 'boards',
  kind: 'http',
  allowedHosts: ['api.boards.example.com'],
  rate: { perHour: 600, perDay: 3000 },
  keyRate: { perHour: 20, perDay: 100 },
  tools: [
    defineBrowserTool({
      name: 'boards_noop',
      title: 'Noop (read-only)',
      description: 'Nothing. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }) as never,
  ],
} as never);

let now: number;

async function setup(adapters: AdapterModule[], over: { contexts?: ContextProvider; withRuntime?: boolean } = {}) {
  const store = Store.open(':memory:');
  const logger = createLogger({ level: 'silent' });
  const breaker = new CircuitBreaker(store, () => now);
  const limiter = new RateLimiter(store, () => now, policyFor(adapters));
  const backend = new FakeBackend();
  const runtime =
    over.withRuntime === false
      ? undefined
      : new RuntimeManager(
          backend,
          {
            image: 'i',
            network: 'n',
            profileVolumePrefix: 'p-',
            idleTtlS: 120,
            maxLifetimeS: 1800,
            queueTimeoutS: 60,
            memMaxMb: 1500,
            memHighMb: 1200,
          },
          logger,
        );
  const session: BrowserSession = {
    goto: async () => undefined,
    evaluate: (async () => undefined) as never,
    waitForSelector: async () => true,
    text: async () => null,
    url: () => 'about:blank',
  };
  const contexts: ContextProvider =
    over.contexts ??
    ({
      acquire: async () => (acquired++, { ctx: { session } as unknown as BaseContext, release: async () => void released++ }),
    } satisfies ContextProvider);
  const ops = createOpsAdapter({ enabledAdapters: () => adapters, runtime, store, limiter, breaker, contexts, clock: () => now, logger });
  const registry = await loadAdapters(
    adapters.map((a) => a.id),
    Object.fromEntries(adapters.map((a) => [a.id, async () => a])),
    [ops],
  );
  const deps: CallDeps = {
    registry,
    contexts: { acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined }) },
    logger,
    guard: createGuard(limiter, breaker),
    record: (o) =>
      store.recordCall({
        ts: now,
        requestId: o.requestId,
        tool: o.tool,
        adapter: o.adapter,
        platform: o.platform,
        outcome: o.code,
        durationMs: o.durationMs,
        argsHash: o.argsHash,
      }),
  };
  return { deps, breaker, limiter, store, runtime, backend };
}
const status = async (deps: CallDeps, platform: string) => {
  const { result, outcome } = await callTool(deps, 'session_status', { platform });
  return {
    outcome,
    results:
      (
        result.structuredContent as
          { results: { platform: string; state: string; logged_in: boolean; cached: boolean; note?: string }[] } | undefined
      )?.results ?? [],
    text: result.content[0]?.text ?? '',
  };
};

beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  check = async () => ({ state: 'ok' });
  checks = 0;
  acquired = 0;
  released = 0;
});

describe('the ops adapter is a normal adapter', () => {
  it('exposes exactly session_status, memory_report, stored_jobs and stored_job_texts, read-only, and is loaded even when nothing is enabled', async () => {
    const t = await setup([]);
    expect([...t.deps.registry.tools.keys()].sort()).toEqual(['memory_report', 'session_status', 'stored_job_texts', 'stored_jobs']);
    expect(t.deps.registry.enabled).toEqual([]);
    for (const { tool } of t.deps.registry.tools.values()) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('is reserved: an installed adapter cannot take its id', async () => {
    const ops = createOpsAdapter({} as never);
    await expect(loadAdapters(['ops'], { ops: async () => webAdapter('web') }, [ops])).rejects.toThrow(/reserved built-in id/);
  });
});

describe('session_status', () => {
  it('reports ok, loads the page once, and caches for ten minutes', async () => {
    const t = await setup([webAdapter()]);
    const first = await status(t.deps, 'web');
    expect(first.outcome.code).toBe('ok');
    expect(first.results).toEqual([expect.objectContaining({ platform: 'web', state: 'ok', logged_in: true, cached: false })]);
    now += 9 * 60 * 1000;
    const second = await status(t.deps, 'web');
    expect(second.results[0]).toMatchObject({ state: 'ok', cached: true });
    expect(checks).toBe(1);
    now += 2 * 60 * 1000;
    expect((await status(t.deps, 'web')).results[0]?.cached).toBe(false);
    expect(checks).toBe(2);
  });

  it('"all" covers every enabled platform that has a session check and skips the rest', async () => {
    const t = await setup([webAdapter('web'), webAdapter('other'), webAdapter('nocheck', false), httpOnly]);
    expect((await status(t.deps, 'all')).results.map((r) => r.platform)).toEqual(['web', 'other']);
  });

  it('refuses an unknown platform and names the ones it knows, without loading anything', async () => {
    const t = await setup([webAdapter()]);
    const r = await status(t.deps, 'linkedin');
    expect(r.outcome.code).toBe('invalid_arguments');
    expect(r.text).toContain('Known: web');
    expect(acquired).toBe(0);
  });

  it('refuses a platform id that is not a plain identifier', async () => {
    const t = await setup([webAdapter()]);
    for (const platform of ['', 'Web', '../x', 'a b', 'x'.repeat(40)])
      expect((await status(t.deps, platform)).outcome.code, platform).toBe('invalid_arguments');
  });

  it('needs_login opens the breaker; a later ok closes it', async () => {
    const t = await setup([webAdapter()]);
    check = async () => ({ state: 'needs_login', note: 'sign-in form shown' });
    const lost = await status(t.deps, 'web');
    expect(lost.results[0]).toMatchObject({ state: 'needs_login', logged_in: false, note: 'sign-in form shown' });
    expect(t.breaker.state('web')?.reason).toBe('needs_login');
    check = async () => ({ state: 'ok' });
    now += 1000;
    const back = await status(t.deps, 'web');
    expect(back.results[0]).toMatchObject({ state: 'ok', cached: false });
    expect(t.breaker.state('web')).toBeUndefined();
  });

  it('a needs_login result is not served from the cache once the user has signed in again (breaker open, cached ok must not stick)', async () => {
    const t = await setup([webAdapter()]);
    await status(t.deps, 'web'); // cached ok
    t.breaker.open('web', 'needs_login');
    check = async () => ({ state: 'ok' });
    const again = await status(t.deps, 'web');
    expect(again.results[0]).toMatchObject({ state: 'ok', cached: false });
    expect(t.breaker.state('web')).toBeUndefined();
  });

  it('a checkpoint is reported from the breaker WITHOUT loading any page', async () => {
    const t = await setup([webAdapter()]);
    t.breaker.open('web', 'checkpoint');
    const r = await status(t.deps, 'web');
    expect(r.results[0]).toMatchObject({ state: 'checkpoint', logged_in: false, cached: true });
    expect(r.results[0]?.note).toContain('the site was not contacted');
    expect(acquired).toBe(0);
    expect(checks).toBe(0);
  });

  it('a check that finds a checkpoint opens the six hour breaker', async () => {
    const t = await setup([webAdapter()]);
    check = async () => ({ state: 'checkpoint' });
    expect((await status(t.deps, 'web')).results[0]?.state).toBe('checkpoint');
    expect(t.breaker.state('web')).toMatchObject({ reason: 'checkpoint', until: now + 6 * 3600 * 1000 });
  });

  it('SessionInvalid and Checkpoint thrown by the check count the same way', async () => {
    const a = await setup([webAdapter()]);
    check = async () => {
      throw new SessionInvalid();
    };
    expect((await status(a.deps, 'web')).results[0]?.state).toBe('needs_login');
    const b = await setup([webAdapter()]);
    check = async () => {
      throw new Checkpoint();
    };
    expect((await status(b.deps, 'web')).results[0]?.state).toBe('checkpoint');
    expect(b.breaker.state('web')?.reason).toBe('checkpoint');
  });

  it('never caches a failure: a lost session is re-checked every time', async () => {
    const t = await setup([webAdapter()]);
    check = async () => ({ state: 'needs_login' });
    await status(t.deps, 'web');
    await status(t.deps, 'web');
    expect(checks).toBe(2);
  });

  it('"unknown" changes nothing and is not cached', async () => {
    const t = await setup([webAdapter()]);
    check = async () => ({ state: 'unknown', note: 'could not tell' });
    await status(t.deps, 'web');
    await status(t.deps, 'web');
    expect(checks).toBe(2);
    expect(t.breaker.state('web')).toBeUndefined();
  });

  it('an unexpected failure is "unknown" with a generic note (no internals), and the lease is still released', async () => {
    const t = await setup([webAdapter()]);
    check = async () => {
      throw new Error('boom at https://www.web.example.com/?token=SECRET');
    };
    const r = await status(t.deps, 'web');
    expect(r.results[0]).toMatchObject({ state: 'unknown', note: 'The session check failed unexpectedly.' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(released).toBe(acquired);
  });

  it('spends one point of the platform budget per real check and not for a cached answer', async () => {
    const t = await setup([webAdapter()]);
    await status(t.deps, 'web');
    await status(t.deps, 'web');
    expect(t.limiter.status('web').hour.used).toBe(1);
  });

  it('a rate-limited platform is reported as unknown with the reason, not as a lost session', async () => {
    const adapter = { ...webAdapter(), rate: { perHour: 1, perDay: 10 } } as AdapterModule;
    const t = await setup([adapter]);
    t.limiter.take('web', 1);
    const r = await status(t.deps, 'web');
    expect(r.results[0]).toMatchObject({ state: 'unknown', logged_in: false });
    expect(r.results[0]?.note).toContain('rate_limited');
    expect(t.breaker.state('web')).toBeUndefined();
  });

  it('a connection failure from the provider is "unknown", never "needs_login"', async () => {
    const failing: ContextProvider = {
      acquire: async () =>
        Promise.reject(new (await import('@jobwatch/sdk')).JobwatchError('internal', 'Could not connect to the web browser.')),
    };
    const t = await setup([webAdapter()], { contexts: failing });
    const r = await status(t.deps, 'web');
    expect(r.results[0]?.state).toBe('unknown');
    expect(t.breaker.state('web')).toBeUndefined();
  });

  it('fails the check at once when the browser is killed under it', async () => {
    const controller = new AbortController();
    const provider: ContextProvider = {
      acquire: async () => ({
        ctx: { session: {} } as unknown as BaseContext,
        release: async () => void released++,
        signal: controller.signal,
      }),
    };
    const t = await setup([webAdapter()], { contexts: provider });
    check = () => new Promise(() => undefined);
    const pending = status(t.deps, 'web');
    await vi.waitFor(() => expect(checks).toBe(1));
    controller.abort(new (await import('@jobwatch/sdk')).JobwatchError('oom_killed', 'The browser was killed for using too much memory.'));
    const r = await pending;
    expect(r.results[0]).toMatchObject({ state: 'unknown' });
    expect(r.results[0]?.note).toContain('oom_killed');
    expect(released).toBe(1);
  });
});

function requireRuntime(t: { runtime: RuntimeManager | undefined }): RuntimeManager {
  if (t.runtime === undefined) throw new Error('the test setup always creates a runtime here');
  return t.runtime;
}

describe('memory_report', () => {
  interface Report {
    generated_at: string;
    process: { rss_mb: number };
    runtime: Record<string, unknown>;
    platforms: unknown[];
    recent_calls: { outcome: string }[];
  }
  const report = async (deps: CallDeps): Promise<Report> =>
    (await callTool(deps, 'memory_report', {})).result.structuredContent as unknown as Report;

  it('works with nothing enabled and no runtime', async () => {
    const t = await setup([], { withRuntime: false });
    const r = await report(t.deps);
    expect(r.runtime).toEqual({ enabled: false, state: 'cold', waiting: 0 });
    expect(r.platforms).toEqual([]);
    expect(r.process.rss_mb).toBeGreaterThan(0);
    expect(r.generated_at).toBe(new Date(now).toISOString());
  });

  it('shows the runtime state, the rate usage and an open breaker per platform', async () => {
    const t = await setup([webAdapter(), httpOnly]);
    t.limiter.take('web', 3);
    t.breaker.open('web', 'checkpoint');
    const lease = await requireRuntime(t).lease('web');
    const r = await report(t.deps);
    expect(r.runtime).toMatchObject({ enabled: true, state: 'busy', platform: 'web', waiting: 0 });
    expect(r.platforms).toEqual([
      expect.objectContaining({
        platform: 'web',
        kind: 'browser',
        rate_hour: { used: 3, limit: 120 },
        breaker: { reason: 'checkpoint', until: new Date(now + 6 * 3600 * 1000).toISOString() },
      }),
      expect.objectContaining({ platform: 'plain', kind: 'http', rate_hour: { used: 0, limit: 600 } }),
    ]);
    await lease.release();
  });

  it('shows the usage of each company board of a platform that has a budget per board, busiest first', async () => {
    const t = await setup([boardPlatform, httpOnly]);
    for (const board of ['algolia', 'algolia', 'algolia', 'doctolib']) t.limiter.take(`boards#${board}`, 1);
    t.limiter.take('boards', 4);
    const r = (await report(t.deps)) as unknown as {
      platforms: {
        platform: string;
        rate_hour: { used: number; limit: number };
        boards?: { board: string; rate_hour: { used: number; limit: number }; rate_day: { limit: number } }[];
      }[];
    };
    const entry = r.platforms.find((p) => p.platform === 'boards');
    expect(entry?.rate_hour).toEqual({ used: 4, limit: 600 }); // the platform budget is its own
    expect(entry?.boards).toEqual([
      expect.objectContaining({ board: 'algolia', rate_hour: { used: 3, limit: 20 }, rate_day: expect.objectContaining({ limit: 100 }) }),
      expect.objectContaining({ board: 'doctolib', rate_hour: { used: 1, limit: 20 } }),
    ]);
    expect(r.platforms.find((p) => p.platform === 'plain')).not.toHaveProperty('boards'); // a platform without per-board budgets shows none
  });

  it('shows no boards that were last used more than a day ago', async () => {
    const t = await setup([boardPlatform]);
    t.limiter.take('boards#old', 1);
    now += 25 * 3600 * 1000;
    t.limiter.take('boards#new', 1);
    const r = (await report(t.deps)) as unknown as { platforms: { boards?: { board: string }[] }[] };
    expect(r.platforms[0]?.boards?.map((b) => b.board)).toEqual(['new']);
  });

  it('lists the recent calls, newest first, with no arguments and no hashes', async () => {
    const t = await setup([webAdapter()]);
    await callTool(t.deps, 'web_noop', {});
    await callTool(t.deps, 'web_noop', { bad: 1 });
    const r = await report(t.deps);
    expect(r.recent_calls.map((c) => c.outcome)).toEqual(['invalid_arguments', 'ok']);
    expect(Object.keys(r.recent_calls[0] ?? {}).sort()).toEqual(['at', 'duration_ms', 'outcome', 'tool']);
  });

  it('never exposes a container address, a name or a path', async () => {
    const t = await setup([webAdapter()]);
    const lease = await requireRuntime(t).lease('web');
    const text = JSON.stringify(await report(t.deps));
    expect(text).not.toMatch(/172\.18\.|jw-web|profile|\/data|socket/);
    await lease.release();
  });
});
