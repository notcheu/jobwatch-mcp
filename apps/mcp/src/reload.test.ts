/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read JSON answers field by field */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendControl, controlSocketPath } from '@jobwatch/core';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedUtilities } from '@jobwatch/mcp-modules';
import { FakeHttpClient } from '@jobwatch/sdk/testkit';
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
      BASE_URL: 'http://127.0.0.1:18999',
      AUTH: 'none',
      LISTEN_HOST: '127.0.0.1',
      DATA_DIR: dir,
      DB_PATH: ':memory:',
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

  it('is refused while ADAPTERS pins the list', async () => {
    const { server } = await boot({ ADAPTERS: 'probe' });
    await expect(server.reloadAdapters()).rejects.toThrow('ADAPTERS');
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

describe('the dashboard through the control socket', () => {
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

  it('is closed at startup, opens on dashboard.start, answers, and closes on dashboard.stop', async () => {
    await enable(['probe']);
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port) });
    const socket = controlSocketPath(dir);
    expect(await sendControl(socket, { command: 'dashboard.status' })).toMatchObject({ ok: true, running: false });
    await expect(fetch(`http://127.0.0.1:${port}/dashboard/api/v1/me`)).rejects.toThrow();

    expect(await sendControl(socket, { command: 'dashboard.start', ttlMinutes: 5 })).toMatchObject({
      ok: true,
      running: true,
      signIn: 'none',
    });
    const me = await fetch(`http://127.0.0.1:${port}/dashboard/api/v1/me`);
    expect(await me.json()).toMatchObject({ mode: 'local', version: 'test' });

    expect(await sendControl(socket, { command: 'dashboard.stop' })).toMatchObject({ ok: true, running: false });
    await expect(fetch(`http://127.0.0.1:${port}/dashboard/api/v1/me`)).rejects.toThrow();
  });

  it('shows a call made through MCP in the dashboard, with its parameters in the detail only', async () => {
    await enable(['probe']);
    const port = await freePort();
    const { url } = await boot({ DASHBOARD_PORT: String(port) });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    const client = await connectClient(url);
    await client.listTools();
    await client.callTool({ name: 'probe_echo', arguments: { word: 'hello-dashboard' } });
    await client.close();
    const list = (await (await fetch(`http://127.0.0.1:${port}/dashboard/api/v1/calls`)).json()) as {
      calls: { id: number; tool: string }[];
    };
    expect(list.calls[0]?.tool).toBe('probe_echo');
    expect(JSON.stringify(list)).not.toContain('hello-dashboard');
    const detail = (await (await fetch(`http://127.0.0.1:${port}/dashboard/api/v1/calls/${list.calls[0]?.id}`)).json()) as {
      params: unknown;
    };
    expect(detail.params).toEqual({ word: 'hello-dashboard' });
  });

  it('is closed with the router', async () => {
    await enable(['probe']);
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port) });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    await running?.close(500);
    running = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/dashboard/api/v1/me`)).rejects.toThrow();
  });
});

describe('changing adapters from the dashboard', () => {
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
  const send = (port: number, method: string, path: string, body: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'content-type': 'application/json', 'x-jw-csrf': '1', origin: 'http://127.0.0.1:18999' },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += String(chunk)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  it('enables an adapter: the file is written, the registry reloaded and Claude would see the tools on its next list', async () => {
    await enable(['probe']);
    const port = await freePort();
    const { url } = await boot({ DASHBOARD_PORT: String(port) });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    expect(await toolNames(url)).not.toContain('other_ping');

    const answer = await send(port, 'PUT', '/dashboard/api/v1/adapters/other', { enabled: true });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: 'other', enabled: true, reconnectNeeded: true, addedTools: ['other_ping'] });
    expect(JSON.parse(await readFile(join(dir, 'adapters.json'), 'utf8'))).toEqual({ enabled: ['other', 'probe'], utilities: [] });
    expect(await toolNames(url)).toContain('other_ping');

    const off = await send(port, 'PUT', '/dashboard/api/v1/adapters/other', { enabled: false });
    expect(off.body).toMatchObject({ removedTools: ['other_ping'] });
    expect(await toolNames(url)).not.toContain('other_ping');
  });

  it('refuses an adapter that is not installed and writes nothing', async () => {
    await enable(['probe']);
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port) });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    const answer = await send(port, 'PUT', '/dashboard/api/v1/adapters/nothing-here', { enabled: true });
    expect(answer.status).toBe(404);
    expect(JSON.parse(await readFile(join(dir, 'adapters.json'), 'utf8'))).toEqual({ enabled: ['probe'] });
  });

  it('refuses while ADAPTERS pins the list', async () => {
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port), ADAPTERS: 'probe' });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    const answer = await send(port, 'PUT', '/dashboard/api/v1/adapters/other', { enabled: true });
    expect(answer).toMatchObject({ status: 409, body: { error: 'pinned' } });
  });

  it('refuses a change without the CSRF header or the right Origin', async () => {
    await enable(['probe']);
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port) });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    const bare = await fetch(`http://127.0.0.1:${port}/dashboard/api/v1/adapters/other`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(bare.status).toBe(403);
  });
});

