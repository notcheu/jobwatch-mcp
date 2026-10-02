import { SDK_API_VERSION, defineAdapter, defineHttpTool, z, type AdapterModule } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { loadAdapters } from './registry';
import { createRegistryHolder } from './registryHolder';

const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;
const adapter = (id: string, tools: string[]): AdapterModule =>
  defineAdapter({
    id,
    displayName: id,
    description: `The ${id} adapter.`,
    sdkApi: SDK_API_VERSION,
    platform: id,
    kind: 'http',
    allowedHosts: [`${id}.example.com`],
    tools: tools.map((name) =>
      defineHttpTool({
        name,
        title: `${name} (read-only)`,
        description: `Does ${name}. Read-only, no side effects.`,
        input: z.object({}).strict(),
        output: z.object({ ok: z.boolean() }),
        annotations,
        limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
        handler: async () => ({ data: { ok: true }, warnings: [] }),
      }),
    ),
  });

const table = { aa: async () => adapter('aa', ['aa_one', 'aa_two']), bb: async () => adapter('bb', ['bb_one']) };
const load = (ids: readonly string[]) => loadAdapters(ids, table);

describe('RegistryHolder', () => {
  it('serves the current registry through a view that follows a reload, and reports what changed', async () => {
    const holder = createRegistryHolder(await load(['aa']), load);
    const view = holder.view;
    expect([...view.tools.keys()]).toEqual(['aa_one', 'aa_two']);
    const result = await holder.reload(['bb']);
    expect([...view.tools.keys()]).toEqual(['bb_one']);
    expect(view.enabled.map((entry) => entry.id)).toEqual(['bb']);
    expect(result).toEqual({
      enabled: ['bb'],
      addedAdapters: ['bb'],
      removedAdapters: ['aa'],
      addedTools: ['bb_one'],
      removedTools: ['aa_one', 'aa_two'],
    });
  });

  it('keeps the old registry when the new one does not load', async () => {
    const holder = createRegistryHolder(await load(['aa']), load);
    await expect(holder.reload(['aa', 'nope'])).rejects.toThrow();
    expect([...holder.view.tools.keys()]).toEqual(['aa_one', 'aa_two']);
  });

  it('lets a call that already looked its tool up keep it, whatever a reload does after', async () => {
    const holder = createRegistryHolder(await load(['aa']), load);
    const registered = holder.view.tools.get('aa_one');
    await holder.reload([]);
    expect(holder.view.tools.get('aa_one')).toBeUndefined();
    expect(registered?.tool.name).toBe('aa_one');
  });

  it('runs the swap hook before the new registry becomes visible, and a failing hook leaves the old one', async () => {
    const seen: string[] = [];
    const holder = createRegistryHolder(await load(['aa']), load, async (next, previous) => {
      seen.push(
        `${[...previous.tools.keys()].length}->${[...next.tools.keys()].length} while ${[...holder.view.tools.keys()].length} visible`,
      );
    });
    await holder.reload(['aa', 'bb']);
    expect(seen).toEqual(['2->3 while 2 visible']);
    const failing = createRegistryHolder(await load(['aa']), load, async () => {
      throw new Error('runtime could not start');
    });
    await expect(failing.reload(['bb'])).rejects.toThrow('runtime could not start');
    expect([...failing.view.tools.keys()]).toEqual(['aa_one', 'aa_two']);
  });

  it('runs reloads one after the other', async () => {
    const order: string[] = [];
    const slow = (ids: readonly string[]) =>
      new Promise<Awaited<ReturnType<typeof load>>>((resolve) => {
        order.push(`start ${ids.join('')}`);
        setTimeout(() => load(ids).then((registry) => (order.push(`end ${ids.join('')}`), resolve(registry))), ids[0] === 'aa' ? 30 : 1);
      });
    const holder = createRegistryHolder(await load([]), slow);
    await Promise.all([holder.reload(['aa']), holder.reload(['bb'])]);
    expect(order).toEqual(['start aa', 'end aa', 'start bb', 'end bb']);
    expect(holder.view.enabled.map((entry) => entry.id)).toEqual(['bb']);
  });
});
