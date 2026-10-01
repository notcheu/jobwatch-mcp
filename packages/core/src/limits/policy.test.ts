import { SDK_API_VERSION, defineAdapter, defineHttpTool, z } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
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
