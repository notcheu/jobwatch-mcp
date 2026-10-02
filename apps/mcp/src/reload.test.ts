import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendControl, controlSocketPath } from '@jobwatch/core';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedFixtures, connectClient } from './harness';
import { start, type RunningServer } from './server';

let dir: string;
let running: RunningServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-reload-'));
});
afterEach(async () => {
  await running?.close(500);
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

const enable = (ids: string[]) => writeFile(join(dir, 'adapters.json'), JSON.stringify({ enabled: ids }));
const boot = async (env: Record<string, string> = {}) => {
  running = await start({
    env: {
      JW_BASE_URL: 'http://127.0.0.1:18999',
      JW_AUTH: 'none',
      JW_LISTEN_HOST: '127.0.0.1',
      JW_DATA_DIR: dir,
      JW_DB_PATH: ':memory:',
      ...env,
    },
    version: 'test',
    installed: installedFixtures,
    port: 0,
    metricsPort: 0,
    logDestination: { write: () => true } as never,
  });
  const url = new URL(`http://127.0.0.1:${(running.mcp.address() as AddressInfo).port}/mcp`);
  return { url, server: running };
};
const toolNames = async (url: URL): Promise<string[]> => {
  const client = await connectClient(url);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  await client.close();
  return names;
};

describe('hot reload of adapters', () => {
  it('lists a newly enabled adapter on the next request and drops a disabled one, without a restart', async () => {
    await enable(['probe']);
    const { url, server } = await boot();
    expect(await toolNames(url)).toContain('probe_echo');
    expect(await toolNames(url)).not.toContain('other_ping');

    await enable(['other']);
    const result = await server.reloadAdapters();
    expect(result).toMatchObject({ enabled: ['other'], addedAdapters: ['other'], removedAdapters: ['probe'], addedTools: ['other_ping'] });
    const after = await toolNames(url);
    expect(after).toContain('other_ping');
    expect(after).not.toContain('probe_echo');
    expect(after).toContain('session_status'); // the built-in tools stay
  });

  it('keeps serving the old list when the new one does not load', async () => {
    await enable(['probe']);
    const { url, server } = await boot();
    await enable(['probe', 'does-not-exist']);
    await expect(server.reloadAdapters()).rejects.toThrow();
    expect(await toolNames(url)).toContain('probe_echo');
  });

  it('is refused while JW_ADAPTERS pins the list', async () => {
    const { server } = await boot({ JW_ADAPTERS: 'probe' });
    await expect(server.reloadAdapters()).rejects.toThrow('JW_ADAPTERS');
  });

  it('can be triggered through the control socket in the data directory', async () => {
    await enable(['probe']);
    const { url } = await boot();
    await enable(['probe', 'other']);
    const answer = await sendControl(controlSocketPath(dir), { command: 'adapters.reload' });
    expect(answer).toMatchObject({ ok: true, addedAdapters: ['other'] });
    expect(await toolNames(url)).toContain('other_ping');
    expect(await sendControl(controlSocketPath(dir), { command: 'ping' })).toMatchObject({ ok: true, version: 'test' });
  });

  it('removes the control socket when the router stops', async () => {
    await enable(['probe']);
    await boot();
    await running?.close(500);
    running = undefined;
    expect(await sendControl(controlSocketPath(dir), { command: 'ping' })).toBeUndefined();
  });
});
