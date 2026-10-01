import { SDK_API_VERSION, defineAdapter, z, defineHttpTool, type AdapterModule } from '@jobwatch/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alpha, beta, handlerCalls, httpTool } from './__fixtures__/adapters';
import { RegistryError, listTools, loadAdapters, type InstalledAdapters } from './registry';

const installed: InstalledAdapters = { alpha: async () => alpha, beta: async () => beta };
const problemsOf = async (enabled: string[], table: InstalledAdapters): Promise<readonly string[]> => {
  try {
    await loadAdapters(enabled, table);
  } catch (error) {
    if (error instanceof RegistryError) return error.problems;
    throw error;
  }
  return [];
};

beforeEach(() => {
  handlerCalls.count = 0;
});

describe('loadAdapters: what gets plugged in', () => {
  it('plugs in nothing when nothing is enabled, and imports nothing', async () => {
    const loader = vi.fn(async () => alpha);
    const registry = await loadAdapters([], { alpha: loader });
    expect(registry.adapters).toEqual([]);
    expect([...registry.tools.keys()]).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });

  it('imports only the enabled adapters', async () => {
    const alphaLoader = vi.fn(async () => alpha);
    const betaLoader = vi.fn(async () => beta);
    const registry = await loadAdapters(['beta'], { alpha: alphaLoader, beta: betaLoader });
    expect(registry.adapters.map((a) => a.id)).toEqual(['beta']);
    expect(alphaLoader).not.toHaveBeenCalled();
    expect(betaLoader).toHaveBeenCalledOnce();
  });

  it('indexes every tool by name with its adapter, keeping the requested order', async () => {
    const registry = await loadAdapters(['beta', 'alpha'], installed);
    expect(registry.adapters.map((a) => a.id)).toEqual(['beta', 'alpha']);
    expect([...registry.tools.keys()]).toEqual(['beta_search', 'alpha_search', 'alpha_job']);
    expect(registry.tools.get('alpha_job')?.adapter.id).toBe('alpha');
  });
});

describe('loadAdapters: fail fast', () => {
  it('rejects an enabled id that is not installed and lists what is', async () => {
    expect(await problemsOf(['gamma'], installed)).toEqual(['"gamma" is enabled but not installed (installed: alpha, beta)']);
  });

  it('says "none" when nothing is installed', async () => {
    expect(await problemsOf(['alpha'], {})).toEqual(['"alpha" is enabled but not installed (installed: none)']);
  });

  it('rejects a module whose id differs from its key', async () => {
    expect(await problemsOf(['renamed'], { renamed: async () => alpha })).toEqual([
      'installed as "renamed" but the module declares id "alpha"',
    ]);
  });

  it('reports a loader that throws instead of crashing the whole startup report', async () => {
    const problems = await problemsOf(['alpha', 'beta'], {
      alpha: async () => {
        throw new Error('Cannot find module');
      },
      beta: async () => beta,
    });
    expect(problems).toEqual(['"alpha" failed to load: Cannot find module']);
  });

  it('rejects an adapter that breaks the startup rules, naming the rule', async () => {
    const writer = defineAdapter({ ...alpha, sdkApi: SDK_API_VERSION + 1 });
    const [problem] = await problemsOf(['alpha'], { alpha: async () => writer });
    expect(problem).toContain('Adapter "alpha" is not acceptable');
    expect(problem).toContain('[sdk-api]');
  });

  it('rejects the same tool name in two adapters', async () => {
    const clash = defineAdapter({
      ...beta,
      id: 'gamma',
      platform: 'gamma',
      allowedHosts: ['www.gamma.example.com'],
      tools: [httpTool('alpha_search')],
    }) as AdapterModule;
    expect(await problemsOf(['alpha', 'gamma'], { alpha: async () => alpha, gamma: async () => clash })).toContainEqual(
      'tool "alpha_search" is defined by both "alpha" and "gamma"',
    );
  });

  it('rejects two adapters sharing a platform with different kinds (they would share one runtime)', async () => {
    const sameBrowser = defineAdapter({ ...beta, id: 'beta-two', platform: 'alpha', tools: [] }) as AdapterModule;
    const withTools = { ...sameBrowser, tools: beta.tools } as AdapterModule;
    expect(await problemsOf(['alpha', 'beta-two'], { alpha: async () => alpha, 'beta-two': async () => withTools })).toContainEqual(
      expect.stringContaining('share platform "alpha" but differ in kind'),
    );
  });

  it('allows two adapters of the same kind to share a platform', async () => {
    const sibling = defineAdapter({ ...alpha, id: 'alpha-two', tools: [httpTool('alpha_two_search')] }) as AdapterModule;
    const registry = await loadAdapters(['alpha', 'alpha-two'], { alpha: async () => alpha, 'alpha-two': async () => sibling });
    expect(registry.adapters).toHaveLength(2);
  });

  it('reports every problem at once', async () => {
    const problems = await problemsOf(['gamma', 'delta'], installed);
    expect(problems).toHaveLength(2);
    try {
      await loadAdapters(['gamma', 'delta'], installed);
    } catch (error) {
      expect((error as Error).message).toMatch(/^Cannot load adapters:\n {2}- "gamma".*\n {2}- "delta"/);
    }
  });
});

describe('listTools (answers tools/list)', () => {
  it('lists only the enabled adapters tools, in a stable order', async () => {
    const registry = await loadAdapters(['alpha', 'beta'], installed);
    expect(listTools(registry).map((tool) => tool.name)).toEqual(['alpha_search', 'alpha_job', 'beta_search']);
    expect(listTools(await loadAdapters(['beta'], installed)).map((tool) => tool.name)).toEqual(['beta_search']);
    expect(listTools(await loadAdapters([], installed))).toEqual([]);
  });

  it('is pure data: it never runs a handler, a session check or a loader', async () => {
    const loader = vi.fn(async () => alpha);
    const registry = await loadAdapters(['alpha'], { alpha: loader });
    loader.mockClear();
    listTools(registry);
    listTools(registry);
    expect(handlerCalls.count).toBe(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it('exposes schemas and annotations, and nothing about hosts, limits or the platform', async () => {
    const [tool] = listTools(await loadAdapters(['alpha'], installed));
    expect(Object.keys(tool ?? {}).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title']);
    expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true, idempotentHint: true });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(tool)).not.toContain('api.alpha.example.com');
  });

  it('serialises to JSON the MCP SDK can send', async () => {
    const tools = listTools(await loadAdapters(['alpha', 'beta'], installed));
    expect(JSON.parse(JSON.stringify(tools))).toEqual(tools);
  });
});

describe('an adapter added later needs no engine change', () => {
  it('plugs in a brand new adapter given only the installed table', async () => {
    const gamma = defineAdapter({
      id: 'gamma',
      displayName: 'Gamma',
      description: 'A new adapter.',
      sdkApi: SDK_API_VERSION,
      platform: 'gamma',
      kind: 'http',
      allowedHosts: ['api.gamma.example.com'],
      tools: [
        defineHttpTool({
          name: 'gamma_ping',
          title: 'Ping (read-only)',
          description: 'Ping the gamma API. Read-only, no side effects.',
          input: z.object({}).strict(),
          output: z.object({ ok: z.boolean() }),
          annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
          limits: { timeoutS: 10, cost: 1, outputMaxBytes: 2048 },
          handler: async () => ({ data: { ok: true }, warnings: [] }),
        }),
      ],
    });
    const registry = await loadAdapters(['gamma'], { gamma: async () => gamma });
    expect(listTools(registry).map((tool) => tool.name)).toEqual(['gamma_ping']);
  });
});
