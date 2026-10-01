import { SDK_API_VERSION, SessionInvalid, defineAdapter, defineHttpTool, z, type AdapterModule, type BaseContext } from '@jobwatch/sdk';
import type { ContextProvider } from '@jobwatch/core';

/** Counts handler runs: listing tools must never run one. */
export const runs = { count: 0 };

const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;

export const probe: AdapterModule = defineAdapter({
  id: 'probe',
  displayName: 'Probe',
  description: 'Adapter used by the server tests.',
  sdkApi: SDK_API_VERSION,
  platform: 'probe',
  kind: 'http',
  allowedHosts: ['api.probe.example.com'],
  tools: [
    defineHttpTool({
      name: 'probe_echo',
      title: 'Echo (read-only)',
      description: 'Echoes a word back. Read-only, no side effects.',
      input: z.object({ word: z.string().max(30) }).strict(),
      output: z.object({ echoed: z.string() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
      handler: async ({ word }) => {
        runs.count += 1;
        return { data: { echoed: word }, warnings: ['example warning'] };
      },
    }),
    defineHttpTool({
      name: 'probe_login',
      title: 'Needs login (read-only)',
      description: 'Always reports that the session is gone. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
      handler: async () => {
        runs.count += 1;
        throw new SessionInvalid();
      },
    }),
    defineHttpTool({
      name: 'probe_crash',
      title: 'Crashes (read-only)',
      description: 'Throws an unexpected error. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
      handler: async () => {
        runs.count += 1;
        throw new Error('connect ECONNREFUSED https://www.linkedin.com/?li_at=AQEDAR-SUPER-SECRET');
      },
    }),
  ],
});

export const other: AdapterModule = defineAdapter({
  ...probe,
  id: 'other',
  platform: 'other',
  allowedHosts: ['api.other.example.com'],
  tools: [
    defineHttpTool({
      name: 'other_ping',
      title: 'Ping (read-only)',
      description: 'Answers pong. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ pong: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 4096 },
      handler: async () => ({ data: { pong: true }, warnings: [] }),
    }),
  ],
});

/** A context provider that hands handlers an empty context: the fixture tools never touch it. */
export const fakeContexts: ContextProvider = {
  acquire: async () => ({ ctx: {} as BaseContext, release: async () => undefined }),
};
