import { SDK_API_VERSION, defineAdapter, defineHttpTool, validateAdapter, z, type AdapterModule } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { describeInstalled, installed, installedIds, type InstalledMap } from './index';

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

describe('the real installed table', () => {
  it('only contains well-formed entries: key = adapter id, and every adapter passes the startup rules', async () => {
    const table: InstalledMap = installed; // widen: the literal type is `{}` while the list is empty
    for (const [id, load] of Object.entries(table)) {
      const adapter = await load();
      expect(adapter.id, `key ${id}`).toBe(id);
      expect(validateAdapter(adapter), id).toEqual([]);
    }
  });

  it('exposes sorted ids', () => {
    expect(installedIds()).toEqual([...installedIds()].sort());
  });
});

describe('describeInstalled', () => {
  it('describes each adapter without running any handler, sorted by id', async () => {
    const map: InstalledMap = { b: async () => make('b'), a: async () => make('a') };
    const entries = await describeInstalled(map);
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(entries[0]?.summary).toMatchObject({
      id: 'a',
      platform: 'a',
      kind: 'http',
      allowedHosts: ['api.a.example.com'],
      tools: [{ name: 'a_ping', title: 'Ping (read-only)' }],
    });
  });

  it('reports a broken adapter and still describes the others', async () => {
    const map: InstalledMap = {
      good: async () => make('good'),
      broken: async () => {
        throw new Error('Cannot find module');
      },
      renamed: async () => make('other'),
    };
    const entries = await describeInstalled(map);
    expect(entries.map((entry) => [entry.id, entry.summary?.id ?? entry.error])).toEqual([
      ['broken', 'Cannot find module'],
      ['good', 'good'],
      ['renamed', 'module declares id "other", expected "renamed"'],
    ]);
  });

  it('returns an empty list when nothing is installed', async () => {
    expect(await describeInstalled({})).toEqual([]);
  });
});
