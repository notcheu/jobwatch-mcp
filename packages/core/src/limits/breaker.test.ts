import { Checkpoint, SessionInvalid } from '@jobwatch/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, type BreakerRow } from '../store/store';
import { CHECKPOINT_TTL_S, CircuitBreaker } from './breaker';

let now: number;
let store: Store;
let changes: [string, BreakerRow | undefined][];
const make = () =>
  new CircuitBreaker(
    store,
    () => now,
    (platform, row) => changes.push([platform, row]),
  );

beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  store = Store.open(':memory:');
  changes = [];
});

describe('closed by default', () => {
  it('lets calls through and lists nothing', () => {
    const breaker = make();
    expect(() => breaker.check('linkedin')).not.toThrow();
    expect(breaker.all()).toEqual([]);
    expect(breaker.state('linkedin')).toBeUndefined();
  });
});

describe('needs_login', () => {
  it('stays open until closed, however long it takes', () => {
    const breaker = make();
    breaker.open('linkedin', 'needs_login');
    now += 365 * 24 * 3600 * 1000;
    expect(() => breaker.check('linkedin')).toThrow(SessionInvalid);
    expect(breaker.close('linkedin')).toBe(true);
    expect(() => breaker.check('linkedin')).not.toThrow();
  });

  it('refuses with the needs_login code, naming the platform but no retry time', () => {
    const breaker = make();
    breaker.open('linkedin', 'needs_login');
    try {
      breaker.check('linkedin');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'needs_login', retryAfterS: null, details: { platform: 'linkedin' } });
    }
  });
});

describe('checkpoint', () => {
  it('blocks for the time-to-live and then closes by itself', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint');
    now += (CHECKPOINT_TTL_S - 1) * 1000;
    expect(() => breaker.check('linkedin')).toThrow(Checkpoint);
    now += 1000;
    expect(() => breaker.check('linkedin')).not.toThrow();
    expect(breaker.state('linkedin')).toBeUndefined();
  });

  it('tells how long to wait, shrinking as time passes', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint', 7200);
    expect(() => breaker.check('linkedin')).toThrow(expect.objectContaining({ code: 'checkpoint', retryAfterS: 7200 }));
    now += 3600 * 1000;
    expect(() => breaker.check('linkedin')).toThrow(expect.objectContaining({ retryAfterS: 3600 }));
  });

  it('defaults to six hours', () => {
    expect(CHECKPOINT_TTL_S).toBe(6 * 3600);
    expect(make().open('linkedin', 'checkpoint').until).toBe(now + 6 * 3600 * 1000);
  });
});

describe('severity', () => {
  it('never downgrades a checkpoint to needs_login', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint');
    const kept = breaker.open('linkedin', 'needs_login');
    expect(kept.reason).toBe('checkpoint');
    expect(breaker.state('linkedin')?.reason).toBe('checkpoint');
  });

  it('upgrades needs_login to checkpoint', () => {
    const breaker = make();
    breaker.open('linkedin', 'needs_login');
    breaker.open('linkedin', 'checkpoint');
    expect(breaker.state('linkedin')).toMatchObject({ reason: 'checkpoint' });
  });

  it('lets a lapsed checkpoint be replaced by a fresh needs_login', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint', 60);
    now += 61 * 1000;
    expect(breaker.open('linkedin', 'needs_login').reason).toBe('needs_login');
  });
});

describe('isolation and persistence', () => {
  it('opens one platform without touching the others', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint');
    expect(() => breaker.check('apec')).not.toThrow();
    expect(breaker.all().map((row) => row.platform)).toEqual(['linkedin']);
  });

  it('survives a router restart: a checkpoint is not forgotten', () => {
    make().open('linkedin', 'checkpoint');
    const afterRestart = make();
    expect(() => afterRestart.check('linkedin')).toThrow(Checkpoint);
  });

  it('cleans expired breakers out of the list', () => {
    const breaker = make();
    breaker.open('a', 'checkpoint', 10);
    breaker.open('b', 'needs_login');
    now += 11 * 1000;
    expect(breaker.all().map((row) => row.platform)).toEqual(['b']);
  });
});

describe('change notifications (feed the metrics gauge)', () => {
  it('reports open, close and expiry', () => {
    const breaker = make();
    breaker.open('linkedin', 'checkpoint', 10);
    breaker.close('linkedin');
    breaker.open('apec', 'checkpoint', 10);
    now += 11 * 1000;
    breaker.state('apec');
    expect(changes.map(([platform, row]) => [platform, row?.reason])).toEqual([
      ['linkedin', 'checkpoint'],
      ['linkedin', undefined],
      ['apec', 'checkpoint'],
      ['apec', undefined],
    ]);
  });

  it('does not notify when closing something that was not open', () => {
    const breaker = make();
    expect(breaker.close('nothing')).toBe(false);
    expect(changes).toEqual([]);
  });

  it('works without a listener', () => {
    const quiet = new CircuitBreaker(store, () => now);
    expect(() => {
      quiet.open('p', 'needs_login');
      quiet.close('p');
    }).not.toThrow();
    expect(vi.isMockFunction(quiet.open)).toBe(false);
  });
});
