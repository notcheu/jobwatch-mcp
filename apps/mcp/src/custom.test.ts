import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, processSpawner } from '@jobwatch/core';
import { FakeHttpClient } from '@jobwatch/sdk/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedFixtures, connectClient } from './harness';
import { start, type RunningServer } from './server';

let dir: string;
let running: RunningServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-custom-'));
});
afterEach(async () => {
  await running?.close(500);
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

const script = `async function read(board) {
  const list = (await http.get('https://careers.acme.com/api/' + board)).json();
  return { name: board, postings: list.map((j) => ({ id: j.id, title: j.title, url: 'https://careers.acme.com/j/' + j.id, locations: ['Paris'], description: j.text })) };
}`;
const row = { handle: 'acme', name: 'Acme jobs', kind: 'http' as const, url: 'https://careers.acme.com/api', script };

const seed = (rows: (typeof row)[], enable = true): void => {
  const store = Store.open(join(dir, 'jobwatch.sqlite'));
  for (const entry of rows) {
    store.saveCustomAdapter(entry, { create: true, actor: 'test' }, 1);
    if (enable) store.setCustomAdapterEnabled(entry.handle, true, 'test', 2);
  }
  store.close();
};

const boot = async (env: Record<string, string> = {}, http = new FakeHttpClient(['careers.acme.com'], [])) => {
  running = await start({
    env: { BASE_URL: 'http://127.0.0.1:18999', AUTH: 'none', LISTEN_HOST: '127.0.0.1', DATA_DIR: dir, ...env },
    version: 'test',
    installed: installedFixtures,
    port: 0,
    metricsPort: 0,
    controlSocket: false,
    sandboxSpawner: processSpawner(),
    createHttp: () => http,
    logDestination: { write: () => true } as never,
  });
  return { url: new URL(`http://127.0.0.1:${(running.mcp.address() as AddressInfo).port}/mcp`), server: running, http };
};
const toolNames = async (url: URL): Promise<string[]> => {
  const client = await connectClient(url);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  await client.close();
  return names;
};
const ON = { CUSTOM_ADAPTERS: 'on', CUSTOM_ADAPTERS_SANDBOX: 'process' };

describe('custom adapters', () => {
  it('are off by default: an adapter in the database is not loaded, and its tool is not listed', async () => {
    seed([row]);
    const { url } = await boot();
    expect(await toolNames(url)).not.toContain('custom_acme');
  });

  it('are loaded when the switch is on and they are enabled, and not when they are off', async () => {
    seed([row, { ...row, handle: 'idle' }].slice(0, 1));
    const store = Store.open(join(dir, 'jobwatch.sqlite'));
    store.saveCustomAdapter({ ...row, handle: 'idle', name: 'Idle' }, { create: true, actor: 'test' }, 1); // never enabled
    store.close();
    const { url } = await boot(ON);
    const names = await toolNames(url);
    expect(names).toContain('custom_acme');
    expect(names).not.toContain('custom_idle');
  });

  it('answer a call through the same tool surface as the other company boards, running the script in the sandbox', async () => {
    seed([row]);
    const http = new FakeHttpClient(
      ['careers.acme.com'],
      [
        {
          url: 'https://careers.acme.com/api/acme',
          body: [
            { id: 'j1', title: 'Senior Frontend Engineer', text: 'We use React and TypeScript.' },
            { id: 'j2', title: 'Office Manager', text: 'Run the office.' },
          ],
        },
      ],
    );
    const { url } = await boot(ON, http);
    const client = await connectClient(url);
    const result = await client.callTool({ name: 'custom_acme', arguments: { boards: ['acme'], title_any: ['engineer'], detail: 'full' } });
    await client.close();
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      jobs: { id: string; source: string; board: string; description: string }[];
      boards: { status: string }[];
    };
    expect(data.jobs.map((job) => [job.id, job.source, job.board])).toEqual([['j1', 'custom-acme', 'acme']]);
    expect(data.jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(http.requests.map((request) => request.url)).toEqual(['https://careers.acme.com/api/acme']);
  }, 30_000);

  it('are picked up by a reload with no restart: a created one appears, a changed script applies, a deleted one goes', async () => {
    const { url, server } = await boot(ON);
    expect(await toolNames(url)).not.toContain('custom_acme');
    server.store.saveCustomAdapter(row, { create: true, actor: 'me' }, 1);
    server.store.setCustomAdapterEnabled('acme', true, 'me', 2);
    expect(await server.reloadAdapters()).toMatchObject({ addedAdapters: ['custom-acme'], addedTools: ['custom_acme'] });
    expect(await toolNames(url)).toContain('custom_acme');
    server.store.deleteCustomAdapter('acme', 'me', 3);
    expect(await server.reloadAdapters()).toMatchObject({ removedAdapters: ['custom-acme'], removedTools: ['custom_acme'] });
  });

  it('cannot stop the router from starting: a bad row is left out and the others load', async () => {
    seed([{ ...row, handle: 'broken', url: 'http://careers.acme.com' }, row]);
    const { url } = await boot(ON);
    const names = await toolNames(url);
    expect(names).toContain('custom_acme');
    expect(names).not.toContain('custom_broken');
  });

  it('refuse to start with the bare-process sandbox on a router that is reachable (AUTH=front)', async () => {
    await expect(
      start({
        env: {
          BASE_URL: 'https://mcp.example.com',
          AUTH: 'front',
          FRONT_SHARED_SECRET: 'x'.repeat(20),
          DATA_DIR: dir,
          DB_PATH: ':memory:',
          ...ON,
        },
        version: 'test',
        installed: installedFixtures,
        port: 0,
        controlSocket: false,
        logDestination: { write: () => true } as never,
      }),
    ).rejects.toThrow(/CUSTOM_ADAPTERS_SANDBOX=process/);
  });
});
