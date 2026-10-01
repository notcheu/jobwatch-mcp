import { Writable } from 'node:stream';
import type { JobwatchError } from '@jobwatch/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging';
import { FakeBackend } from './fake';
import { RuntimeManager, type ManagerConfig, type RuntimeEvent, type RuntimeHooks } from './manager';

const MB = 1024 * 1024;
const config: ManagerConfig = {
  image: 'jobwatch-browser:test',
  network: 'jobwatch-browsers',
  profileVolumePrefix: 'jw-profile-',
  idleTtlS: 120,
  maxLifetimeS: 1800,
  queueTimeoutS: 60,
  memMaxMb: 1500,
  memHighMb: 1200,
  watchdogIntervalMs: 5000,
};

let backend: FakeBackend;
let events: RuntimeEvent[];
let logText: string;

function make(over: Partial<ManagerConfig> = {}, hooks: RuntimeHooks = {}): RuntimeManager {
  logText = '';
  const sink = new Writable({
    write(chunk, _e, done) {
      logText += String(chunk);
      done();
    },
  });
  return new RuntimeManager(backend, { ...config, ...over }, createLogger({ level: 'debug', destination: sink }), hooks, (event) =>
    events.push(event),
  );
}
const states = () => events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  events = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cold start and warm reuse', () => {
  it('starts a runtime on the first lease with the documented container spec', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    expect(lease.coldStart).toBe(true);
    expect(lease.handle).toMatchObject({ platform: 'linkedin', name: 'jw-linkedin' });
    const spec = backend.containers.get('jw-linkedin')?.spec;
    expect(spec).toMatchObject({
      image: 'jobwatch-browser:test',
      memoryMb: 1500,
      memoryReservationMb: 1200,
      profileVolume: 'jw-profile-linkedin',
      network: 'jobwatch-browsers',
    });
    expect(states()).toEqual(['starting', 'busy']);
    await lease.release();
  });

  it('reuses the warm runtime of the same platform without starting another', async () => {
    const manager = make();
    const first = await manager.lease('linkedin');
    await first.release();
    await advance(60_000);
    const second = await manager.lease('linkedin');
    expect(second.coldStart).toBe(false);
    expect(second.handle.name).toBe(first.handle.name);
    expect(backend.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
    await second.release();
  });

  it('reports the cold start in an event', async () => {
    const manager = make();
    backend.startDelayMs = 2500;
    const pending = manager.lease('linkedin');
    await advance(2500);
    await (await pending).release();
    expect(events.find((e) => e.type === 'cold_start')).toMatchObject({ platform: 'linkedin', ms: 2500 });
  });

  it('per-tool memory budgets override the default cap', async () => {
    const manager = make();
    await (await manager.lease('linkedin', { memory: { highMb: 800, maxMb: 1000 } })).release();
    expect(backend.containers.get('jw-linkedin')?.spec).toMatchObject({ memoryMb: 1000, memoryReservationMb: 800 });
  });
});

describe('idle timer and reaping', () => {
  it('stops the runtime after the idle TTL and goes cold', async () => {
    const manager = make();
    await (await manager.lease('linkedin')).release();
    expect(manager.status().current).toMatchObject({ platform: 'linkedin', state: 'idle_grace' });
    await advance(119_000);
    expect(backend.running).toEqual(['jw-linkedin']);
    await advance(2000);
    expect(backend.running).toEqual([]);
    expect(manager.status().current).toBeUndefined();
    expect(states()).toEqual(['starting', 'busy', 'idle_grace', 'stopping', 'cold']);
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'idle' });
  });

  it('a new lease cancels the idle timer, and the timer restarts from the end of that lease', async () => {
    const manager = make();
    await (await manager.lease('linkedin')).release();
    await advance(100_000);
    const lease = await manager.lease('linkedin');
    await advance(200_000); // far past the first deadline, but we hold the lease
    expect(backend.running).toEqual(['jw-linkedin']);
    await lease.release();
    await advance(119_000);
    expect(backend.running).toEqual(['jw-linkedin']);
    await advance(2000);
    expect(backend.running).toEqual([]);
  });

  it('a lease arriving while the idle stop is under way waits for it and starts a fresh runtime', async () => {
    const manager = make();
    backend.stopDelayMs = 3000;
    await (await manager.lease('linkedin')).release();
    await advance(120_000); // idle stop begins, takes 3 s
    expect(manager.status().current?.state).toBe('stopping');
    const pending = manager.lease('linkedin');
    await advance(3000);
    const lease = await pending;
    expect(lease.coldStart).toBe(true);
    expect(backend.running).toEqual(['jw-linkedin']);
    expect(backend.calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
    await lease.release();
  });

  it('never leaves a container behind after the idle stop (no managed container remains)', async () => {
    const manager = make();
    await (await manager.lease('linkedin')).release();
    await advance(130_000);
    expect(await backend.listManaged()).toEqual([]);
  });
});

