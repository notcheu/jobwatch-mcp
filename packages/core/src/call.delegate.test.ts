import { Writable } from 'node:stream';
import { JobwatchError, SDK_API_VERSION, defineAdapter, defineHttpTool, z, type AdapterModule, type BaseContext } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { callTool, type CallDeps, type CallGuard, type ContextProvider } from './call';
import { createLogger } from './logging';
import { loadModules } from './registry';

const target = (id: string, handler: (ctx: BaseContext) => Promise<{ n: number }>): AdapterModule =>
  defineAdapter({
    id,
    displayName: id,
    description: `Adapter ${id}.`,
    sdkApi: SDK_API_VERSION,
    platform: id,
    kind: 'http',
    allowedHosts: [`api.${id}.example.com`],
    tools: [
      defineHttpTool({
        name: `${id}_run`,
        title: 'Run (read-only)',
        description: 'Runs. Read-only, no side effects.',
        input: z.object({ q: z.string().max(20) }).strict(),
        output: z.object({ n: z.number() }),
        annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
        limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
        handler: async (_args, ctx) => ({ data: await handler(ctx), warnings: [] }),
      }),
    ],
  });

const gateway = (run: (ctx: BaseContext) => Promise<{ n: number }>): AdapterModule =>
  defineAdapter({
    id: 'gate',
    displayName: 'Gate',
    description: 'Gateway.',
    sdkApi: SDK_API_VERSION,
    platform: 'gate',
    kind: 'http',
    allowedHosts: [],
    delegates: { to: ['alpha'] },
    tools: [
      defineHttpTool({
        name: 'gate_run',
        title: 'Run (read-only)',
        description: 'Routes. Read-only, no side effects.',
        input: z.object({ q: z.string().max(20) }).strict(),
        output: z.object({ n: z.number() }),
        annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
        limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
        handler: async (_args, ctx) => ({ data: await run(ctx), warnings: [] }),
      }),
    ],
  });

const provider: ContextProvider = {
  acquire: async () => ({
    ctx: {
      http: {} as never,
      jobs: {} as never,
      memory: {} as never,
      companies: {} as never,
      places: {} as never,
      log: {} as never,
      pace: async () => undefined,
      spend: () => undefined,
    },
    release: async () => undefined,
  }),
};

async function setup(run: (ctx: BaseContext) => Promise<{ n: number }>, alpha: (ctx: BaseContext) => Promise<{ n: number }>) {
  const modules = {
    gate: async () => gateway(run),
    alpha: async () => target('alpha', alpha),
    beta: async () => target('beta', async () => ({ n: 2 })),
  };
  const registry = await loadModules(['gate', 'alpha', 'beta'], modules);
  const admitted: string[] = [];
  const guard: CallGuard = {
    admit: (adapter) => {
      admitted.push(adapter.id);
      return undefined;
    },
    failed: () => undefined,
  };
  const deps: CallDeps = {
    registry,
    contexts: provider,
    logger: createLogger({ level: 'silent', destination: new Writable({ write: (_c, _e, done) => done() }) }),
    guard,
  };
  return { deps, admitted };
}

describe('callTool: a gateway delegating to another module', () => {
  it('runs the delegated tool as a full call: the owning module is admitted, not just the gateway', async () => {
    const { deps, admitted } = await setup(
      async (ctx) => (await ctx.callTool?.('alpha_run', { q: 'x' })) as { n: number },
      async () => ({ n: 7 }),
    );
    const { result } = await callTool(deps, 'gate_run', { q: 'x' });
    expect(result.structuredContent).toEqual({ n: 7 });
    expect(admitted).toEqual(['gate', 'alpha']);
  });

  it('refuses a tool of a module it does not delegate to, before anything is admitted for it', async () => {
    let seen: unknown;
    const { deps, admitted } = await setup(
      async (ctx) => {
        seen = await ctx.callTool?.('beta_run', { q: 'x' }).catch((error: unknown) => error);
        return { n: 0 };
      },
      async () => ({ n: 7 }),
    );
    await callTool(deps, 'gate_run', { q: 'x' });
    expect(seen).toBeInstanceOf(JobwatchError);
    expect((seen as JobwatchError).code).toBe('invalid_arguments');
    expect(admitted).toEqual(['gate']);
  });

  it('throws the delegated tool error with its code', async () => {
    let seen: unknown;
    const { deps } = await setup(
      async (ctx) => {
        seen = await ctx.callTool?.('alpha_run', { q: 'x' }).catch((error: unknown) => error);
        return { n: 0 };
      },
      async () => {
        throw new JobwatchError('rate_limited', 'Budget used up.', { retryAfterS: 60 });
      },
    );
    await callTool(deps, 'gate_run', { q: 'x' });
    expect(seen).toMatchObject({ code: 'rate_limited', message: 'Budget used up.', retryAfterS: 60 });
  });

  it('gives no ctx.callTool to a delegated tool, and none to a module that does not delegate', async () => {
    const inside: unknown[] = [];
    const { deps } = await setup(
      async (ctx) => (await ctx.callTool?.('alpha_run', { q: 'x' })) as { n: number },
      async (ctx) => {
        inside.push(ctx.callTool);
        return { n: 1 };
      },
    );
    await callTool(deps, 'gate_run', { q: 'x' });
    await callTool(deps, 'beta_run', { q: 'x' });
    expect(inside).toEqual([undefined]);
  });
});
