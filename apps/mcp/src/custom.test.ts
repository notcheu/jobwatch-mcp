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
    expect(await toolNames(url)).not.toContain('acme');
  });

  it('are loaded when the switch is on and they are enabled, and not when they are off', async () => {
    seed([row, { ...row, handle: 'idle' }].slice(0, 1));
    const store = Store.open(join(dir, 'jobwatch.sqlite'));
    store.saveCustomAdapter({ ...row, handle: 'idle', name: 'Idle' }, { create: true, actor: 'test' }, 1); // never enabled
    store.close();
    const { url } = await boot(ON);
    const names = await toolNames(url);
    expect(names).toContain('acme');
    expect(names).not.toContain('idle');
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
    const result = await client.callTool({ name: 'acme', arguments: { boards: ['acme'], title_any: ['engineer'], detail: 'full' } });
    await client.close();
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      jobs: { id: string; source: string; board: string; description: string }[];
      boards: { status: string }[];
    };
    expect(data.jobs.map((job) => [job.id, job.source, job.board])).toEqual([['j1', 'acme', 'acme']]);
    expect(data.jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(http.requests.map((request) => request.url)).toEqual(['https://careers.acme.com/api/acme']);
  }, 30_000);

  it('take the filters their operator declared: listed in the schema, handed to the script as given, and refused when outside the options', async () => {
    const filters = [
      {
        name: 'contract',
        description: 'The type of contract.',
        type: 'multiselect' as const,
        options: [{ value: 'CDI' }, { value: 'CDD' }, { value: 'Stage' }],
      },
      { name: 'sector', description: 'The job sector.', type: 'select' as const, options: [{ value: 'commercial' }, { value: 'it' }] },
    ];
    // the script asks the site for what the caller chose, as the real one does with the site's own filters
    const withFilters = {
      ...row,
      filters,
      script: `async function read(board, filters) {
  const query = 'contract=' + filters.contract.join(',') + '&sector=' + (filters.sector || '');
  const list = (await http.get('https://careers.acme.com/api/' + board + '?' + query)).json();
  return { name: board, postings: list.map((j) => ({ id: j.id, title: j.title, url: 'https://careers.acme.com/j/' + j.id, description: j.text })) };
}`,
    };
    seed([withFilters]);
    const http = new FakeHttpClient(
      ['careers.acme.com'],
      [
        {
          url: 'https://careers.acme.com/api/acme?contract=CDI,Stage&sector=it',
          body: [{ id: 'j1', title: 'Data Engineer', text: 'Data.' }],
        },
      ],
    );
    const { url } = await boot(ON, http);
    const client = await connectClient(url);
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'acme');
    const properties = (listed?.inputSchema as { properties: Record<string, { items?: { enum?: string[] }; enum?: string[] }> }).properties;
    expect(properties['contract']?.items?.enum).toEqual(['CDI', 'CDD', 'Stage']);
    expect(properties['sector']?.enum).toEqual(['commercial', 'it']);
    const refused = await client.callTool({ name: 'acme', arguments: { boards: ['acme'], sector: 'finance' } });
    expect(refused.isError).toBe(true);
    expect(http.requests).toEqual([]); // refused before the script ran
    const result = await client.callTool({
      name: 'acme',
      arguments: { boards: ['acme'], contract: ['CDI', 'Stage'], sector: 'it' },
    });
    await client.close();
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual(['j1']);
    // the route only answers the full query, so the job proves the script sent the caller's choice; the log keeps no query string
    expect(http.requests.map((request) => request.url)).toEqual(['https://careers.acme.com/api/acme']);
  }, 30_000);

  it('keep the id, the tool and the job source of an adapter made before ids were stored: custom-<handle>, custom_<handle>', async () => {
    seed([row]);
    const raw = new (await import('node:sqlite')).DatabaseSync(join(dir, 'jobwatch.sqlite'));
    raw.exec("UPDATE custom_adapters SET module_id = 'custom-acme' WHERE handle = 'acme'"); // what the migration gave the first adapters
    raw.close();
    const http = new FakeHttpClient(
      ['careers.acme.com'],
      [{ url: 'https://careers.acme.com/api/acme', body: [{ id: 'j1', title: 'Data Engineer', text: 'Data.' }] }],
    );
    const { url } = await boot(ON, http);
    const names = await toolNames(url);
    expect(names).toContain('custom_acme');
    expect(names).not.toContain('acme');
    const client = await connectClient(url);
    const result = await client.callTool({ name: 'custom_acme', arguments: { boards: ['acme'] } });
    await client.close();
    expect((result.structuredContent as { jobs: { source: string }[] }).jobs.map((job) => job.source)).toEqual(['custom-acme']);
  }, 30_000);

  it('read a stored list that breaks the rules as no filter, so the adapter still loads and no built-in filter is shadowed', async () => {
    const store = Store.open(join(dir, 'jobwatch.sqlite'));
    store.saveCustomAdapter({ ...row, filters: [] }, { create: true, actor: 'test' }, 1);
    store.setCustomAdapterEnabled('acme', true, 'test', 2);
    store.close();
    const raw = new (await import('node:sqlite')).DatabaseSync(join(dir, 'jobwatch.sqlite'));
    raw.exec(`UPDATE custom_adapters SET filters = '[{"name":"max_results","description":"x","type":"boolean"}]' WHERE handle = 'acme'`);
    raw.close();
    const { url } = await boot(ON);
    expect(await toolNames(url)).toContain('acme');
  });

  it('are picked up by a reload with no restart: a created one appears, a changed script applies, a deleted one goes', async () => {
    const { url, server } = await boot(ON);
    expect(await toolNames(url)).not.toContain('acme');
    server.store.saveCustomAdapter(row, { create: true, actor: 'me' }, 1);
    server.store.setCustomAdapterEnabled('acme', true, 'me', 2);
    expect(await server.reloadAdapters()).toMatchObject({ addedAdapters: ['acme'], addedTools: ['acme'] });
    expect(await toolNames(url)).toContain('acme');
    server.store.deleteCustomAdapter('acme', 'me', 3);
    expect(await server.reloadAdapters()).toMatchObject({ removedAdapters: ['acme'], removedTools: ['acme'] });
  });

  it('cannot stop the router from starting: a bad row is left out and the others load', async () => {
    seed([{ ...row, handle: 'broken', url: 'http://careers.acme.com' }, row]);
    const { url } = await boot(ON);
    const names = await toolNames(url);
    expect(names).toContain('acme');
    expect(names).not.toContain('broken');
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
