import { SDK_API_VERSION, defineAdapter, defineBrowserTool, defineHttpTool, z, type AdapterModule } from '@jobwatch/sdk';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
const limits = { timeoutS: 30, cost: 1, outputMaxBytes: 4096 } as const;

/** Counts handler invocations: `listTools` must never run a handler. */
export const handlerCalls = { count: 0 };

export function httpTool(name: string) {
  return defineHttpTool({
    name,
    title: `${name} (read-only)`,
    description: `Tool ${name} of a test adapter. Read-only, no side effects.`,
    input: z.object({ q: z.string().max(50) }).strict(),
    output: z.object({ ok: z.boolean() }),
    annotations,
    limits,
    handler: async () => {
      handlerCalls.count += 1;
      return { data: { ok: true }, warnings: [] };
    },
  });
}

export function browserTool(name: string) {
  return defineBrowserTool({
    name,
    title: `${name} (read-only)`,
    description: `Browser tool ${name} of a test adapter. Read-only, no side effects.`,
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean() }),
    annotations,
    limits,
    handler: async () => {
      handlerCalls.count += 1;
      return { data: { ok: true }, warnings: [] };
    },
  });
}

export const alpha: AdapterModule = defineAdapter({
  id: 'alpha',
  displayName: 'Alpha',
  description: 'HTTP test adapter.',
  sdkApi: SDK_API_VERSION,
  platform: 'alpha',
  kind: 'http',
  allowedHosts: ['api.alpha.example.com'],
  tools: [httpTool('alpha_search'), httpTool('alpha_job')],
});

export const beta: AdapterModule = defineAdapter({
  id: 'beta',
  displayName: 'Beta',
  description: 'Browser test adapter.',
  sdkApi: SDK_API_VERSION,
  platform: 'beta',
  kind: 'browser',
  allowedHosts: ['www.beta.example.com'],
  tools: [browserTool('beta_search')],
});
