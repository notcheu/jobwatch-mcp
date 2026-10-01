import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALL_LOG_RETENTION_MS, SCHEMA_VERSION, Store, StoreError, USAGE_RETENTION_MS, type CallRecord } from './store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  ts: 1000,
  requestId: 'r1',
  tool: 'apec_search',
  adapter: 'apec',
  platform: 'apec',
  outcome: 'ok',
  durationMs: 120,
  argsHash: 'abc123abc123',
  ...over,
});

describe('opening', () => {
  it('creates the file with its parent directories, mode 0600, WAL, and the current schema', async () => {
    const path = join(dir, 'nested', 'deeper', 'jobwatch.sqlite');
    const store = Store.open(path);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    store.close();
    const check = new DatabaseSync(path);
    expect(check.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    check.close();
  });

  it('keeps the WAL and shared-memory side files owner-only too, not just the main file', async () => {
    const path = join(dir, 'private.sqlite');
    const store = Store.open(path);
    store.recordCall(call());
    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect((await stat(file)).mode & 0o777, file).toBe(0o600);
    store.close();
  });

  it('tightens an existing database file that was created with looser permissions', async () => {
    const path = join(dir, 'loose.sqlite');
    Store.open(path).close();
    await (await import('node:fs/promises')).chmod(path, 0o644);
    Store.open(path).close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('works in memory', () => {
    const store = Store.open(':memory:');
    expect(store.countCalls()).toBe(0);
    store.close();
  });

  it('reopens an existing database without losing anything or migrating twice', () => {
    const path = join(dir, 'a.sqlite');
    const first = Store.open(path);
    first.recordCall(call());
    first.putBreaker({ platform: 'linkedin', reason: 'checkpoint', openedAt: 5, until: 99 });
    first.close();
    const second = Store.open(path);
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    expect(second.countCalls()).toBe(1);
    expect(second.getBreaker('linkedin')).toEqual({ platform: 'linkedin', reason: 'checkpoint', openedAt: 5, until: 99 });
    second.close();
  });

  it('refuses a database written by a NEWER build (never run an old router on a new schema)', () => {
    const path = join(dir, 'new.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => Store.open(path)).toThrow(StoreError);
    expect(() => Store.open(path)).toThrow(/newer database/);
  });

  it('explains an unwritable location', () => {
    expect(() => Store.open('/proc/jobwatch/x.sqlite')).toThrow(/Is JW_DATA_DIR writable\?/);
  });

  it('refuses a file that is not a database', async () => {
    const path = join(dir, 'garbage.sqlite');
    await (await import('node:fs/promises')).writeFile(path, 'this is not sqlite at all, just text '.repeat(10));
    expect(() => Store.open(path)).toThrow(StoreError);
  });
});

describe('usage', () => {
  it('returns events of a platform newer than a time, oldest first', () => {
    const store = Store.open(':memory:');
    store.addUsage('a', 30, 2);
    store.addUsage('a', 10, 1);
    store.addUsage('b', 20, 5);
    expect(store.usageSince('a', 0)).toEqual([
      { ts: 10, cost: 1 },
      { ts: 30, cost: 2 },
    ]);
    expect(store.usageSince('a', 10)).toEqual([{ ts: 30, cost: 2 }]);
    expect(store.usageSince('nobody', 0)).toEqual([]);
  });

  it('refuses a non-positive cost at the database level', () => {
    expect(() => Store.open(':memory:').addUsage('a', 1, 0)).toThrow();
    expect(() => Store.open(':memory:').addUsage('a', 1, -3)).toThrow();
  });
});

describe('transactions', () => {
  it('commits all or nothing', () => {
    const store = Store.open(':memory:');
    expect(() =>
      store.transaction(() => {
        store.addUsage('a', 1, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.usageSince('a', 0)).toEqual([]);
    expect(store.transaction(() => (store.addUsage('a', 2, 1), 'done'))).toBe('done');
    expect(store.usageSince('a', 0)).toHaveLength(1);
  });
});

describe('breaker rows', () => {
  it('inserts, replaces, lists in order and deletes', () => {
    const store = Store.open(':memory:');
    store.putBreaker({ platform: 'b', reason: 'needs_login', openedAt: 1, until: null });
    store.putBreaker({ platform: 'a', reason: 'checkpoint', openedAt: 2, until: 50 });
    store.putBreaker({ platform: 'b', reason: 'checkpoint', openedAt: 3, until: 60 });
    expect(store.listBreakers().map((row) => [row.platform, row.reason, row.until])).toEqual([
      ['a', 'checkpoint', 50],
      ['b', 'checkpoint', 60],
    ]);
    expect(store.deleteBreaker('a')).toBe(true);
    expect(store.deleteBreaker('a')).toBe(false);
    expect(store.getBreaker('a')).toBeUndefined();
  });

  it('rejects a reason outside the known two', () => {
    const store = Store.open(':memory:');
    expect(() => store.putBreaker({ platform: 'a', reason: 'whatever' as never, openedAt: 1, until: null })).toThrow();
  });
});

describe('call log', () => {
  it('records and returns the most recent first, capped', () => {
    const store = Store.open(':memory:');
    for (let i = 0; i < 5; i += 1) store.recordCall(call({ requestId: `r${i}`, ts: i }));
    expect(store.recentCalls(2).map((c) => c.requestId)).toEqual(['r4', 'r3']);
    expect(store.recentCalls(0)).toHaveLength(1);
    expect(store.recentCalls(10_000)).toHaveLength(5);
    expect(store.recentCalls(1)[0]).toEqual(call({ requestId: 'r4', ts: 4 }));
  });

  it('stores no arguments, only a hash: the schema has no column that could hold them', () => {
    const path = join(dir, 'schema.sqlite');
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    const columns = (raw.prepare('PRAGMA table_info(call_log)').all() as { name: string }[]).map((c) => c.name);
    raw.close();
    expect(columns).toEqual(['id', 'ts', 'request_id', 'tool', 'adapter', 'platform', 'outcome', 'duration_ms', 'args_hash']);
  });

  it('prunes by retention and reports what it removed', () => {
    const store = Store.open(':memory:');
    const now = 100 * 24 * 3600 * 1000;
    store.recordCall(call({ ts: now - CALL_LOG_RETENTION_MS - 1, requestId: 'old' }));
    store.recordCall(call({ ts: now - CALL_LOG_RETENTION_MS + 1000, requestId: 'kept' }));
    store.addUsage('a', now - USAGE_RETENTION_MS - 1, 1);
    store.addUsage('a', now - 1000, 1);
    expect(store.prune(now)).toEqual({ calls: 1, usage: 1 });
    expect(store.recentCalls(10).map((c) => c.requestId)).toEqual(['kept']);
    expect(store.usageSince('a', 0)).toHaveLength(1);
  });
});

describe('closing', () => {
  it('can be closed twice without error, and refuses use afterwards', () => {
    const store = Store.open(':memory:');
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.countCalls()).toThrow();
  });
});

describe('SQL injection through values', () => {
  it('treats hostile strings as data', () => {
    const store = Store.open(':memory:');
    const evil = "x'); DROP TABLE call_log; --";
    store.recordCall(call({ tool: evil, requestId: evil }));
    store.putBreaker({ platform: evil, reason: 'needs_login', openedAt: 1, until: null });
    expect(store.recentCalls(1)[0]?.tool).toBe(evil);
    expect(store.getBreaker(evil)?.platform).toBe(evil);
    expect(store.countCalls()).toBe(1);
  });
});
