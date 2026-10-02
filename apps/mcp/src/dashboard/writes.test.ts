/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read JSON answers field by field; their shapes are pinned by the strict schemas of dashboard-api */
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@jobwatch/core';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeRefused, registerWrites, type Changes } from './writes';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  vi.useRealTimers();
});

async function setup(over: Partial<Changes> = {}) {
  const changes: Changes = {
    setAdapter: vi.fn(async () => ({ enabledAdapters: ['apec'], addedTools: ['apec_search', 'apec_job'], removedTools: [] })),
    running: vi.fn(() => 0),
    restart: vi.fn(),
    ...over,
  };
  const entries: { msg: string; actor?: string }[] = [];
  const logger = createLogger({ level: 'info', destination: { write: (line: string) => (entries.push(JSON.parse(line)), true) } as never });
  const app = express();
  const router = express.Router();
  registerWrites(router, changes, logger);
  app.use((_req, res, next) => ((res.locals['session'] = { email: 'me@example.com' }), next()), router);
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      void res.status(400).json({ error: 'invalid_request', message: String(error instanceof Error ? error.name : '') }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const send = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { changes, send, entries };
}

describe('enable and disable an adapter', () => {
  it('applies the change, says what tools appeared and that the connector must reconnect, and logs who did it', async () => {
    const t = await setup();
    const answer = await t.send('PUT', '/adapters/apec', { enabled: true });
    expect(answer).toEqual({
      status: 200,
      body: {
        id: 'apec',
        enabled: true,
        enabledAdapters: ['apec'],
        addedTools: ['apec_search', 'apec_job'],
        removedTools: [],
        reconnectNeeded: true,
      },
    });
    expect(t.changes.setAdapter).toHaveBeenCalledWith('apec', true);
    expect(t.entries.find((e) => e.msg === 'dashboard_adapter_changed')).toMatchObject({
      actor: 'me@example.com',
      adapter: 'apec',
      enabled: true,
    });
  });

  it('turns an adapter off', async () => {
    const t = await setup();
    await t.send('PUT', '/adapters/apec', { enabled: false });
    expect(t.changes.setAdapter).toHaveBeenCalledWith('apec', false);
  });

  it('shows the refusal of the router: pinned list, unknown adapter, an adapter that does not load', async () => {
    for (const [status, code] of [
      [409, 'pinned'],
      [404, 'not_found'],
      [422, 'not_loadable'],
    ] as const) {
      const t = await setup({
        setAdapter: async () => {
          throw new ChangeRefused(status, code, `because ${code}`);
        },
      });
      expect(await t.send('PUT', '/adapters/apec', { enabled: true })).toEqual({
        status,
        body: { error: code, message: `because ${code}` },
      });
    }
  });

  it('refuses a bad id or body before it reaches the router', async () => {
    const t = await setup();
    expect((await t.send('PUT', '/adapters/Bad%20Id', { enabled: true })).status).toBe(400);
    expect((await t.send('PUT', '/adapters/apec', { enabled: 'yes' })).status).toBe(400);
    expect((await t.send('PUT', '/adapters/apec', { enabled: true, extra: 1 })).status).toBe(400);
    expect(t.changes.setAdapter).not.toHaveBeenCalled();
  });
});

describe('restart', () => {
  it('answers first, then stops the process a moment later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const t = await setup();
    vi.useRealTimers();
    const answer = await t.send('POST', '/router/restart', {});
    expect(answer).toEqual({ status: 200, body: { restarting: true } });
    expect(t.changes.restart).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.changes.restart).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(t.entries.find((e) => e.msg === 'dashboard_restart_requested')).toMatchObject({ actor: 'me@example.com', force: false });
  });

  it('refuses while a call is running, unless forced', async () => {
    const t = await setup({ running: () => 2 });
    const refused = await t.send('POST', '/router/restart', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'busy' });
    expect(refused.body.message).toContain('2 calls are still running');
    expect(t.changes.restart).not.toHaveBeenCalled();
    expect((await t.send('POST', '/router/restart', { force: true })).status).toBe(200);
  });

  it('refuses an unknown field in the body', async () => {
    const t = await setup();
    expect((await t.send('POST', '/router/restart', { force: true, now: 1 })).status).toBe(400);
  });
});
