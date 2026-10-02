import {
  Checkpoint,
  SDK_API_VERSION,
  SessionInvalid,
  defineAdapter,
  defineHttpTool,
  z,
  type AdapterModule,
  type BaseContext,
  JobwatchError,
} from '@jobwatch/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { callTool, type CallDeps, type ToolOutcome } from '../call';
import { createLogger } from '../logging';
import { loadAdapters } from '../registry';
import { Store } from '../store/store';
import { CircuitBreaker } from './breaker';
import { createGuard, policyFor } from './guard';
import { RateLimiter } from './ratelimit';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
let behaviour: () => Promise<{ data: { n: number }; warnings: string[]; cost?: number }>;
const handlerRuns = { count: 0 };

function adapterOf(
  id: string,
  platform: string,
  rate?: { perHour: number; perDay: number },
  cost = 1,
  estimate?: (args: { n: number }) => number,
): AdapterModule {
  return defineAdapter({
    id,
    displayName: id,
    description: id,
    sdkApi: SDK_API_VERSION,
    platform,
    kind: 'http',
    allowedHosts: [`api.${id}.example.com`],
    ...(rate ? { rate } : {}),
    tools: [
      defineHttpTool({
        name: `${id}_run`,
        title: 'Run (read-only)',
        description: 'Runs. Read-only, no side effects.',
        input: z.object({ n: z.number().int().min(1).max(10).default(1) }).strict(),
        output: z.object({ n: z.number() }),
        annotations,
        limits: { timeoutS: 5, cost, outputMaxBytes: 2048, ...(estimate ? { estimate } : {}) },
        handler: async () => {
          handlerRuns.count += 1;
          return behaviour();
        },
      }),
    ],
  });
}

let now: number;
let store: Store;
/** What the engine's meter would say the call spent; undefined = a provider that does not measure. */
let measure: (() => number) | undefined;
let acquireFails = false;
let outcomes: ToolOutcome[];

async function setup(adapters: AdapterModule[]) {
  store = Store.open(':memory:');
  const breaker = new CircuitBreaker(store, () => now);
  const limiter = new RateLimiter(store, () => now, policyFor(adapters));
  const registry = await loadAdapters(
    adapters.map((a) => a.id),
    Object.fromEntries(adapters.map((a) => [a.id, async () => a])),
  );
  const deps: CallDeps = {
    registry,
    contexts: {
      acquire: async () => {
        if (acquireFails) throw new JobwatchError('busy', 'The browser is busy.');
        return { ctx: {} as BaseContext, release: async () => undefined, ...(measure ? { spent: measure } : {}) };
      },
    },
    logger: createLogger({ level: 'silent' }),
    guard: createGuard(limiter, breaker),
    record: (outcome) => outcomes.push(outcome),
  };
  return { deps, breaker, limiter };
}

const code = async (deps: CallDeps, tool: string, args: unknown = {}) => (await callTool(deps, tool, args)).outcome.code;

beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  outcomes = [];
  measure = undefined;
  acquireFails = false;
  handlerRuns.count = 0;
  behaviour = async () => ({ data: { n: 1 }, warnings: [] });
});

