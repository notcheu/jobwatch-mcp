import { JobwatchError } from '@jobwatch/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { RateLimiter } from './ratelimit';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let now: number;
let store: Store;
const make = (perHour = 10, perDay = 25) =>
  new RateLimiter(
    store,
    () => now,
    () => ({ perHour, perDay }),
  );
const rateLimited = (work: () => void): JobwatchError => {
  try {
    work();
  } catch (error) {
    if (error instanceof JobwatchError) return error;
    throw error;
  }
  throw new Error('expected a rate_limited error');
};

beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  store = Store.open(':memory:');
});

describe('hourly window', () => {
  it('allows calls up to the budget and refuses the next one', () => {
    const limiter = make(10, 100);
    for (let i = 0; i < 4; i += 1) limiter.take('p', 2);
    limiter.take('p', 2);
    const error = rateLimited(() => limiter.take('p', 1));
    expect(error.code).toBe('rate_limited');
    expect(error.details).toEqual({ platform: 'p', window: 'hour', limit: 10 });
  });

  it('tells how long until the call fits: when enough of the oldest events leave the window', () => {
    const limiter = make(10, 100);
    limiter.take('p', 4); // t0
    now += 10 * MIN;
    limiter.take('p', 4); // t0 + 10 min
    now += 10 * MIN;
    limiter.take('p', 2); // t0 + 20 min, budget full (10/10)
    now += 10 * MIN; // t0 + 30 min
    // A call of 3 needs the first event (4 points, from t0) to expire: at t0 + 60 min, i.e. in 30 minutes.
    expect(rateLimited(() => limiter.take('p', 3)).retryAfterS).toBe(30 * 60);
    // A call of 6 needs the first two events to expire: at t0 + 70 min, i.e. in 40 minutes.
    expect(rateLimited(() => limiter.take('p', 6)).retryAfterS).toBe(40 * 60);
  });

  it('accepts the call exactly when the retry time has passed, not one second before', () => {
    const limiter = make(5, 100);
    limiter.take('p', 5);
    const wait = rateLimited(() => limiter.take('p', 1)).retryAfterS ?? 0;
    expect(wait).toBe(3600);
    now += (wait - 1) * 1000;
    expect(() => limiter.take('p', 1)).toThrow(JobwatchError);
    now += 1000;
    expect(() => limiter.take('p', 1)).not.toThrow();
  });

  it('never rounds the wait down to zero', () => {
    const limiter = make(1, 100);
    limiter.take('p', 1);
    now += 3600 * 1000 - 100; // 100 ms before the event leaves the window
    expect(rateLimited(() => limiter.take('p', 1)).retryAfterS).toBe(1);
  });
});

describe('daily window', () => {
  it('blocks on the day budget even when the hour is free, and reports the day window', () => {
    const limiter = make(10, 12);
    for (let hour = 0; hour < 2; hour += 1) {
      limiter.take('p', 5);
      now += HOUR + 1;
    }
    const error = rateLimited(() => limiter.take('p', 5));
    expect(error.details).toMatchObject({ window: 'day', limit: 12 });
  });

  it('frees up 24 hours after the usage', () => {
    const limiter = make(10, 10);
    limiter.take('p', 10);
    now += 12 * HOUR;
    const error = rateLimited(() => limiter.take('p', 1));
    expect(error.retryAfterS).toBe(12 * 3600);
    now += 12 * HOUR;
    expect(() => limiter.take('p', 10)).not.toThrow();
  });

  it('reports the longer of two waits when both windows block', () => {
    const limiter = make(5, 5);
    limiter.take('p', 5);
    now += 30 * MIN;
    const error = rateLimited(() => limiter.take('p', 1));
    expect(error.retryAfterS).toBe(23.5 * 3600);
    expect(error.details).toMatchObject({ window: 'day' });
  });
});

describe('cost, platforms and persistence', () => {
  it('refuses a single call that can never fit, without a misleading retry time', () => {
    const error = rateLimited(() => make(5, 10).take('p', 6));
    expect(error.retryAfterS).toBeNull();
    expect(error.message).toContain('costs more');
  });

  it('counts each platform separately', () => {
    const limiter = make(3, 10);
    limiter.take('a', 3);
    expect(() => limiter.take('b', 3)).not.toThrow();
    expect(() => limiter.take('a', 1)).toThrow(JobwatchError);
  });

  it('uses the policy of the platform asked about', () => {
    const limiter = new RateLimiter(
      store,
      () => now,
      (platform) => (platform === 'strict' ? { perHour: 1, perDay: 1 } : { perHour: 100, perDay: 100 }),
    );
    limiter.take('strict', 1);
    expect(() => limiter.take('strict', 1)).toThrow(JobwatchError);
    expect(() => limiter.take('loose', 50)).not.toThrow();
  });

  it('does not spend budget on a refused call', () => {
    const limiter = make(5, 100);
    limiter.take('p', 4);
    expect(() => limiter.take('p', 2)).toThrow(JobwatchError);
    expect(limiter.status('p').hour.used).toBe(4);
    expect(() => limiter.take('p', 1)).not.toThrow();
  });

  it('survives a restart: the budget lives in the database, not in memory', () => {
    make(5, 100).take('p', 5);
    const afterRestart = make(5, 100); // a new limiter on the same store
    expect(() => afterRestart.take('p', 1)).toThrow(JobwatchError);
  });

  it('reports usage per window', () => {
    const limiter = make(10, 100);
    limiter.take('p', 3);
    now += 2 * HOUR;
    limiter.take('p', 4);
    expect(limiter.status('p')).toEqual({ hour: { used: 4, limit: 10 }, day: { used: 7, limit: 100 } });
    expect(limiter.status('unused')).toEqual({ hour: { used: 0, limit: 10 }, day: { used: 0, limit: 100 } });
  });

  it('is exact at the window edge: an event exactly one hour old no longer counts', () => {
    const limiter = make(1, 100);
    limiter.take('p', 1);
    now += HOUR;
    expect(() => limiter.take('p', 1)).not.toThrow();
  });
});