describe('one browser at a time: queue and preemption', () => {
  it('a second lease waits FIFO until the first is released', async () => {
    const manager = make();
    const first = await manager.lease('linkedin');
    const order: string[] = [];
    const a = manager.lease('linkedin').then((l) => (order.push('a'), l));
    const b = manager.lease('linkedin').then((l) => (order.push('b'), l));
    await advance(1000);
    expect(order).toEqual([]);
    expect(manager.status().waiting).toBe(2);
    await first.release();
    const leaseA = await a;
    expect(order).toEqual(['a']);
    await leaseA.release();
    await (await b).release();
    expect(order).toEqual(['a', 'b']);
  });

  it('gives busy with retry_after_s when the queue wait runs out', async () => {
    const manager = make();
    const held = await manager.lease('linkedin');
    const waiting = manager.lease('linkedin');
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'busy', retryAfterS: 60 });
    await advance(60_001);
    await assertion;
    await held.release();
  });

  it('stops an idle runtime of another platform at once (preemption) instead of waiting for its TTL', async () => {
    const manager = make();
    await (await manager.lease('linkedin')).release();
    const apec = await manager.lease('apec');
    expect(backend.running).toEqual(['jw-apec']);
    expect(backend.calls).toContain('stop:linkedin:10');
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'preempt' });
    await apec.release();
  });

  it('never has two browsers running at the same time, however calls interleave', async () => {
    const manager = make();
    let maxRunning = 0;
    const watch = setInterval(() => (maxRunning = Math.max(maxRunning, backend.running.length)), 1);
    backend.startDelayMs = 5;
    backend.stopDelayMs = 5;
    const work = ['linkedin', 'apec', 'wttj', 'linkedin', 'apec'].map(async (platform) => {
      const lease = await manager.lease(platform);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await lease.release();
    });
    await advance(2000);
    await Promise.all(work);
    clearInterval(watch);
    expect(maxRunning).toBeLessThanOrEqual(1);
    expect(backend.calls.filter((c) => c.startsWith('start')).length).toBeGreaterThanOrEqual(4);
  });

  it('release is idempotent and cannot free the slot twice', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    await lease.release();
    await lease.release();
    const next = await manager.lease('linkedin');
    let third = false;
    void manager.lease('linkedin').then((l) => ((third = true), l.release()));
    await advance(100);
    expect(third).toBe(false);
    await next.release();
  });
});

describe('recycling', () => {
  it('recycles a runtime older than the max lifetime at the next lease, never mid-call', async () => {
    const manager = make({ maxLifetimeS: 600, idleTtlS: 3600 });
    const lease = await manager.lease('linkedin');
    await advance(700_000);
    expect(backend.running).toEqual(['jw-linkedin']); // still held: not recycled mid-call
    await lease.release();
    const next = await manager.lease('linkedin');
    expect(next.coldStart).toBe(true);
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'max_lifetime' });
    await next.release();
  });

  it('replaces a container that died while idle', async () => {
    const manager = make({ idleTtlS: 3600, watchdogIntervalMs: 3_600_000 });
    await (await manager.lease('linkedin')).release();
    backend.die('jw-linkedin');
    const next = await manager.lease('linkedin');
    expect(next.coldStart).toBe(true);
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'stale' });
    await next.release();
  });
});

