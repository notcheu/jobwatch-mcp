import { SDK_API_VERSION, defineAdapter, defineHttpTool, defineUtility, validateAdapter, z, type AdapterModule } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import {
  describeInstalledAdapters,
  describeInstalledModules,
  describeInstalledUtilities,
  installedAdapterIds,
  installedAdapters,
  installedModules,
  installedUtilities,
  installedUtilityIds,
  budgetDefaults,
  managedModules,
  type InstalledAdapterMap,
  type InstalledModuleMap,
  type InstalledUtilityMap,
} from './index';

const make = (id: string): AdapterModule =>
  defineAdapter({
    id,
    displayName: id.toUpperCase(),
    description: `Test adapter ${id}.`,
    sdkApi: SDK_API_VERSION,
    platform: id,
    kind: 'http',
    allowedHosts: [`api.${id}.example.com`],
    tools: [
      defineHttpTool({
        name: `${id}_ping`,
        title: 'Ping (read-only)',
        description: 'Ping the API. Read-only, no side effects.',
        input: z.object({}).strict(),
        output: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
        limits: { timeoutS: 10, cost: 1, outputMaxBytes: 2048 },
        handler: async () => ({ data: { ok: true }, warnings: [] }),
      }),
    ],
  });

const makeUtility = (id: string) => {
  const { tools } = make(id);
  return defineUtility({
    id,
    displayName: id,
    description: `Test utility ${id}.`,
    sdkApi: SDK_API_VERSION,
    platform: id,
    allowedHosts: [`api.${id}.example.com`],
    tools: tools as never,
  });
};

describe('the real installed maps', () => {
  it('lists adapters and utilities apart: key = id, the right role, and every module passes the startup rules', async () => {
    const adapters: InstalledAdapterMap = installedAdapters;
    const utilities: InstalledUtilityMap = installedUtilities;
    for (const [id, load] of Object.entries(adapters)) {
      const adapter = await load();
      expect(adapter.id, `adapter ${id}`).toBe(id);
      expect(adapter.role ?? 'adapter', id).toBe('adapter');
      expect(validateAdapter(adapter), id).toEqual([]);
    }
    for (const [id, load] of Object.entries(utilities)) {
      const utility = await load();
      expect(utility.id, `utility ${id}`).toBe(id);
      expect(utility.role, id).toBe('utility');
      expect(validateAdapter(utility), id).toEqual([]);
    }
  });

  it('has no id in both maps, and the merged map holds exactly both', () => {
    expect(installedAdapterIds().filter((id) => installedUtilityIds().includes(id))).toEqual([]);
    expect(Object.keys(installedModules).sort()).toEqual([...installedAdapterIds(), ...installedUtilityIds()].sort());
  });

  it('exposes sorted ids', () => {
    expect(installedAdapterIds()).toEqual([...installedAdapterIds()].sort());
    expect(installedUtilityIds()).toEqual([...installedUtilityIds()].sort());
  });
});

describe('describeInstalledAdapters', () => {
  it('describes each adapter without running any handler, sorted by id', async () => {
    const map: InstalledAdapterMap = { b: async () => make('b'), a: async () => make('a') };
    const entries = await describeInstalledAdapters(map);
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(entries[0]?.summary).toMatchObject({
      id: 'a',
      role: 'adapter',
      platform: 'a',
      kind: 'http',
      allowedHosts: ['api.a.example.com'],
      tools: [{ name: 'a_ping', title: 'Ping (read-only)' }],
    });
  });

  it('reports a broken adapter and still describes the others', async () => {
    const map: InstalledAdapterMap = {
      good: async () => make('good'),
      broken: async () => {
        throw new Error('Cannot find module');
      },
      renamed: async () => make('other'),
    };
    const entries = await describeInstalledAdapters(map);
    expect(entries.map((entry) => [entry.id, entry.summary?.id ?? entry.error])).toEqual([
      ['broken', 'Cannot find module'],
      ['good', 'good'],
      ['renamed', 'module declares id "other", expected "renamed"'],
    ]);
  });

  it('reports a utility put in the adapters map', async () => {
    const map = { geo: async () => makeUtility('geo') } as unknown as InstalledAdapterMap;
    expect((await describeInstalledAdapters(map))[0]?.error).toBe('is not an adapter');
  });

  it('returns an empty list when nothing is installed', async () => {
    expect(await describeInstalledAdapters({})).toEqual([]);
  });
});

