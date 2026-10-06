import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CallLog, CircuitBreaker, RateLimiter, Store, createLogger, loadModules, policyFor } from '@jobwatch/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installedFixtures } from '../harness';
import { DashboardManager, type DashboardSettings } from './manager';

let manager: DashboardManager | undefined;
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(async () => {
  await manager?.stop();
  manager = undefined;
  vi.useRealTimers();
});

async function build(over: Partial<DashboardSettings> = {}) {
  const store = Store.open(':memory:');
  const registry = await loadModules(['probe'], installedFixtures);
  const settings: DashboardSettings = {
    port: 0,
    host: '127.0.0.1',
    url: 'https://jobs.example.com/dashboard/',
    publicOrigin: 'https://jobs.example.com',
    authRequired: false,
    oidc: undefined,
    idleS: 1800,
    sessionMaxS: 28_800,
    writeWindowS: 600,
    staticDir: undefined,
    ...over,
  };
  manager = new DashboardManager(
    settings,
    {
      version: 'test',
      clock: () => Date.now(),
      store,
      callLog: new CallLog(10),
      limiter: new RateLimiter(store, () => Date.now(), policyFor(registry.adapters)),
      breaker: new CircuitBreaker(store, () => Date.now()),
      registry: () => registry,
      installed: installedFixtures,
      pinned: false,
      runtime: () => undefined,
      sessionStates: () => new Map(),
      settings: {
        signIn: 'none',
        idleStopMinutes: 30,
        sessionMaxHours: 8,
        writeWindowMinutes: 10,
        callBuffer: 2000,
        charsPerToken: 3.5,
        jobRetentionDays: 30,
        maxTabs: 3,
        browser: { idleStopSeconds: 120, memoryHighMb: 1200, memoryMaxMb: 1500 },
        adaptersPinned: false,
      },
    },
    createLogger({ level: 'silent' }),
    () => Date.now(),
  );
  return manager;
}

// only timers and the clock are faked; sockets still run on real I/O
const get = async (port: number, path: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}${path}`)).status;

describe('DashboardManager', () => {
  it('is closed until it is started: nothing listens', async () => {
    const m = await build();
    expect(m.running).toBe(false);
    expect(m.status()).toMatchObject({ running: false, stopsAt: null, sessions: 0 });
  });

  it('opens the listener on start, answers, and closes it on stop', async () => {
    const m = await build();
    const status = await m.start();
    expect(status).toMatchObject({ running: true, url: 'https://jobs.example.com/dashboard/', signIn: 'none' });
    const port = m.port ?? 0;
    expect(port).toBeGreaterThan(0);
    expect(await get(port, '/dashboard/api/v1/me')).toBe(200);
    expect(await m.stop()).toMatchObject({ running: false });
    await expect(get(port, '/dashboard/api/v1/me')).rejects.toThrow();
    expect((await m.stop()).running).toBe(false); // already closed: fine
  });

  it('stops itself after the idle time, and a request pushes the time back', async () => {
    const m = await build({ idleS: 120 });
    await m.start();
    const port = m.port ?? 0;
    vi.advanceTimersByTime(100_000);
    expect(await get(port, '/dashboard/api/v1/overview')).toBe(200); // activity at 100 s
    vi.advanceTimersByTime(100_000); // 200 s: more than 120 s after the start, but only 100 s after the request
    expect(m.running).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000); // 130 s after the request
    expect(m.running).toBe(false);
  });

  it('start again while open renews the countdown and keeps the same listener', async () => {
    const m = await build({ idleS: 120 });
    await m.start();
    const first = m.port;
    vi.advanceTimersByTime(100_000);
    const again = await m.start();
    expect(m.port).toBe(first);
    expect(Date.parse(again.stopsAt ?? '')).toBe(Date.now() + 120_000);
    vi.advanceTimersByTime(100_000);
    expect(m.running).toBe(true);
  });

  it('takes a time to live in minutes for one start', async () => {
    const m = await build({ idleS: 1800 });
    const status = await m.start({ ttlMinutes: 5 });
    expect(Date.parse(status.stopsAt ?? '')).toBe(Date.now() + 5 * 60_000);
  });

  it('refuses to start where sign-in is required but no Google client is set', async () => {
    const m = await build({ authRequired: true });
    await expect(m.start()).rejects.toThrow('DASHBOARD_OIDC_CLIENT_ID');
    expect(m.running).toBe(false);
  });

  it('with a Google client it starts with sign-in required, and the client secret is not in the status', async () => {
    const m = await build({
      authRequired: true,
      oidc: { issuer: 'https://accounts.google.com', clientId: 'id', clientSecret: 'very-secret-value' },
    });
    const status = await m.start();
    expect(status.signIn).toBe('google');
    expect(JSON.stringify(status)).not.toContain('very-secret-value');
    expect(await get(m.port ?? 0, '/dashboard/api/v1/overview')).toBe(421); // a Host that is not the public one
  });

  it('fails cleanly when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const m = await build({ port: (blocker.address() as AddressInfo).port });
    await expect(m.start()).rejects.toThrow();
    expect(m.running).toBe(false);
    blocker.close();
  });
});
