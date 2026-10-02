import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdapterModule } from './adapter';
import { defineAdapter } from './adapter';
import { browserAdapter, greetingTool, httpAdapter } from './__fixtures__/adapters';
import type { HttpAdapterContext } from './context';
import { defineHttpTool, type ErasedTool } from './tool';
import { formatViolations, validateAdapter, type Rule } from './validate';

const rules = (adapter: AdapterModule): Rule[] => validateAdapter(adapter).map((v) => v.rule);

/** The fixture HTTP adapter with its one tool replaced by a modified copy. */
const withTool = (patch: Partial<ErasedTool<HttpAdapterContext>>): AdapterModule => ({
  ...httpAdapter,
  tools: [{ ...greetingTool, ...patch }],
});

describe('validateAdapter: acceptable adapters', () => {
  it('accepts a valid HTTP adapter', () => {
    expect(validateAdapter(httpAdapter)).toEqual([]);
  });

  it('accepts a valid browser adapter', () => {
    expect(validateAdapter(browserAdapter)).toEqual([]);
  });
});

describe('validateAdapter: adapter-level rules', () => {
  it('rejects another SDK API version', () => {
    expect(rules({ ...httpAdapter, sdkApi: 999 })).toContain('sdk-api');
  });

  it.each(['', 'A', 'Echo', '1echo', 'echo_x', 'e'.repeat(40)])('rejects the id %j', (id) => {
    expect(rules({ ...httpAdapter, id })).toContain('id');
  });

  it('rejects a bad platform', () => {
    expect(rules({ ...httpAdapter, platform: 'Bad Platform' })).toContain('platform');
  });

  it('rejects an empty host list and non-bare hosts', () => {
    expect(rules({ ...httpAdapter, allowedHosts: [] })).toContain('hosts');
    for (const host of [
      'https://api.example.com',
      'api.example.com/path',
      '*.com',
      '*',
      'a.*.example.com',
      '127.0.0.1',
      'API.example.com',
    ]) {
      expect(rules({ ...httpAdapter, allowedHosts: [host] }), host).toContain('hosts');
    }
  });

  it('accepts one-label wildcard hosts', () => {
    expect(rules({ ...httpAdapter, allowedHosts: ['*.teamtailor.com', 'api.example.com'] })).toEqual([]);
  });

  it('allows openHttps on http adapters only', () => {
    expect(rules({ ...httpAdapter, openHttps: true })).toEqual([]);
    expect(rules({ ...browserAdapter, openHttps: true } as never)).toContain('hosts');
  });

  it('accepts a valid rate policy and rejects nonsense', () => {
    expect(rules({ ...httpAdapter, rate: { perHour: 120, perDay: 300 } })).toEqual([]);
    for (const rate of [
      { perHour: 0, perDay: 10 },
      { perHour: 10, perDay: 5 },
      { perHour: 1.5, perDay: 10 },
      { perHour: 10, perDay: 1_000_000 },
      { perHour: -1, perDay: 10 },
    ]) {
      expect(rules({ ...httpAdapter, rate }), JSON.stringify(rate)).toContain('rate');
    }
  });

  it('accepts a valid pacing and rejects nonsense', () => {
    expect(rules({ ...httpAdapter, pacing: { minMs: 2500, maxMs: 5000 } })).toEqual([]);
    expect(rules({ ...httpAdapter, pacing: { minMs: 0, maxMs: 0 } })).toEqual([]);
    for (const pacing of [
      { minMs: -1, maxMs: 5 },
      { minMs: 10, maxMs: 5 },
      { minMs: 1.5, maxMs: 5 },
      { minMs: 0, maxMs: 120_000 },
    ]) {
      expect(rules({ ...httpAdapter, pacing }), JSON.stringify(pacing)).toContain('pacing');
    }
  });

  it('rejects a tool whose cost is above the hourly budget (it could never run)', () => {
    const expensive = withTool({ limits: { timeoutS: 30, cost: 50, outputMaxBytes: 4096 } });
    expect(rules({ ...expensive, rate: { perHour: 40, perDay: 300 } })).toContain('rate');
    expect(rules({ ...expensive, rate: { perHour: 50, perDay: 300 } })).toEqual([]);
  });

  it('rejects an adapter without tools', () => {
    expect(rules({ ...httpAdapter, tools: [] })).toContain('tools');
  });

  it('rejects duplicate tool names inside an adapter', () => {
    expect(rules({ ...httpAdapter, tools: [greetingTool, greetingTool] })).toContain('tool-unique');
  });
});

describe('validateAdapter: tool rules', () => {
  it.each(['', 'Echo', 'ab', 'echo-greeting', 'x'.repeat(70)])('rejects the tool name %j', (name) => {
    expect(rules(withTool({ name }))).toContain('tool-name');
  });

  it('rejects a tool that is not read-only, even when types are bypassed', () => {
    const writer = withTool({ annotations: { readOnlyHint: false as unknown as true, openWorldHint: true, idempotentHint: true } });
    expect(rules(writer)).toContain('read-only');
  });

  it('requires a description that says read-only, within length bounds', () => {
    expect(rules(withTool({ description: 'Returns a greeting from the example API without any mention.' }))).toContain('description');
    expect(rules(withTool({ description: 'read-only' }))).toContain('description');
    expect(rules(withTool({ description: `Read-only ${'x'.repeat(700)}` }))).toContain('description');
    expect(rules(withTool({ title: '' }))).toContain('description');
  });

  it('checks limits', () => {
    for (const limits of [
      { timeoutS: 0, cost: 1, outputMaxBytes: 4096 },
      { timeoutS: 301, cost: 1, outputMaxBytes: 4096 },
      { timeoutS: 30.5, cost: 1, outputMaxBytes: 4096 },
      { timeoutS: 30, cost: 0, outputMaxBytes: 4096 },
      { timeoutS: 30, cost: 1, outputMaxBytes: 10 },
      { timeoutS: 30, cost: 1, outputMaxBytes: 10_000_000 },
      { timeoutS: 30, cost: 1, outputMaxBytes: 4096, memory: { highMb: 2000, maxMb: 1000 } },
      { timeoutS: 30, cost: 1, outputMaxBytes: 4096, memory: { highMb: 64, maxMb: 100 } },
    ]) {
      expect(rules(withTool({ limits })), JSON.stringify(limits)).toContain('limits');
    }
    expect(rules(withTool({ limits: { timeoutS: 60, cost: 2, outputMaxBytes: 60_000, memory: { highMb: 1200, maxMb: 1500 } } }))).toEqual(
      [],
    );
  });
});