describe('rate limiting around calls', () => {
  it('refuses with rate_limited and a retry time once the hourly budget is spent, without running the handler', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha', { perHour: 3, perDay: 100 })]);
    for (let i = 0; i < 3; i += 1) expect(await code(deps, 'alpha_run')).toBe('ok');
    const { result, outcome } = await callTool(deps, 'alpha_run', {});
    expect(outcome.code).toBe('rate_limited');
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      code: 'rate_limited',
      retry_after_s: 3600,
      details: { platform: 'alpha', window: 'hour', limit: 3 },
    });
    expect(handlerRuns.count).toBe(3);
  });

  it('takes the tool cost from the platform budget', async () => {
    const { deps, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 10, perDay: 100 }, 4)]);
    await code(deps, 'alpha_run');
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(8);
    expect(await code(deps, 'alpha_run')).toBe('rate_limited');
  });

  it('uses the engine default for an adapter without a rate (http: 600 per hour)', async () => {
    const { deps, limiter } = await setup([adapterOf('alpha', 'alpha')]);
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.limit).toBe(600);
  });

  it('does not spend budget on invalid arguments', async () => {
    const { deps, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 5, perDay: 50 })]);
    expect(await code(deps, 'alpha_run', { unexpected: true })).toBe('invalid_arguments');
    expect(limiter.status('alpha').hour.used).toBe(0);
  });

  it('keeps platforms apart', async () => {
    const { deps } = await setup([
      adapterOf('alpha', 'alpha', { perHour: 1, perDay: 10 }),
      adapterOf('beta', 'beta', { perHour: 1, perDay: 10 }),
    ]);
    await code(deps, 'alpha_run');
    expect(await code(deps, 'alpha_run')).toBe('rate_limited');
    expect(await code(deps, 'beta_run')).toBe('ok');
  });

  it('still charges a call whose handler failed: the request reached the platform', async () => {
    const { deps, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 5, perDay: 50 })]);
    behaviour = async () => {
      throw new Error('boom');
    };
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(1);
  });
});

describe('settling the real cost', () => {
  const setupCost = () => setup([adapterOf('alpha', 'alpha', { perHour: 30, perDay: 100 }, 10)]);

  it('refunds what the handler did not use, so the next call can fit', async () => {
    const { deps, limiter } = await setupCost();
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 3 });
    for (let i = 0; i < 5; i += 1) expect(await code(deps, 'alpha_run')).toBe('ok');
    expect(limiter.status('alpha').hour.used).toBe(15);
    expect(limiter.status('alpha').day.used).toBe(15);
  });

  it('still reserves the full cost up front: with 5 left a call that costs 10 at most is refused, whatever it would use', async () => {
    const { deps, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 15, perDay: 100 }, 10)]);
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 8 });
    expect(await code(deps, 'alpha_run')).toBe('ok');
    expect(limiter.status('alpha').hour.used).toBe(8);
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 1 });
    expect(await code(deps, 'alpha_run')).toBe('rate_limited'); // 8 + 10 > 15
    expect(handlerRuns.count).toBe(1);
  });

  it('caps a report above the tool maximum, and keeps the reservation when the report is nonsense', async () => {
    const { deps, limiter } = await setupCost();
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 99 });
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(10); // capped at the maximum, 10
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: Number.NaN });
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(20); // ignored: the reservation (10) stands
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: -4 });
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(30); // a negative report is not a refund
  });

  it('removes the charge when nothing reached the platform (cost 0) and keeps full charge on failure', async () => {
    const { deps, limiter } = await setupCost();
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 0 });
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(0);
    behaviour = async () => {
      throw new Error('boom');
    };
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(10);
  });
});

describe('reserving from the arguments of the call', () => {
  const sized = (perHour = 12) => setup([adapterOf('alpha', 'alpha', { perHour, perDay: 100 }, 10, (args) => args.n)]);

  it('reserves what this call needs, not the tool maximum', async () => {
    const { deps, limiter } = await sized();
    expect(await code(deps, 'alpha_run', { n: 2 })).toBe('ok');
    expect(limiter.status('alpha').hour.used).toBe(2); // not 10
    expect(await code(deps, 'alpha_run', { n: 10 })).toBe('ok'); // 2 + 10 = 12, fits
    expect(await code(deps, 'alpha_run', { n: 1 })).toBe('rate_limited');
  });

  it('a small call is not refused for lack of room that a big one would have needed', async () => {
    const { deps } = await sized(15);
    expect(await code(deps, 'alpha_run', { n: 9 })).toBe('ok');
    expect(await code(deps, 'alpha_run', { n: 10 })).toBe('rate_limited'); // 9 + 10 > 15
    expect(await code(deps, 'alpha_run', { n: 3 })).toBe('ok'); // 9 + 3 <= 15
  });

  it('keeps the estimate between 1 and the maximum, and falls back to the maximum when it is broken', async () => {
    for (const [estimate, reserved] of [
      [() => 0, 1],
      [() => -5, 1],
      [() => 99, 10],
      [() => 2.2, 3],
      [() => Number.NaN, 10],
      [() => Number.POSITIVE_INFINITY, 10],
      [
        () => {
          throw new Error('boom');
        },
        10,
      ],
    ] as [() => number, number][]) {
      const { deps, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 100, perDay: 100 }, 10, estimate)]);
      await code(deps, 'alpha_run');
      expect(limiter.status('alpha').hour.used, String(estimate)).toBe(reserved);
    }
  });
});