describe('start failures', () => {
  it('retries once and then succeeds', async () => {
    const manager = make();
    backend.startFailures = 1;
    const lease = await manager.lease('linkedin');
    expect(lease.coldStart).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
    expect(logText).toContain('runtime_start_failed');
    await lease.release();
  });

  it('gives up after the retry with a client-safe error, cleans up, and frees the slot', async () => {
    const manager = make();
    backend.startFailures = 2;
    await expect(manager.lease('linkedin')).rejects.toMatchObject({
      code: 'internal',
      message: 'The linkedin browser could not be started.',
    });
    expect(backend.calls.filter((c) => c.startsWith('remove:jw-linkedin')).length).toBeGreaterThanOrEqual(2);
    expect(manager.status().current).toBeUndefined();
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'start_failed' });
    const lease = await manager.lease('linkedin'); // the slot is free and the next attempt works
    await lease.release();
  });

  it('the error never contains docker output', async () => {
    const manager = make();
    backend.startFailures = 2;
    const error = await manager.lease('linkedin').catch((e: unknown) => e);
    expect((error as JobwatchError).message).not.toContain('docker');
  });

  it('times out a start that hangs, removes the container and retries', async () => {
    const manager = make({ startTimeoutS: 10 });
    backend.startDelayMs = 60_000;
    const pending = manager.lease('linkedin');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'internal' });
    await advance(10_001);
    backend.startDelayMs = 60_000;
    await advance(10_001);
    await assertion;
    expect(logText).toContain('start timed out after 10 s');
  });

  it('a failing ready hook (DevTools never answered) fails the start and removes the container', async () => {
    const ready = vi.fn().mockRejectedValue(new Error('DevTools not reachable'));
    const manager = make({}, { ready });
    await expect(manager.lease('linkedin')).rejects.toMatchObject({ code: 'internal' });
    expect(ready).toHaveBeenCalledTimes(2);
    expect(backend.containers.size).toBe(0);
  });

  it('the ready hook receives the handle with the address', async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const manager = make({}, { ready });
    const lease = await manager.lease('linkedin');
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ platform: 'linkedin', address: expect.stringMatching(/^172\.18\.0\./) }));
    await lease.release();
  });
});

