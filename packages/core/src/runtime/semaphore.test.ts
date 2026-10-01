import { JobwatchError } from '@jobwatch/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Semaphore } from './semaphore';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Semaphore', () => {
  it('grants immediately while capacity is free', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire(1000, 5);
    expect(sem.waiting).toBe(0);
    release();
  });

  it('serves waiters strictly first-in first-out', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const first = await sem.acquire(10_000, 5);
    const a = sem.acquire(10_000, 5).then((r) => (order.push('a'), r));
    const b = sem.acquire(10_000, 5).then((r) => (order.push('b'), r));
    const c = sem.acquire(10_000, 5).then((r) => (order.push('c'), r));
    expect(sem.waiting).toBe(3);
    first();
    (await a)();
    (await b)();
    (await c)();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a late arrival cannot jump the queue when capacity frees up', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire(10_000, 5);
    const queued = sem.acquire(10_000, 5);
    first();
    const late = sem.acquire(10_000, 5); // arrives after the slot was handed to `queued`
    const release = await queued;
    let lateGranted = false;
    void late.then(() => (lateGranted = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateGranted).toBe(false);
    release();
    (await late)();
  });

  it('gives busy with a retry time when the queue wait runs out, and leaves the queue', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire(10_000, 5);
    const waiting = sem.acquire(60_000, 60);
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'busy', retryAfterS: 60 });
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
    expect(sem.waiting).toBe(0);
    held();
    (await sem.acquire(1000, 5))(); // the abandoned waiter did not eat the slot
  });

  it('is a JobwatchError', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(1000, 1);
    const waiting = sem.acquire(10, 1);
    const assertion = expect(waiting).rejects.toBeInstanceOf(JobwatchError);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it('release is idempotent: a second call does not grant extra capacity', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire(1000, 1);
    release();
    release();
    const one = await sem.acquire(1000, 1);
    let second = false;
    void sem.acquire(10_000, 1).then(() => (second = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(false);
    one();
  });

  it('supports larger capacities and rejects nonsense', async () => {
    const sem = new Semaphore(2);
    const a = await sem.acquire(1000, 1);
    const b = await sem.acquire(1000, 1);
    let third = false;
    void sem.acquire(10_000, 1).then(() => (third = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBe(false);
    a();
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBe(true);
    b();
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});
