import { SDK_API_VERSION, defineAdapter, defineHttpTool, z } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { policyFor } from './guard';
import { DEFAULT_RATE, effectiveRate } from './policy';

describe('default budgets', () => {
  it('are the documented ones: conservative for a logged-in browser account, generous for plain HTTP', () => {
    expect(DEFAULT_RATE.browser).toEqual({ perHour: 120, perDay: 300 });
    expect(DEFAULT_RATE.http).toEqual({ perHour: 600, perDay: 3000 });
  });

  it('are always enough for the most expensive tool the SDK allows (cost <= 100), so no default can make a tool unrunnable', () => {
    expect(DEFAULT_RATE.browser.perHour).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_RATE.http.perHour).toBeGreaterThanOrEqual(100);
  });
});

describe('effectiveRate', () => {
  it('uses the adapter rate when declared and the default for its kind otherwise', () => {
    expect(effectiveRate({ kind: 'browser' })).toEqual(DEFAULT_RATE.browser);
    expect(effectiveRate({ kind: 'http' })).toEqual(DEFAULT_RATE.http);
    expect(effectiveRate({ kind: 'browser', rate: { perHour: 10, perDay: 20 } })).toEqual({ perHour: 10, perDay: 20 });
  });

  it('works on a real adapter definition', () => {
    const adapter = defineAdapter({
      id: 'probe',
      displayName: 'Probe',
      description: 'Probe.',
      sdkApi: SDK_API_VERSION,
      platform: 'probe',
      kind: 'http',
      allowedHosts: ['api.probe.example.com'],
      tools: [
        defineHttpTool({
          name: 'probe_run',
          title: 'Run (read-only)',
          description: 'Runs. Read-only, no side effects.',
          input: z.object({}).strict(),
          output: z.object({ ok: z.boolean() }),
          annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
          limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
          handler: async () => ({ data: { ok: true }, warnings: [] }),
        }),
      ],
    });
    expect(effectiveRate(adapter)).toEqual(DEFAULT_RATE.http);
  });
});

describe('policyFor with a configured budget', () => {
  const module = (id: string, rate?: { perHour: number; perDay: number }, keyRate?: { perHour: number; perDay: number }) =>
    ({ id, platform: `${id}-site`, kind: 'http', ...(rate ? { rate } : {}), ...(keyRate ? { keyRate } : {}) }) as never;

  it('uses what the module declares when nothing is configured', () => {
    const policy = policyFor([module('a', { perHour: 5, perDay: 9 }), module('b')]);
    expect(policy('a-site')).toEqual({ perHour: 5, perDay: 9 });
    expect(policy('b-site')).toEqual(DEFAULT_RATE.http);
  });

  it("asks for the configured budget on every lookup, given the module's declared one, so a change applies to the next call", () => {
    let budget = { perHour: 1, perDay: 2 };
    const seen: unknown[] = [];
    const lookup = (): ReturnType<ReturnType<typeof policyFor>> =>
      policyFor([module('a', { perHour: 5, perDay: 9 })], (id, declared) => (seen.push([id, declared]), budget))('a-site');
    expect(lookup()).toEqual({ perHour: 1, perDay: 2 });
    budget = { perHour: 7, perDay: 8 };
    expect(lookup()).toEqual({ perHour: 7, perDay: 8 });
    expect(seen[0]).toEqual(['a', { perHour: 5, perDay: 9 }]);
  });

  it('leaves a module-declared board budget alone, and uses the configured one for boards when the module has none', () => {
    const configured = () => ({ perHour: 3, perDay: 4 });
    const withKey = policyFor([module('a', { perHour: 5, perDay: 9 }, { perHour: 2, perDay: 6 })], configured);
    expect(withKey('a-site')).toEqual({ perHour: 3, perDay: 4 });
    expect(withKey('a-site#acme')).toEqual({ perHour: 2, perDay: 6 });
    expect(policyFor([module('b')], configured)('b-site#acme')).toEqual({ perHour: 3, perDay: 4 });
  });
});
