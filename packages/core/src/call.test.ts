import { Writable } from 'node:stream';
import {
  AdapterBroken,
  JobwatchError,
  Checkpoint,
  SDK_API_VERSION,
  SessionInvalid,
  defineAdapter,
  defineHttpTool,
  z,
  type AdapterModule,
  type AdapterResult,
  type BaseContext,
} from '@jobwatch/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argsHash, callTool, noRuntime, UnknownToolError, type CallDeps, type ContextProvider } from './call';
import { createLogger } from './logging';
import { loadAdapters } from './registry';

const SECRET = 'li_at=AQEDAR-SUPER-SECRET-COOKIE';

type Handler = (args: { q: string }, ctx: BaseContext) => Promise<AdapterResult<{ n: number }>>;

function adapterWith(handler: Handler, limits: { timeoutS?: number; outputMaxBytes?: number } = {}): AdapterModule {
  return defineAdapter({
    id: 'probe',
    displayName: 'Probe',
    description: 'Probe adapter.',
    sdkApi: SDK_API_VERSION,
    platform: 'probe',
    kind: 'http',
    allowedHosts: ['api.probe.example.com'],
    tools: [
      defineHttpTool({
        name: 'probe_run',
        title: 'Run (read-only)',
        description: 'Runs the probe. Read-only, no side effects.',
        input: z.object({ q: z.string().max(20) }).strict(),
        output: z.object({ n: z.number() }),
        annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
        limits: { timeoutS: limits.timeoutS ?? 5, cost: 1, outputMaxBytes: limits.outputMaxBytes ?? 4096 },
        handler,
      }),
    ],
  });
}

function logSink(): { stream: Writable; text: () => string } {
  let buffer = '';
  return {
    stream: new Writable({
      write(chunk, _enc, done) {
        buffer += String(chunk);
        done();
      },
    }),
    text: () => buffer,
  };
}

const okProvider = (released: { count: number }): ContextProvider => ({
  acquire: async () => ({
    ctx: { http: {} as never, log: {} as never, pace: async () => undefined },
    release: async () => {
      released.count += 1;
    },
  }),
});

async function depsFor(handler: Handler, extra: { provider?: ContextProvider; limits?: Parameters<typeof adapterWith>[1] } = {}) {
  const adapter = adapterWith(handler, extra.limits);
  const registry = await loadAdapters(['probe'], { probe: async () => adapter });
  const sink = logSink();
  const released = { count: 0 };
  const deps: CallDeps = {
    registry,
    contexts: extra.provider ?? okProvider(released),
    logger: createLogger({ level: 'debug', destination: sink.stream }),
    newRequestId: () => 'req-1',
  };
  return { deps, sink, released };
}

const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

describe('callTool: success', () => {
  it('returns structured content, text and metadata', async () => {
    const { deps } = await depsFor(async ({ q }) => ({ data: { n: q.length }, warnings: ['remote filter not applied; post-filtered'] }));
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'hello' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ n: 5 });
    expect(result.content[0]?.text).toBe('{"n":5}\n\nWarnings:\n- remote filter not applied; post-filtered');
    expect(result._meta?.jobwatch).toMatchObject({
      request_id: 'req-1',
      adapter: 'probe',
      warnings: ['remote filter not applied; post-filtered'],
    });
    expect(Date.parse(result._meta?.jobwatch.fetched_at ?? '')).not.toBeNaN();
    expect(outcome).toMatchObject({ tool: 'probe_run', adapter: 'probe', platform: 'probe', code: 'ok', requestId: 'req-1' });
  });

  it('prefers the handler text over the JSON dump', async () => {
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, text: '| a | b |', warnings: [] }));
    expect((await callTool(deps, 'probe_run', { q: 'x' })).result.content[0]?.text).toBe('| a | b |');
  });

  it('caps the number and length of warnings', async () => {
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, warnings: Array.from({ length: 50 }, () => 'w'.repeat(1000)) }), {
      limits: { outputMaxBytes: 20_000 },
    });
    const warnings = (await callTool(deps, 'probe_run', { q: 'x' })).result._meta?.jobwatch.warnings ?? [];
    expect(warnings).toHaveLength(20);
    expect(warnings.every((warning) => warning.length === 300)).toBe(true);
  });

  it('always releases the context', async () => {
    const { deps, released } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }));
    await callTool(deps, 'probe_run', { q: 'x' });
    expect(released.count).toBe(1);
  });
});