describe('places through the control socket (jobwatch linkedin-geo)', () => {
  const BERLIN = [
    { id: '103035651', type: 'GEO', displayName: 'Berlin, Germany' },
    { id: '90009712', type: 'GEO', displayName: 'Berlin Metropolitan Area' },
  ];
  const bootWithGeo = async () => {
    await enable(['probe', 'linkedin-geo']);
    running = await start({
      env: {
        BASE_URL: 'http://127.0.0.1:18999',
        AUTH: 'none',
        LISTEN_HOST: '127.0.0.1',
        DATA_DIR: dir,
        DB_PATH: ':memory:',
      },
      version: 'test',
      installed: { ...installedFixtures, 'linkedin-geo': installedUtilities['linkedin-geo'] },
      createHttp: () => new FakeHttpClient(['www.linkedin.com'], [{ url: /typeaheadHits\?typeaheadType=GEO&query=Berlin$/, body: BERLIN }]),
      port: 0,
      metricsPort: 0,
      logDestination: { write: () => true } as never,
    });
    return controlSocketPath(dir);
  };

  it('looks a place up, remembers a name for it, lists it and forgets it', async () => {
    const socket = await bootWithGeo();
    const found = await sendControl(socket, { command: 'linkedin-geo.lookup', query: 'Berlin' });
    expect(found).toMatchObject({ ok: true, best: { id: '103035651' } });
    expect((found as any).places.map((place: any) => place.id)).toEqual(['103035651', '90009712']);

    expect(
      await sendControl(socket, { command: 'linkedin-geo.save', alias: 'home', id: '103035651', label: 'Berlin, Germany' }),
    ).toMatchObject({
      ok: true,
      saved: { alias: 'home', id: '103035651' },
    });
    expect(((await sendControl(socket, { command: 'linkedin-geo.list' })) as any).remembered).toEqual([
      { alias: 'home', id: '103035651', label: 'Berlin, Germany', saved_by: 'operator' },
    ]);
    expect(((await sendControl(socket, { command: 'linkedin-geo.forget', alias: 'Home' })) as any).remembered).toEqual([]);
  });

  it('shows the lookup in the call history like any other call', async () => {
    const socket = await bootWithGeo();
    await sendControl(socket, { command: 'linkedin-geo.lookup', query: 'Berlin' });
    expect(running?.callLog.list({ limit: 5 }).calls[0]).toMatchObject({ tool: 'linkedin_locations', code: 'ok' });
  });

  it('says to enable the adapter when it is not', async () => {
    await enable(['probe']);
    const socket = await (async () => {
      running = await start({
        env: {
          BASE_URL: 'http://127.0.0.1:18999',
          AUTH: 'none',
          LISTEN_HOST: '127.0.0.1',
          DATA_DIR: dir,
          DB_PATH: ':memory:',
        },
        version: 'test',
        installed: installedFixtures,
        port: 0,
        metricsPort: 0,
        logDestination: { write: () => true } as never,
      });
      return controlSocketPath(dir);
    })();
    expect(await sendControl(socket, { command: 'linkedin-geo.lookup', query: 'Berlin' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('jobwatch adapters enable linkedin-geo'),
    });
  });
});