describe('charging what a call really did', () => {
  const run = () => setup([adapterOf('alpha', 'alpha', { perHour: 100, perDay: 100 }, 10, () => 6)]);

  it('a call that succeeds without reporting is charged what the engine measured', async () => {
    const { deps, limiter } = await run();
    measure = () => 2;
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(2);
  });

  it('a call that FAILS half way is charged what it did, not the whole reservation', async () => {
    const { deps, limiter } = await run();
    measure = () => 3;
    behaviour = async () => {
      throw new JobwatchError('timeout', 'too slow');
    };
    expect(await code(deps, 'alpha_run')).toBe('timeout');
    expect(limiter.status('alpha').hour.used).toBe(3);
  });

  it('a call that failed before touching anything costs nothing, and so does one that never got the browser', async () => {
    const { deps, limiter } = await run();
    measure = () => 0;
    behaviour = async () => {
      throw new Error('crash');
    };
    expect(await code(deps, 'alpha_run')).toBe('internal');
    expect(limiter.status('alpha').hour.used).toBe(0);
    acquireFails = true;
    expect(await code(deps, 'alpha_run')).toBe('busy');
    expect(limiter.status('alpha').hour.used).toBe(0);
  });

  it('a call that spent more than it reserved records the excess, up to the tool maximum, and never refuses it', async () => {
    const { deps, limiter } = await run();
    measure = () => 9;
    await code(deps, 'alpha_run'); // reserved 6, spent 9
    expect(limiter.status('alpha').hour.used).toBe(9);
    measure = () => 400;
    await code(deps, 'alpha_run'); // an absurd count is capped at the maximum, 10
    expect(limiter.status('alpha').hour.used).toBe(9 + 10);
  });

  it('what the handler reports wins over the measure', async () => {
    const { deps, limiter } = await run();
    measure = () => 5;
    behaviour = async () => ({ data: { n: 1 }, warnings: [], cost: 1 });
    await code(deps, 'alpha_run');
    expect(limiter.status('alpha').hour.used).toBe(1);
  });
});