describe('callTool: protocol and argument errors', () => {
  it('throws UnknownToolError for an unregistered tool, without touching the provider', async () => {
    const acquire = vi.fn();
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }), { provider: { acquire } });
    await expect(callTool(deps, 'nope', {})).rejects.toBeInstanceOf(UnknownToolError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('returns invalid_arguments with paths and messages but never the received values', async () => {
    const handler = vi.fn();
    const { deps } = await depsFor(handler);
    for (const args of [{ q: 123 }, { q: 'x'.repeat(21) }, {}, { q: 'ok', extra: SECRET }, 'a string', null]) {
      const { result, outcome } = await callTool(deps, 'probe_run', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(outcome.code).toBe('invalid_arguments');
      expect(JSON.stringify(result)).not.toContain('AQEDAR');
      expect(body(result)).toMatchObject({ code: 'invalid_arguments', retry_after_s: null });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats missing arguments like an empty object', async () => {
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }));
    expect((await callTool(deps, 'probe_run', undefined)).outcome.code).toBe('invalid_arguments');
  });
});

describe('callTool: handler failures map to client-safe errors', () => {
  it.each([
    ['SessionInvalid', () => new SessionInvalid(), 'needs_login'],
    ['Checkpoint', () => new Checkpoint(), 'checkpoint'],
    ['AdapterBroken', () => new AdapterBroken('selector drift: 0 cards'), 'adapter_broken'],
  ])('%s becomes %s', async (_name, make, code) => {
    const { deps } = await depsFor(async () => {
      throw make();
    });
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'x' });
    expect(result.isError).toBe(true);
    expect(outcome.code).toBe(code);
    expect(body(result)).toMatchObject({ code, details: { request_id: 'req-1' } });
  });

  it('hides the message of unexpected errors and logs the details instead', async () => {
    const { deps, sink } = await depsFor(async () => {
      throw new Error(`fetch failed for https://www.linkedin.com/jobs/?x=1 with ${SECRET}`);
    });
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'x' });
    expect(outcome.code).toBe('internal');
    expect(body(result)).toEqual({ code: 'internal', message: 'Internal error.', retry_after_s: null, details: { request_id: 'req-1' } });
    expect(JSON.stringify(result)).not.toContain('AQEDAR');
    expect(JSON.stringify(result)).not.toContain('linkedin');
    expect(sink.text()).toContain('tool_call_failed');
  });

  it('turns a non-Error throw into an internal error too', async () => {
    const { deps } = await depsFor(async () => {
      throw 'a plain string';
    });
    expect((await callTool(deps, 'probe_run', { q: 'x' })).outcome.code).toBe('internal');
  });

  it('flags a result that does not match the output schema as adapter_broken, never as data', async () => {
    const { deps } = await depsFor((async () => ({ data: { n: 'not a number' }, warnings: [] })) as unknown as Handler);
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'x' });
    expect(outcome.code).toBe('adapter_broken');
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects a result larger than the tool output limit', async () => {
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, text: 'x'.repeat(5000), warnings: [] }), {
      limits: { outputMaxBytes: 2048 },
    });
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'x' });
    expect(outcome.code).toBe('internal');
    expect(body(result)['message']).toContain('2048');
    expect(JSON.stringify(result).length).toBeLessThan(600);
  });

  it('releases the context even when the handler throws', async () => {
    const { deps, released } = await depsFor(async () => {
      throw new Error('boom');
    });
    await callTool(deps, 'probe_run', { q: 'x' });
    expect(released.count).toBe(1);
  });
});

