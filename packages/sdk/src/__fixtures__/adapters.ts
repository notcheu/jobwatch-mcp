import { defineAdapter } from '../adapter';
import { defineBrowserTool, defineHttpTool } from '../tool';
import { SDK_API_VERSION } from '../version';
import { z } from 'zod';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
const limits = { timeoutS: 30, cost: 1, outputMaxBytes: 4096 } as const;

export const greetingTool = defineHttpTool({
  name: 'echo_greeting',
  title: 'Greeting (read-only)',
  description: 'Returns a greeting from the example API. Read-only, no side effects.',
  input: z
    .object({
      name: z.string().max(50),
      tags: z.array(z.string().max(20)).max(5).default([]),
    })
    .strict(),
  output: z.object({ greeting: z.string() }),
  annotations,
  limits,
  handler: async ({ name }, { http }) => {
    const response = await http.get(`https://api.example.com/hello?name=${encodeURIComponent(name)}`);
    const body = response.json(z.object({ message: z.string() }));
    return { data: { greeting: body.message }, warnings: [] };
  },
});

/** A valid HTTP adapter. */
export const httpAdapter = defineAdapter({
  id: 'echo',
  displayName: 'Echo',
  description: 'Example HTTP adapter used by the SDK tests.',
  sdkApi: SDK_API_VERSION,
  platform: 'echo',
  kind: 'http',
  allowedHosts: ['api.example.com'],
  tools: [greetingTool],
});

export const titleTool = defineBrowserTool({
  name: 'page_title',
  title: 'Page title (read-only)',
  description: 'Reads the title of the example home page. Read-only, no side effects.',
  input: z.object({}).strict(),
  output: z.object({ title: z.string() }),
  annotations,
  limits,
  handler: async (_args, { session, log }) => {
    await session.goto('https://www.example.com/', { timeoutMs: 5000 });
    const title = (await session.text('h1')) ?? '';
    log.info('read title');
    return { data: { title }, warnings: [] };
  },
});

/** A valid browser adapter. */
export const browserAdapter = defineAdapter({
  id: 'sample-browser',
  displayName: 'Sample browser',
  description: 'Example browser adapter used by the SDK tests.',
  sdkApi: SDK_API_VERSION,
  platform: 'sample',
  kind: 'browser',
  allowedHosts: ['www.example.com'],
  sessionCheck: async (session) => {
    await session.goto('https://www.example.com/', { timeoutMs: 5000 });
    return { state: (await session.waitForSelector('#login-form', 100)) ? 'needs_login' : 'ok' };
  },
  tools: [titleTool],
});