describe('circuit breaker around calls', () => {
  it('opens needs_login when a handler reports a lost session, and then refuses without running or charging', async () => {
    const { deps, breaker, limiter } = await setup([adapterOf('alpha', 'alpha', { perHour: 50, perDay: 500 })]);
    behaviour = async () => {
      throw new SessionInvalid();
    };
    expect(await code(deps, 'alpha_run')).toBe('needs_login');
    expect(breaker.state('alpha')).toMatchObject({ reason: 'needs_login', until: null });
    const used = limiter.status('alpha').hour.used;
    const runs = handlerRuns.count;
    expect(await code(deps, 'alpha_run')).toBe('needs_login');
    expect(handlerRuns.count).toBe(runs);
    expect(limiter.status('alpha').hour.used).toBe(used);
  });

  it('opens a checkpoint for six hours and tells the model how long to wait', async () => {
    const { deps, breaker } = await setup([adapterOf('alpha', 'alpha')]);
    behaviour = async () => {
      throw new Checkpoint();
    };
    expect(await code(deps, 'alpha_run')).toBe('checkpoint');
    const refused = await callTool(deps, 'alpha_run', {});
    expect(JSON.parse(refused.result.content[0]?.text ?? '{}')).toMatchObject({ code: 'checkpoint', retry_after_s: 21_600 });
    now += 6 * 3600 * 1000 + 1000;
    behaviour = async () => ({ data: { n: 2 }, warnings: [] });
    expect(await code(deps, 'alpha_run')).toBe('ok');
    expect(breaker.state('alpha')).toBeUndefined();
  });

  it('closes after login: closing the breaker lets calls through again', async () => {
    const { deps, breaker } = await setup([adapterOf('alpha', 'alpha')]);
    breaker.open('alpha', 'needs_login');
    expect(await code(deps, 'alpha_run')).toBe('needs_login');
    breaker.close('alpha');
    expect(await code(deps, 'alpha_run')).toBe('ok');
  });

  it('does not open the breaker for other adapter errors', async () => {
    const { deps, breaker } = await setup([adapterOf('alpha', 'alpha')]);
    for (const error of [
      new Error('x'),
      new (await import('@jobwatch/sdk')).AdapterBroken('drift'),
      new (await import('@jobwatch/sdk')).UpstreamError('503'),
    ] as const) {
      behaviour = async () => {
        throw error;
      };
      await code(deps, 'alpha_run');
    }
    expect(breaker.all()).toEqual([]);
  });

  it('does not re-open or extend the breaker by being refused by it', async () => {
    const { deps, breaker } = await setup([adapterOf('alpha', 'alpha')]);
    breaker.open('alpha', 'checkpoint', 3600);
    const until = breaker.state('alpha')?.until;
    now += 600 * 1000;
    await code(deps, 'alpha_run');
    expect(breaker.state('alpha')?.until).toBe(until);
  });

  it('only affects the platform that reported the problem', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha'), adapterOf('beta', 'beta')]);
    behaviour = async () => {
      throw new SessionInvalid();
    };
    await code(deps, 'alpha_run');
    behaviour = async () => ({ data: { n: 1 }, warnings: [] });
    expect(await code(deps, 'beta_run')).toBe('ok');
  });
});

describe('call recording', () => {
  it('records every outcome, including refusals, with the arguments hash', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha', { perHour: 1, perDay: 10 })]);
    await code(deps, 'alpha_run');
    await code(deps, 'alpha_run');
    await code(deps, 'alpha_run', { bad: 1 });
    expect(outcomes.map((o) => o.code)).toEqual(['ok', 'rate_limited', 'invalid_arguments']);
    expect(outcomes.every((o) => /^[0-9a-f]{12}$/.test(o.argsHash))).toBe(true);
  });

  it('a recorder that throws never breaks the call', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha')]);
    const failing: CallDeps = {
      ...deps,
      record: () => {
        throw new Error('disk full');
      },
    };
    const { result } = await callTool(failing, 'alpha_run', {});
    expect(result.isError).toBe(false);
  });

  it('writes to the store through a recorder', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha')]);
    const withStore: CallDeps = {
      ...deps,
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
    await code(withStore, 'alpha_run');
    expect(store.recentCalls(1)[0]).toMatchObject({ tool: 'alpha_run', outcome: 'ok', platform: 'alpha' });
  });
});

describe('error type reaching the guard', () => {
  it('passes the original JobwatchError to failed()', async () => {
    const { deps } = await setup([adapterOf('alpha', 'alpha')]);
    const seen: JobwatchError[] = [];
    const guard = deps.guard;
    if (guard === undefined) throw new Error('the test setup always provides a guard');
    const spy: CallDeps = { ...deps, guard: { admit: guard.admit, failed: (_adapter, error) => void seen.push(error) } };
    behaviour = async () => {
      throw new Checkpoint();
    };
    await callTool(spy, 'alpha_run', {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Checkpoint);
  });
});