describe('validateAdapter: input schema rules', () => {
  const toolWithInput = (input: z.ZodType) => withTool({ input });

  it('rejects objects that allow extra properties', () => {
    expect(rules(toolWithInput(z.object({ q: z.string().max(10) })))).toContain('schema-strict');
  });

  it('rejects unbounded strings and arrays', () => {
    expect(rules(toolWithInput(z.object({ q: z.string() }).strict()))).toContain('schema-bounded');
    expect(rules(toolWithInput(z.object({ q: z.array(z.string().max(5)) }).strict()))).toContain('schema-bounded');
  });

  it('allows enums and literals without maxLength', () => {
    expect(rules(toolWithInput(z.object({ mode: z.enum(['24h', 'any']), kind: z.literal('x') }).strict()))).toEqual([]);
  });

  it('checks nested objects, array items and unions', () => {
    expect(rules(toolWithInput(z.object({ nested: z.object({ q: z.string().max(5) }) }).strict()))).toContain('schema-strict');
    expect(rules(toolWithInput(z.object({ list: z.array(z.string()).max(5) }).strict()))).toContain('schema-bounded');
    expect(rules(toolWithInput(z.object({ u: z.union([z.string(), z.number()]) }).strict()))).toContain('schema-bounded');
    expect(rules(toolWithInput(z.object({ r: z.record(z.string(), z.string().max(5)) }).strict()))).toContain('schema-strict');
  });

  it('catches unbounded strings hidden in unions and nullable values (zod emits type arrays)', () => {
    expect(rules(toolWithInput(z.object({ u: z.union([z.string(), z.number()]) }).strict()))).toContain('schema-bounded');
    expect(rules(toolWithInput(z.object({ n: z.string().nullable() }).strict()))).toContain('schema-bounded');
    expect(rules(toolWithInput(z.object({ o: z.string().max(5).optional() }).strict()))).toEqual([]);
    expect(rules(toolWithInput(z.object({ n: z.string().max(5).nullable() }).strict()))).toEqual([]);
  });

  it('accepts bounded nested structures', () => {
    const ok = z
      .object({
        nested: z.object({ q: z.string().max(5) }).strict(),
        list: z.array(z.string().max(5)).max(3),
        n: z.number().int().min(1).max(5),
      })
      .strict();
    expect(rules(toolWithInput(ok))).toEqual([]);
  });

  it('reports an output schema that cannot be expressed as JSON Schema', () => {
    const bad = defineHttpTool({
      ...greetingTool,
      output: z.object({ when: z.date() }),
      handler: async () => ({ data: { when: new Date() }, warnings: [] }),
    });
    expect(rules({ ...httpAdapter, tools: [bad] })).toContain('schema');
  });
});

describe('formatViolations', () => {
  it('names the adapter, rule and location', () => {
    const text = formatViolations('echo', validateAdapter({ ...httpAdapter, sdkApi: 2 }));
    expect(text).toContain('Adapter "echo" is not acceptable');
    expect(text).toContain('[sdk-api]');
  });
});

describe('type-level guarantees (checked by `tsc`, not at runtime)', () => {
  it('forbids tools that are not read-only', () => {
    defineHttpTool({
      ...greetingTool,
      // @ts-expect-error readOnlyHint must be the literal `true`
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    });
  });

  it('forbids a browser tool inside an HTTP adapter', () => {
    defineAdapter({
      ...httpAdapter,
      // @ts-expect-error a handler that needs `session` cannot run in an HTTP adapter
      tools: [browserAdapter.tools[0]],
    });
  });

  it('allows an HTTP tool inside a browser adapter', () => {
    const adapter = defineAdapter({ ...browserAdapter, tools: [greetingTool, ...browserAdapter.tools] });
    expect(adapter.tools).toHaveLength(2);
  });

  it('infers handler argument types from the input schema', () => {
    defineHttpTool({
      ...greetingTool,
      handler: async (args) => {
        const name: string = args.name;
        // @ts-expect-error `age` is not part of the input schema
        const age = args.age;
        return { data: { greeting: `${name}${String(age)}` }, warnings: [] };
      },
    });
  });

  it('requires handler results to match the output type', () => {
    defineHttpTool({
      ...greetingTool,
      // @ts-expect-error `greeting` must be a string
      handler: async () => ({ data: { greeting: 42 }, warnings: [] }),
    });
  });

  it('hides the browser session from HTTP tools', () => {
    defineHttpTool({
      ...greetingTool,
      handler: async (_args, ctx) => {
        // @ts-expect-error HTTP adapters have no browser session
        void ctx.session;
        return { data: { greeting: 'x' }, warnings: [] };
      },
    });
  });
});
