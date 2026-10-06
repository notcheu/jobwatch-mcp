/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read JSON answers field by field */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlSocketPath, sendControl } from '@jobwatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeContexts } from './fixtures';
import { connectClient, installedFixtures } from './harness';
import { start, type RunningServer } from './server';

let dir: string;
let running: RunningServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-budget-'));
  await writeFile(join(dir, 'adapters.json'), JSON.stringify({ enabled: ['probe'] }));
});
afterEach(async () => {
  await running?.close(500);
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

const boot = async (env: Record<string, string> = {}, budgetDefaults?: Record<string, { hourly: number; daily: number }>) => {
  running = await start({
    env: { BASE_URL: 'http://127.0.0.1:18999', AUTH: 'none', LISTEN_HOST: '127.0.0.1', DATA_DIR: dir, DB_PATH: ':memory:', ...env },
    version: 'test',
    installed: installedFixtures,
    contexts: fakeContexts, // the fake context counts the call as one request, as a real HTTP call would be
    ...(budgetDefaults ? { budgetDefaults } : {}),
    port: 0,
    metricsPort: 0,
    logDestination: { write: () => true } as never,
  });
  return { url: new URL(`http://127.0.0.1:${(running.mcp.address() as AddressInfo).port}/mcp`), server: running };
};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

const api = (port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/dashboard/api/v1${path}`,
        method,
        headers: { 'content-type': 'application/json', 'x-jw-csrf': '1', origin: `http://127.0.0.1:${port}` },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

const echo = async (url: URL, times: number): Promise<string[]> => {
  const client = await connectClient(url);
  const codes: string[] = [];
  for (let i = 0; i < times; i += 1) {
    const result = await client.callTool({ name: 'probe_echo', arguments: { word: 'x' } });
    codes.push(result.isError ? String(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}').code) : 'ok');
  }
  await client.close();
  return codes;
};

describe('the request budget of a module', () => {
  it('uses the defaults file, then the environment over it: the limiter refuses the call after the configured number', async () => {
    const { url } = await boot({ PROBE_BUDGET_HOURLY: '2' }, { probe: { hourly: 5, daily: 50 } });
    expect(await echo(url, 3)).toEqual(['ok', 'ok', 'rate_limited']);
  });

  it('applies what was saved in budgets.json, and the defaults file when nothing else is set', async () => {
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({ probe: { hourly: 1 } }));
    const { url } = await boot({}, { probe: { hourly: 5, daily: 50 } });
    expect(await echo(url, 2)).toEqual(['ok', 'rate_limited']);
  });

  it('keeps what the module declares when no default, no saved value and no variable is set', async () => {
    const { url } = await boot();
    expect(await echo(url, 3)).toEqual(['ok', 'ok', 'ok']); // the engine default of an HTTP module is far above 3
  });

  it('stops the start, naming the variable, when one is not a whole number from 0 to 1000000', async () => {
    await expect(boot({ PROBE_BUDGET_DAILY: '-5' })).rejects.toThrow('PROBE_BUDGET_DAILY');
    await expect(boot({ PROBE_BUDGET_HOURLY: '2000000' })).rejects.toThrow('PROBE_BUDGET_HOURLY');
  });

  it('is changed from the dashboard, applies to the very next call without a restart, and is kept in budgets.json', async () => {
    const port = await freePort();
    const { url } = await boot({ DASHBOARD_PORT: String(port) }, { probe: { hourly: 5, daily: 50 } });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });

    const before = (await api(port, 'GET', '/tools')).body.adapters.find((a: any) => a.id === 'probe');
    expect(before.budget).toEqual({
      hourly: { value: 5, source: 'default', default: 5, envVar: 'PROBE_BUDGET_HOURLY' },
      daily: { value: 50, source: 'default', default: 50, envVar: 'PROBE_BUDGET_DAILY' },
    });
    expect(before.rateHour.limit).toBe(5);
    expect(await echo(url, 1)).toEqual(['ok']);

    const saved = await api(port, 'PUT', '/adapters/probe/budget', { hourly: 2 });
    expect(saved).toMatchObject({ status: 200, body: { id: 'probe', budget: { hourly: { value: 2, source: 'config', default: 5 } } } });
    expect(JSON.parse(await readFile(join(dir, 'budgets.json'), 'utf8'))).toEqual({ probe: { hourly: 2 } });
    expect(await echo(url, 2)).toEqual(['ok', 'rate_limited']); // 1 used + 1 more = 2, the third is refused

    const after = (await api(port, 'GET', '/tools')).body.adapters.find((a: any) => a.id === 'probe');
    expect(after.rateHour.limit).toBe(2);
    expect(after.budget.daily.source).toBe('default');
  });

  it('shows the budget of a module that is not enabled too, and refuses one that is not installed', async () => {
    const port = await freePort();
    await boot({ DASHBOARD_PORT: String(port), OTHER_BUDGET_DAILY: '7' });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });
    const other = (await api(port, 'GET', '/tools')).body.adapters.find((a: any) => a.id === 'other');
    expect(other).toMatchObject({ enabled: false, rateDay: null, budget: { daily: { value: 7, source: 'env' } } });
    expect((await api(port, 'PUT', '/adapters/nothing-here/budget', { hourly: 1 })).status).toBe(404);
  });

  it('refuses to change a window the environment sets, saves the other one, and refuses when both are set', async () => {
    const port = await freePort();
    const { url } = await boot({ DASHBOARD_PORT: String(port), PROBE_BUDGET_HOURLY: '9' });
    await sendControl(controlSocketPath(dir), { command: 'dashboard.start' });

    const locked = await api(port, 'PUT', '/adapters/probe/budget', { hourly: 1 });
    expect(locked).toMatchObject({ status: 409, body: { error: 'env_locked' } });
    expect(locked.body.message).toContain('PROBE_BUDGET_HOURLY');

    const partial = await api(port, 'PUT', '/adapters/probe/budget', { hourly: 1, daily: 30 });
    expect(partial.body.budget).toMatchObject({ hourly: { value: 9, source: 'env' }, daily: { value: 30, source: 'config' } });
    expect(JSON.parse(await readFile(join(dir, 'budgets.json'), 'utf8'))).toEqual({ probe: { daily: 30 } });
    expect(await echo(url, 1)).toEqual(['ok']);
  });
});