describe('describeInstalledUtilities and describeInstalledModules', () => {
  it('describes utilities with their role, and refuses an adapter in the utilities map', async () => {
    const map = { geo: async () => makeUtility('geo'), a: async () => make('a') } as unknown as InstalledUtilityMap;
    const entries = await describeInstalledUtilities(map);
    expect(entries.map((entry) => [entry.id, entry.summary?.role ?? entry.error])).toEqual([
      ['a', 'is not a utility'],
      ['geo', 'utility'],
    ]);
  });

  it('describes both kinds from the merged map', async () => {
    const map: InstalledModuleMap = { a: async () => make('a'), geo: async () => makeUtility('geo') };
    expect((await describeInstalledModules(map)).map((entry) => [entry.id, entry.summary?.role])).toEqual([
      ['a', 'adapter'],
      ['geo', 'utility'],
    ]);
  });
});

describe('the default budgets', () => {
  it('have an entry for every installed module and none for a module that is not installed', () => {
    expect(Object.keys(budgetDefaults).sort()).toEqual(Object.keys(installedModules).sort());
  });

  it('are whole numbers from 0 to 1000000, hourly and daily', () => {
    for (const [id, budget] of Object.entries(budgetDefaults)) {
      expect(Object.keys(budget).sort(), id).toEqual(['daily', 'hourly']);
      for (const value of Object.values(budget)) expect(Number.isInteger(value) && value >= 0 && value <= 1_000_000, id).toBe(true);
    }
  });

  it('leave room for the most expensive call of every tool, so no default makes a tool unrunnable', async () => {
    for (const [id, load] of Object.entries(installedModules)) {
      const budget = budgetDefaults[id];
      for (const tool of (await load()).tools) {
        expect(tool.limits.cost, `${id}/${tool.name} against hourly`).toBeLessThanOrEqual(budget?.hourly ?? 0);
        expect(tool.limits.cost, `${id}/${tool.name} against daily`).toBeLessThanOrEqual(budget?.daily ?? 0);
      }
    }
  });

  it('keep the approved LinkedIn budget: changing it takes a decision (docs/plans/09-security.md), so this test says so', () => {
    expect(budgetDefaults['linkedin']).toEqual({ hourly: 200, daily: 400 });
  });

  it('keep the other numbers that were declared by the modules before they moved here', () => {
    expect(budgetDefaults['apec']).toEqual({ hourly: 100, daily: 300 });
    expect(budgetDefaults['wttj']).toEqual({ hourly: 60, daily: 200 });
    for (const id of ['ashby', 'greenhouse', 'lever', 'teamtailor']) expect(budgetDefaults[id], id).toEqual({ hourly: 600, daily: 3000 });
    expect(budgetDefaults['ats-discovery']).toEqual({ hourly: 200, daily: 600 });
    expect(budgetDefaults['linkedin-geo']).toEqual({ hourly: 60, daily: 300 });
  });
});

describe('managedModules', () => {
  it('lists, for each gateway, exactly the installed adapters it reads through', async () => {
    for (const [id, follows] of Object.entries(managedModules)) {
      const gateway = await (installedAdapters as InstalledAdapterMap)[id]?.();
      const adapters = (gateway?.delegates?.to ?? []).filter((target) => target in installedAdapters);
      expect([...follows].sort()).toEqual([...adapters].sort());
      expect(follows.every((target) => target in installedAdapters)).toBe(true);
    }
  });
});