describe('watchdog', () => {
  it('stays quiet below the warn mark and records the peak', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    backend.memory.set('jw-linkedin', 600 * MB);
    await advance(5000);
    backend.memory.set('jw-linkedin', 900 * MB);
    await advance(5000);
    backend.memory.set('jw-linkedin', 400 * MB);
    await advance(5000);
    expect(lease.peakBytes()).toBe(900 * MB);
    expect(events.filter((e) => e.type === 'memory').every((e) => (e as { level: string }).level === 'ok')).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    await lease.release();
  });

  it('at 70% asks the browser layer to shed memory, but not more than every 30 s', async () => {
    const onWarn = vi.fn().mockResolvedValue(undefined);
    const manager = make({}, { onWarn });
    const lease = await manager.lease('linkedin');
    backend.memory.set('jw-linkedin', 1100 * MB); // 73% of 1500
    await advance(5000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(onWarn).toHaveBeenCalledTimes(2);
    expect(lease.signal.aborted).toBe(false);
    expect(logText).toContain('mem_warn');
    await lease.release();
  });

  it('a throwing warn hook never harms the runtime', async () => {
    const manager = make({}, { onWarn: vi.fn().mockRejectedValue(new Error('cdp gone')) });
    const lease = await manager.lease('linkedin');
    backend.memory.set('jw-linkedin', 1100 * MB);
    await advance(5000);
    expect(lease.signal.aborted).toBe(false);
    expect(logText).toContain('mem_warn_hook_failed');
    await lease.release();
  });

  it('at 90% aborts the lease with budget_exceeded and stops the runtime', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    backend.memory.set('jw-linkedin', 1400 * MB); // 93%
    await advance(5000);
    expect(lease.signal.aborted).toBe(true);
    expect((lease.signal.reason as JobwatchError).code).toBe('budget_exceeded');
    expect(backend.running).toEqual([]);
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'critical' });
    await lease.release();
    expect((await manager.lease('linkedin')).coldStart).toBe(true); // recovers: next call starts fresh
  });

  it('thresholds follow the per-lease cap, not the default', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin', { memory: { highMb: 800, maxMb: 1000 } });
    backend.memory.set('jw-linkedin', 950 * MB); // 95% of 1000, only 63% of 1500
    await advance(5000);
    expect((lease.signal.reason as JobwatchError).code).toBe('budget_exceeded');
    await lease.release();
  });

  it('reports a container killed by the kernel as oom_killed', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    backend.die('jw-linkedin', true);
    await advance(5000);
    expect((lease.signal.reason as JobwatchError).code).toBe('oom_killed');
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'died' });
    await lease.release();
  });

  it('reports any other unexpected exit as internal, with the platform', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    backend.die('jw-linkedin', false);
    await advance(5000);
    expect(lease.signal.reason).toMatchObject({ code: 'internal', details: { platform: 'linkedin' } });
    await lease.release();
  });

  it('keeps going when a reading fails', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    backend.failMemory = true;
    await advance(10_000);
    expect(lease.signal.aborted).toBe(false);
    expect(logText).toContain('watchdog_read_failed');
    backend.failMemory = false;
    backend.memory.set('jw-linkedin', 1450 * MB);
    await advance(5000);
    expect(lease.signal.aborted).toBe(true);
    await lease.release();
  });

  it('keeps watching an idle runtime and stops it if it balloons or dies', async () => {
    const manager = make({ idleTtlS: 3600 });
    await (await manager.lease('linkedin')).release();
    backend.die('jw-linkedin');
    await advance(5000);
    expect(manager.status().current).toBeUndefined();
    expect(events).toContainEqual({ type: 'stopped', platform: 'linkedin', reason: 'died' });
  });

  it('stops polling once the runtime is gone (no leaked timers)', async () => {
    const manager = make();
    await (await manager.lease('linkedin')).release();
    await advance(130_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stopping cleanly', () => {
  it('asks the application to quit first, then signals the container, in that order', async () => {
    const order: string[] = [];
    const quit = vi.fn(async () => void order.push('quit'));
    const manager = make({}, { quit });
    const original = backend.stop.bind(backend);
    backend.stop = async (handle, grace) => (order.push('docker-stop'), original(handle, grace));
    await (await manager.lease('linkedin')).release();
    await advance(121_000);
    expect(order).toEqual(['quit', 'docker-stop']);
  });

  it('does not wait forever for a quit hook that hangs, and a failing one is ignored', async () => {
    const hang = make({}, { quit: () => new Promise(() => undefined) });
    await (await hang.lease('linkedin')).release();
    await advance(120_000 + 10_000 + 100);
    expect(backend.running).toEqual([]);
    backend = new FakeBackend();
    const broken = make({}, { quit: () => Promise.reject(new Error('cdp closed')) });
    await (await broken.lease('apec')).release();
    await advance(121_000);
    expect(backend.running).toEqual([]);
  });

  it('removes the container by force when docker stop fails', async () => {
    const manager = make();
    backend.stop = async () => {
      throw new Error('docker stop failed');
    };
    await (await manager.lease('linkedin')).release();
    await advance(121_000);
    expect(backend.calls).toContain('remove:jw-linkedin');
    expect(manager.status().current).toBeUndefined();
    expect(logText).toContain('runtime_stop_failed');
  });

  it('passes the grace period to docker stop', async () => {
    const manager = make({ stopGraceS: 7 });
    await (await manager.lease('linkedin')).release();
    await advance(121_000);
    expect(backend.calls).toContain('stop:linkedin:7');
  });
});

describe('shutdown and orphans', () => {
  it('shutdown aborts the active lease, stops the runtime and refuses new leases', async () => {
    const manager = make();
    const lease = await manager.lease('linkedin');
    await manager.shutdown();
    expect(lease.signal.aborted).toBe(true);
    expect(backend.running).toEqual([]);
    await expect(manager.lease('linkedin')).rejects.toMatchObject({ code: 'internal' });
    await lease.release();
  });

  it('shutdown with nothing running is a no-op, and can be repeated', async () => {
    const manager = make();
    await manager.shutdown();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it('removes containers left by a previous router and keeps the current one', async () => {
    backend.containers.set('jw-linkedin', { spec: {} as never, running: true, oomKilled: false });
    backend.containers.set('jw-apec', { spec: {} as never, running: false, oomKilled: false });
    const manager = make();
    expect((await manager.reapOrphans()).sort()).toEqual(['jw-apec', 'jw-linkedin']);
    expect(backend.containers.size).toBe(0);
    const lease = await manager.lease('wttj');
    expect(await manager.reapOrphans()).toEqual([]);
    expect(backend.running).toEqual(['jw-wttj']);
    await lease.release();
    expect(logText).toContain('orphans_reaped');
  });
});

describe('events', () => {
  it('a listener that throws never breaks the manager', async () => {
    logText = '';
    const manager = new RuntimeManager(backend, config, createLogger({ level: 'silent' }), {}, () => {
      throw new Error('listener bug');
    });
    await (await manager.lease('linkedin')).release();
    expect(backend.running).toEqual(['jw-linkedin']);
  });

  it('reports how long a lease waited in the queue', async () => {
    const manager = make();
    const first = await manager.lease('linkedin');
    const second = manager.lease('linkedin');
    await advance(4000);
    await first.release();
    await (await second).release();
    const waits = events.filter((e) => e.type === 'queue_wait').map((e) => (e as { ms: number }).ms);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(4000);
  });
});