describe('callTool: context provider', () => {
  it('reports a failing provider without calling the handler', async () => {
    const handler = vi.fn();
    const { deps } = await depsFor(handler, { provider: noRuntime });
    const { result, outcome } = await callTool(deps, 'probe_run', { q: 'x' });
    expect(outcome.code).toBe('internal');
    expect(body(result)['message']).toBe('No runtime is available in this build, so tools cannot run yet.');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not let a failing release hide the result', async () => {
    const provider: ContextProvider = {
      acquire: async () => ({
        ctx: { http: {} as never, log: {} as never, pace: async () => undefined },
        release: async () => {
          throw new Error('container did not stop');
        },
      }),
    };
    const { deps, sink } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }), { provider });
    expect((await callTool(deps, 'probe_run', { q: 'x' })).outcome.code).toBe('ok');
    expect(sink.text()).toContain('context_release_failed');
  });
});

describe('callTool: timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up after the tool timeout with the timeout code, and still releases the context', async () => {
    const { deps, released } = await depsFor(() => new Promise(() => undefined), { limits: { timeoutS: 3 } });
    const pending = callTool(deps, 'probe_run', { q: 'x' });
    await vi.advanceTimersByTimeAsync(3001);
    const { result, outcome } = await pending;
    expect(outcome.code).toBe('timeout');
    expect(body(result)['message']).toBe('The tool did not finish within 3 s.');
    expect(released.count).toBe(1);
  });

  it('does not time out a call that finishes in time', async () => {
    const { deps } = await depsFor(() => new Promise((resolve) => setTimeout(() => resolve({ data: { n: 1 }, warnings: [] }), 1000)), {
      limits: { timeoutS: 3 },
    });
    const pending = callTool(deps, 'probe_run', { q: 'x' });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).outcome.code).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('logging of calls', () => {
  it('logs the outcome with an argument hash and never the arguments', async () => {
    const { deps, sink } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }));
    await callTool(deps, 'probe_run', { q: SECRET.slice(0, 20) });
    const line = JSON.parse(sink.text().trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ msg: 'tool_call', tool: 'probe_run', adapter: 'probe', request_id: 'req-1', outcome: 'ok' });
    expect(String(line['args_hash'])).toMatch(/^[0-9a-f]{12}$/);
    expect(sink.text()).not.toContain('AQEDAR');
  });

  it('argsHash is stable, short and order-sensitive only where JSON is', () => {
    expect(argsHash({ a: 1 })).toBe(argsHash({ a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
    expect(argsHash(undefined)).toBe(argsHash(null));
  });
});

describe('callTool: a lease signal that aborts', () => {
  it('fails at once with the signal reason instead of waiting for the tool timeout', async () => {
    const controller = new AbortController();
    const provider: ContextProvider = {
      acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined, signal: controller.signal }),
    };
    const { deps } = await depsFor(() => new Promise(() => undefined), { provider, limits: { timeoutS: 60 } });
    const pending = callTool(deps, 'probe_run', { q: 'x' });
    controller.abort(new JobwatchError('budget_exceeded', 'The browser used too much memory and was stopped.'));
    const { outcome } = await pending;
    expect(outcome.code).toBe('budget_exceeded');
  });

  it('fails immediately when the signal was already aborted, and never runs the handler', async () => {
    const controller = new AbortController();
    controller.abort(new JobwatchError('oom_killed', 'killed'));
    const handler = vi.fn(async () => ({ data: { n: 1 }, warnings: [] }));
    const provider: ContextProvider = {
      acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined, signal: controller.signal }),
    };
    const { deps } = await depsFor(handler, { provider });
    expect((await callTool(deps, 'probe_run', { q: 'x' })).outcome.code).toBe('oom_killed');
  });

  it('maps a non-Error abort reason to a generic internal error', async () => {
    const controller = new AbortController();
    const provider: ContextProvider = {
      acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined, signal: controller.signal }),
    };
    const { deps } = await depsFor(() => new Promise(() => undefined), { provider });
    const pending = callTool(deps, 'probe_run', { q: 'x' });
    controller.abort('just a string');
    expect((await pending).outcome.code).toBe('internal');
  });

  it('does not leak abort listeners from calls that finish normally', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const provider: ContextProvider = {
      acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined, signal: controller.signal }),
    };
    const { deps } = await depsFor(async () => ({ data: { n: 1 }, warnings: [] }), { provider });
    await callTool(deps, 'probe_run', { q: 'x' });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
