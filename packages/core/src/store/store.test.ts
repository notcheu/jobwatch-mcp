import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_JOB_DESCRIPTION_CHARS,
  MAX_MEMORY_ENTRIES,
  SCHEMA_VERSION,
  Store,
  StoreError,
  USAGE_RETENTION_MS,
  type CallRecord,
  type NewJobRow,
} from './store';

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

  it('explains an unusable location (a parent that is a regular file, portable: /proc makes recursive mkdir spin on Linux)', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    expect(() => Store.open(join(blocker, 'sub', 'x.sqlite'))).toThrow(/Is DATA_DIR writable\?/);
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

  it('keeps the arguments of a call in one column only, `detail`, next to the hash: nowhere else holds them', () => {
    const path = join(dir, 'schema.sqlite');
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    const columns = (raw.prepare('PRAGMA table_info(call_log)').all() as { name: string }[]).map((c) => c.name);
    raw.close();
    expect(columns).toEqual(['id', 'ts', 'request_id', 'tool', 'adapter', 'platform', 'outcome', 'duration_ms', 'args_hash', 'detail']);
  });

  it('prunes by retention and reports what it removed', () => {
    const store = Store.open(':memory:');
    const day = 24 * 3600 * 1000;
    const now = 100 * day;
    store.recordCall(call({ ts: now - 30 * day - 1, requestId: 'old' }));
    store.recordCall(call({ ts: now - 30 * day + 1000, requestId: 'kept' }));
    store.addUsage('a', now - USAGE_RETENTION_MS - 1, 1);
    store.addUsage('a', now - 1000, 1);
    expect(store.prune(now)).toEqual({ calls: 1, usage: 1, jobs: 0 });
    expect(store.recentCalls(10).map((c) => c.requestId)).toEqual(['kept']);
    expect(store.usageSince('a', 0)).toHaveLength(1);
  });

  describe('rotation', () => {
    const day = 24 * 3600 * 1000;
    const detail = (over: object = {}) => ({
      startedAt: 0,
      unitsReserved: 5,
      unitsSpent: 3,
      responseBytes: 2048,
      estimatedTokens: 570,
      warnings: 1,
      params: { keywords: ['react'], geo: 'france' },
      paramsTruncated: false,
      jobText: { available: 8000, returned: 700 },
      ...over,
    });

    it('keeps a call for the number of days it was told, 30 by default, and deletes its parameters with it', () => {
      const now = 100 * day;
      const week = Store.open(':memory:', { callLogRetentionDays: 7 });
      week.recordCall(call({ requestId: 'eight', ts: now - 8 * day, detail: detail() }));
      week.recordCall(call({ requestId: 'six', ts: now - 6 * day, detail: detail() }));
      expect(week.prune(now).calls).toBe(1);
      expect(week.restoreCalls(10).map((c) => c.requestId)).toEqual(['six']);
      week.close();
      const normal = Store.open(':memory:');
      normal.recordCall(call({ requestId: 'twenty-nine', ts: now - 29 * day, detail: detail() }));
      normal.recordCall(call({ requestId: 'thirty-one', ts: now - 31 * day, detail: detail() }));
      expect(normal.prune(now).calls).toBe(1);
      expect(normal.restoreCalls(10).map((c) => c.requestId)).toEqual(['twenty-nine']);
      normal.close();
    });

    it('refuses a retention that is not a whole number of days from 1 to 3650', () => {
      for (const days of [0, -1, 1.5, 4000]) expect(() => Store.open(':memory:', { callLogRetentionDays: days })).toThrow(StoreError);
    });

    it('reads the last calls back, oldest first, with what the dashboard shows of them', () => {
      const store = Store.open(':memory:');
      for (let i = 1; i <= 5; i += 1) store.recordCall(call({ requestId: `r${i}`, ts: i, detail: detail({ startedAt: i }) }));
      const back = store.restoreCalls(3);
      expect(back.map((c) => c.requestId)).toEqual(['r3', 'r4', 'r5']);
      expect(back[2]).toMatchObject({
        tool: 'apec_search',
        outcome: 'ok',
        detail: {
          startedAt: 5,
          unitsSpent: 3,
          estimatedTokens: 570,
          params: { keywords: ['react'], geo: 'france' },
          jobText: { available: 8000, returned: 700 },
        },
      });
      store.close();
    });

    it('leaves out a call that has no detail (made before it was kept, or refused before it ran) and a damaged one', () => {
      const store = Store.open(':memory:');
      store.recordCall(call({ requestId: 'no-detail', ts: 1 }));
      store.recordCall(call({ requestId: 'good', ts: 2, detail: detail() }));
      store.recordCall(call({ requestId: 'no-params', ts: 3, detail: detail({ params: null }) }));
      expect(store.restoreCalls(10).map((c) => [c.requestId, c.detail.params])).toEqual([
        ['good', { keywords: ['react'], geo: 'france' }],
        ['no-params', null],
      ]);
      store.close();
    });

    it('does not stop the start for a damaged detail', async () => {
      const path = join(dir, 'damaged.sqlite');
      const first = Store.open(path);
      first.recordCall(call({ requestId: 'good', ts: 1, detail: detail() }));
      first.close();
      const raw = new DatabaseSync(path);
      raw.exec(
        "INSERT INTO call_log (ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash, detail) VALUES (2, 'bad', 't', 'a', 'p', 'ok', 1, 'h', '{not json')",
      );
      raw.exec(
        "INSERT INTO call_log (ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash, detail) VALUES (3, 'odd', 't', 'a', 'p', 'ok', 1, 'h', '[1,2]')",
      );
      raw.close();
      const second = Store.open(path);
      expect(second.restoreCalls(10).map((c) => c.requestId)).toEqual(['good']);
      second.close();
    });
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

describe('jobs', () => {
  const job = (id: string, over: Partial<NewJobRow> = {}): NewJobRow => ({
    id,
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Paris',
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    description: 'Build APIs.',
    ...over,
  });

  it('stores a job per platform, answers known() and returns it back', () => {
    const store = Store.open(':memory:');
    store.putJob('linkedin', job('4000000001'), 1000);
    expect(store.knownJobs('linkedin', ['4000000001', '4000000002', '4000000001'])).toEqual(new Set(['4000000001']));
    expect(store.knownJobs('apec', ['4000000001']).size).toBe(0);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({
      title: 'Backend Engineer',
      description: 'Build APIs.',
      firstSeen: 1000,
      fetchedAt: 1000,
    });
    expect(store.getJob('apec', '4000000001')).toBeNull();
    store.close();
  });

  it('a second put refreshes the content and fetched_at but keeps first_seen', () => {
    const store = Store.open(':memory:');
    store.putJob('linkedin', job('4000000001'), 1000);
    store.putJob('linkedin', job('4000000001', { description: 'New text' }), 5000);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({ description: 'New text', firstSeen: 1000, fetchedAt: 5000 });
    expect(store.countJobs()).toBe(1);
    store.close();
  });

  it('caps the stored text and refuses an invalid id', () => {
    const store = Store.open(':memory:');
    store.putJob('linkedin', job('4000000001', { description: 'x'.repeat(50_000), title: 't'.repeat(900) }), 1);
    const stored = store.getJob('linkedin', '4000000001');
    expect(stored?.description).toHaveLength(MAX_JOB_DESCRIPTION_CHARS);
    expect(stored?.title).toHaveLength(300);
    for (const bad of ['', 'a b', '../x', 'x'.repeat(65)]) expect(() => store.putJob('linkedin', job(bad), 1)).toThrow(StoreError);
    store.close();
  });

  it('evicts jobs past the retention, counted from the last fetch', () => {
    const day = 24 * 3600 * 1000;
    const store = Store.open(':memory:', { jobRetentionDays: 7 });
    store.putJob('linkedin', job('4000000001'), 0);
    store.putJob('linkedin', job('4000000002'), 0);
    store.putJob('linkedin', job('4000000002', { description: 'refetched' }), 6 * day);
    expect(store.prune(8 * day).jobs).toBe(1);
    expect(store.knownJobs('linkedin', ['4000000001', '4000000002'])).toEqual(new Set(['4000000002']));
    expect(store.prune(14 * day).jobs).toBe(1);
    expect(store.countJobs()).toBe(0);
    store.close();
  });

  it('clears one platform: its jobs, searches and hits, and nothing else', () => {
    const store = Store.open(':memory:', { jobRetentionDays: 7 });
    store.putJob('ashby', job('4000000001'), 1000);
    store.putJob('ashby', job('4000000002'), 1000);
    store.putJob('lever', job('4000000001'), 1000);
    store.recordSearch(
      'ashby',
      { keywords: ['dev'], disallowed: [], found: ['4000000001', '4000000002'], returned: ['4000000001'], excluded: [] },
      1000,
    );
    store.recordSearch('lever', { keywords: ['dev'], disallowed: [], found: ['4000000001'], returned: ['4000000001'], excluded: [] }, 1000);
    store.addUsage('ashby', 1000, 1);
    expect(store.clearPlatform('ashby')).toEqual({ jobs: 2, searches: 1 });
    expect(store.countJobs('ashby')).toBe(0);
    expect(store.countJobs('lever')).toBe(1);
    expect(store.searchStats({ since: 0, until: 2000, limit: 10 }).map((row) => row.platform)).toEqual(['lever']);
    expect(store.foundBy('ashby', ['4000000001']).size).toBe(0);
    expect(store.foundBy('lever', ['4000000001']).get('4000000001')).toEqual([{ keywords: ['dev'], disallowed: [] }]);
    expect(store.usageSince('ashby', 0)).toHaveLength(1); // a budget is not job data
    expect(store.clearPlatform('ashby')).toEqual({ jobs: 0, searches: 0 });
    store.close();
  });

  it('rejects a retention that is not a sensible number of days', () => {
    for (const days of [0, -1, 1.5, 4000]) expect(() => Store.open(':memory:', { jobRetentionDays: days })).toThrow(StoreError);
  });
});

describe('jobs: last seen', () => {
  const day = 24 * 3600 * 1000;
  const job = (id: string): NewJobRow => ({ id, title: 'T', company: 'C', location: null, url: `https://x.test/${id}`, description: 'D' });

  it('touch keeps a posting alive past the retention, without touching its content or fetched_at', () => {
    const store = Store.open(':memory:', { jobRetentionDays: 7 });
    store.putJob('linkedin', job('4000000001'), 0);
    store.putJob('linkedin', job('4000000002'), 0);
    store.touchJobs('linkedin', ['4000000001', '4000000099'], 6 * day);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({ firstSeen: 0, fetchedAt: 0, lastSeen: 6 * day });
    expect(store.prune(8 * day).jobs).toBe(1);
    expect(store.knownJobs('linkedin', ['4000000001', '4000000002'])).toEqual(new Set(['4000000001']));
    expect(store.prune(14 * day).jobs).toBe(1); // last seen on day 6, so gone after day 13
    store.close();
  });

  it('touch never moves last_seen backwards and ignores other platforms', () => {
    const store = Store.open(':memory:');
    store.putJob('linkedin', job('4000000001'), 5000);
    store.touchJobs('linkedin', ['4000000001'], 1000);
    store.touchJobs('apec', ['4000000001'], 9000);
    expect(store.getJob('linkedin', '4000000001')?.lastSeen).toBe(5000);
    store.close();
  });

  it('a put counts as a sighting', () => {
    const store = Store.open(':memory:');
    store.putJob('linkedin', job('4000000001'), 100);
    store.putJob('linkedin', job('4000000001'), 900);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({ fetchedAt: 900, lastSeen: 900 });
    store.close();
  });

  it('migrates a version 2 database: last_seen starts at fetched_at', () => {
    const path = join(dir, 'v2.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, ts INTEGER NOT NULL, cost INTEGER NOT NULL CHECK (cost > 0));
      CREATE TABLE breaker (platform TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK (reason IN ('needs_login', 'checkpoint')), opened_at INTEGER NOT NULL, until_ts INTEGER);
      CREATE TABLE call_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, adapter TEXT NOT NULL, platform TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, args_hash TEXT NOT NULL);
      CREATE TABLE jobs (platform TEXT NOT NULL, id TEXT NOT NULL, first_seen INTEGER NOT NULL, fetched_at INTEGER NOT NULL, title TEXT, company TEXT, location TEXT, url TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY (platform, id)) WITHOUT ROWID;
      CREATE INDEX jobs_fetched_at ON jobs (fetched_at);
      INSERT INTO jobs VALUES ('linkedin', '4000000001', 10, 20, 'T', 'C', NULL, 'https://x.test/1', 'D');
      PRAGMA user_version = 2;`);
    old.close();
    const store = Store.open(path);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({ firstSeen: 10, fetchedAt: 20, lastSeen: 20 });
    store.close();
  });
});

describe('jobs: source and board', () => {
  const job = (id: string, board?: string | null): NewJobRow => ({
    id,
    board,
    title: 'T',
    company: 'C',
    location: null,
    url: `https://x.test/${id}`,
    description: 'D',
  });

  it('keeps the board an ATS job was found on, and null when there is none', () => {
    const store = Store.open(':memory:');
    store.putJob('teamtailor', job('a1', 'bsport'), 1);
    store.putJob('teamtailor', job('a2', 'ornikar'), 1);
    store.putJob('linkedin', job('4000000001'), 1);
    expect(store.getJob('teamtailor', 'a1')?.board).toBe('bsport');
    expect(store.getJob('linkedin', '4000000001')?.board).toBeNull();
    store.close();
  });

  it('a refresh updates the board, caps it at 120 characters, and the same id on two platforms stays apart', () => {
    const store = Store.open(':memory:');
    store.putJob('teamtailor', job('a1', 'old'), 1);
    store.putJob('teamtailor', job('a1', 'new'), 2);
    expect(store.getJob('teamtailor', 'a1')?.board).toBe('new');
    store.putJob('greenhouse', job('a1', 'x'.repeat(300)), 3);
    expect(store.getJob('greenhouse', 'a1')?.board).toHaveLength(120);
    expect(store.getJob('teamtailor', 'a1')?.board).toBe('new');
    store.close();
  });

  it('migrates a version 3 database: existing jobs get a null board', () => {
    const path = join(dir, 'v3.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, ts INTEGER NOT NULL, cost INTEGER NOT NULL CHECK (cost > 0));
      CREATE TABLE breaker (platform TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK (reason IN ('needs_login', 'checkpoint')), opened_at INTEGER NOT NULL, until_ts INTEGER);
      CREATE TABLE call_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, adapter TEXT NOT NULL, platform TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, args_hash TEXT NOT NULL);
      CREATE TABLE jobs (platform TEXT NOT NULL, id TEXT NOT NULL, first_seen INTEGER NOT NULL, fetched_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, title TEXT, company TEXT, location TEXT, url TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY (platform, id)) WITHOUT ROWID;
      CREATE INDEX jobs_last_seen ON jobs (last_seen);
      INSERT INTO jobs VALUES ('linkedin', '4000000001', 10, 20, 30, 'T', 'C', NULL, 'https://x.test/1', 'D');
      PRAGMA user_version = 3;`);
    old.close();
    const store = Store.open(path);
    expect(store.getJob('linkedin', '4000000001')).toMatchObject({ lastSeen: 30, board: null });
    store.close();
  });
});

describe('search history', () => {
  const DAY = 24 * 3600 * 1000;
  const T0 = Date.UTC(2026, 9, 5);
  const job = (id: string): NewJobRow => ({
    id,
    board: null,
    title: `Job ${id}`,
    company: 'Acme',
    location: 'Paris',
    url: `https://x/${id}`,
    description: 'd',
  });
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
    store.putJob('linkedin', job('a1'), T0);
    store.putJob('linkedin', job('a2'), T0 + DAY);
  });
  afterEach(() => store.close());

  it('counts, per keyword, the runs and the distinct jobs listed, returned and first stored in the window', () => {
    store.recordSearch(
      'linkedin',
      { keywords: ['React Engineer'], disallowed: [], found: ['a1', 'a2', 'a3'], returned: ['a1', 'a2'], excluded: [] },
      T0,
    );
    store.recordSearch(
      'linkedin',
      { keywords: ['react engineer'], disallowed: [], found: ['a1', 'a4'], returned: ['a1'], excluded: [] },
      T0 + DAY,
    );
    store.recordSearch('linkedin', { keywords: ['vue'], disallowed: [], found: ['a9'], returned: [], excluded: [] }, T0 + DAY);
    const stats = store.searchStats({ since: T0, until: T0 + 3 * DAY, limit: 10 });
    expect(stats).toEqual([
      {
        platform: 'linkedin',
        keywords: ['react engineer'],
        disallowed: [],
        runs: 2,
        firstRun: T0,
        lastRun: T0 + DAY,
        jobsFound: 4,
        jobsReturned: 2,
        jobsExcluded: 0,
        jobsNew: 2,
      },
      {
        platform: 'linkedin',
        keywords: ['vue'],
        disallowed: [],
        runs: 1,
        firstRun: T0 + DAY,
        lastRun: T0 + DAY,
        jobsFound: 1,
        jobsReturned: 0,
        jobsExcluded: 0,
        jobsNew: 0,
      },
    ]);
  });

  it('leaves runs outside the window and other platforms out, and a new job is one first stored inside the window', () => {
    store.recordSearch('linkedin', { keywords: ['x'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0 - DAY);
    store.recordSearch('apec', { keywords: ['x'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0);
    expect(store.searchStats({ since: T0, until: T0 + DAY, limit: 10 }).map((s) => s.platform)).toEqual(['apec']);
    expect(store.searchStats({ since: T0, until: T0 + DAY, platform: 'linkedin', limit: 10 })).toEqual([]);
    store.recordSearch('linkedin', { keywords: ['x'], disallowed: [], found: ['a2'], returned: ['a2'], excluded: [] }, T0 + 2 * DAY);
    expect(store.searchStats({ since: T0 + 2 * DAY, until: T0 + 3 * DAY, limit: 10 })[0]?.jobsNew).toBe(0); // a2 was first stored a day earlier
  });

  it('keeps at most 1000 ids per run, the returned ones first', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `j${i}`);
    store.recordSearch('teamtailor', { keywords: [], disallowed: [], found: ids, returned: ['j1400'], excluded: [] }, T0);
    const [stat] = store.searchStats({ since: T0, until: T0 + DAY, limit: 5 });
    expect(stat).toMatchObject({ runs: 1, jobsFound: 1000, jobsReturned: 1 });
    expect(store.foundBy('teamtailor', ['j1400'])).toEqual(new Map([['j1400', [{ keywords: [], disallowed: [] }]]])); // a search without keywords is a search too
  });

  it('says which keywords listed a job, and lists the jobs of a keyword', () => {
    store.recordSearch('linkedin', { keywords: ['react'], disallowed: [], found: ['a1', 'a2'], returned: ['a1'], excluded: [] }, T0);
    store.recordSearch('linkedin', { keywords: ['REACT'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0 + DAY);
    store.recordSearch('linkedin', { keywords: ['vue'], disallowed: [], found: ['a1'], returned: [], excluded: [] }, T0 + DAY);
    expect(store.foundBy('linkedin', ['a1', 'a2', 'zz'])).toEqual(
      new Map([
        [
          'a1',
          [
            { keywords: ['react'], disallowed: [] },
            { keywords: ['vue'], disallowed: [] },
          ],
        ],
        ['a2', [{ keywords: ['react'], disallowed: [] }]],
      ]),
    );
    const listed = store.listJobs({
      field: 'first_seen',
      since: 0,
      until: T0 + 10 * DAY,
      sources: [],
      boards: [],
      search: { keywords: ['Vue'] },
      limit: 10,
      withDescription: false,
    });
    expect(listed.rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('lists jobs for a table: search text, sort (names without regard to case), paging, and keywords', () => {
    store.putJob('linkedin', { ...job('a3'), title: 'backend engineer', company: 'Zed 100%' }, T0 + 2 * DAY);
    const list = (extra: object) =>
      store.listJobs({
        field: 'first_seen',
        since: 0,
        until: T0 + 10 * DAY,
        sources: [],
        boards: [],
        limit: 10,
        withDescription: false,
        ...extra,
      });
    expect(list({ sort: 'title', dir: 'asc' }).rows.map((r) => r.id)).toEqual(['a3', 'a1', 'a2']);
    expect(list({ sort: 'title', dir: 'desc' }).rows.map((r) => r.id)).toEqual(['a2', 'a1', 'a3']);
    expect(list({ q: 'zed' }).rows.map((r) => r.id)).toEqual(['a3']);
    expect(list({ q: '100%' }).rows.map((r) => r.id)).toEqual(['a3']); // % is text, not a wildcard
    expect(list({ q: '%' }).rows.map((r) => r.id)).toEqual(['a3']);
    expect(list({ q: 'job a' }).total).toBe(2);
    expect(list({ limit: 1, offset: 1 }).rows.map((r) => r.id)).toEqual(['a2']);
    expect(list({ limit: 1, offset: 1 }).total).toBe(3);
    expect(list({ sort: 'description_chars', dir: 'asc' }).rows).toHaveLength(3);
  });

  it('is evicted with the jobs after the retention', () => {
    const short = Store.open(':memory:', { jobRetentionDays: 1 });
    short.recordSearch('linkedin', { keywords: ['old'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0);
    short.recordSearch('linkedin', { keywords: ['new'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0 + 5 * DAY);
    short.prune(T0 + 5 * DAY + 1000);
    expect(short.searchStats({ since: 0, until: T0 + 10 * DAY, limit: 10 }).map((s) => s.keywords)).toEqual([['new']]);
    short.close();
  });
});

describe('daily tool totals', () => {
  const T = Date.UTC(2026, 9, 5, 23, 30);
  const call = (over: object = {}) => ({
    ts: T,
    tool: 'linkedin_search',
    platform: 'linkedin',
    error: false,
    responseBytes: 2000,
    tokens: 570,
    units: 3,
    durationMs: 400,
    textAvailable: 8000,
    textReturned: 700,
    ...over,
  });
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
  });
  afterEach(() => store.close());

  it('adds each call to the totals of its UTC day and tool', () => {
    store.recordDailyUsage(call());
    store.recordDailyUsage(call({ error: true, durationMs: 900, tokens: 30, units: 1, textAvailable: 0, textReturned: 0 }));
    store.recordDailyUsage(call({ ts: T + 2 * 3600 * 1000 })); // after midnight UTC: the next day
    store.recordDailyUsage(call({ tool: 'apec_search', platform: 'apec' }));
    expect(store.dailyUsage('2026-10-05', '2026-10-06')).toEqual([
      {
        day: '2026-10-05',
        tool: 'apec_search',
        platform: 'apec',
        calls: 1,
        errors: 0,
        responseBytes: 2000,
        tokens: 570,
        units: 3,
        durationMs: 400,
        maxDurationMs: 400,
        textAvailable: 8000,
        textReturned: 700,
      },
      {
        day: '2026-10-05',
        tool: 'linkedin_search',
        platform: 'linkedin',
        calls: 2,
        errors: 1,
        responseBytes: 4000,
        tokens: 600,
        units: 4,
        durationMs: 1300,
        maxDurationMs: 900,
        textAvailable: 8000,
        textReturned: 700,
      },
      {
        day: '2026-10-06',
        tool: 'linkedin_search',
        platform: 'linkedin',
        calls: 1,
        errors: 0,
        responseBytes: 2000,
        tokens: 570,
        units: 3,
        durationMs: 400,
        maxDurationMs: 400,
        textAvailable: 8000,
        textReturned: 700,
      },
    ]);
  });

  it('reads a range of days, both ends included', () => {
    for (const day of [4, 5, 6, 7]) store.recordDailyUsage(call({ ts: Date.UTC(2026, 9, day, 12) }));
    expect(store.dailyUsage('2026-10-05', '2026-10-06').map((row) => row.day)).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('keeps counts and durations only, and is pruned after the retention', () => {
    const columns = (store as unknown as { db: { prepare(sql: string): { all(): { name: string }[] } } }).db
      .prepare('PRAGMA table_info(tool_usage_daily)')
      .all()
      .map((c) => c.name);
    expect(columns.join(' ')).not.toMatch(/param|arg|keyword|query/);
    store.recordDailyUsage(call({ ts: T - 401 * 24 * 3600 * 1000 }));
    store.recordDailyUsage(call());
    store.prune(T);
    expect(store.dailyUsage('2000-01-01', '2099-01-01')).toHaveLength(1);
  });
});

describe('salary columns', () => {
  const T = Date.UTC(2026, 9, 5);
  const job = (id: string, description: string): NewJobRow => ({
    id,
    board: null,
    title: `Job ${id}`,
    company: 'Acme',
    location: 'Paris',
    url: `https://x/${id}`,
    description,
  });
  const list = (store: Store, extra: object = {}) =>
    store.listJobs({ field: 'first_seen', since: 0, until: T + 1e9, sources: [], boards: [], limit: 10, withDescription: false, ...extra });

  it('reads the salary of a text when the job is stored and keeps it in step with the text', () => {
    const store = Store.open(':memory:');
    store.putJob('teamtailor', job('a1', 'Salary range: €72.000 - €115.000'), T);
    store.putJob('teamtailor', job('a2', 'Fixe 26.400€ + variable 12.500€'), T);
    store.putJob('teamtailor', job('a3', '6€ de repas par jour'), T);
    expect(store.getJob('teamtailor', 'a1')?.salary).toEqual({ min: 72_000, max: 115_000, currency: 'EUR', variable: null });
    expect(store.getJob('teamtailor', 'a2')?.salary).toEqual({ min: 26_400, max: 26_400, currency: 'EUR', variable: 12_500 });
    expect(store.getJob('teamtailor', 'a3')?.salary).toBeNull();
    store.putJob('teamtailor', job('a3', 'Now it pays 60k€'), T + 1);
    expect(store.getJob('teamtailor', 'a3')?.salary).toMatchObject({ min: 60_000, max: 60_000 });
    store.putJob('teamtailor', job('a3', 'The pay was removed'), T + 2);
    expect(store.getJob('teamtailor', 'a3')?.salary).toBeNull();
    store.close();
  });

  it('sorts by the upper end, jobs without a salary last in both directions, and the list carries the salary', () => {
    const store = Store.open(':memory:');
    store.putJob('p', job('low', 'Salary 50k€'), T);
    store.putJob('p', job('none', 'Nothing stated'), T);
    store.putJob('p', job('high', '80-95k€'), T);
    expect(list(store, { sort: 'salary', dir: 'desc' }).rows.map((r) => r.id)).toEqual(['high', 'low', 'none']);
    expect(list(store, { sort: 'salary', dir: 'asc' }).rows.map((r) => r.id)).toEqual(['low', 'high', 'none']);
    expect(list(store).rows.find((r) => r.id === 'high')?.salary).toMatchObject({ min: 80_000, max: 95_000 });
    store.close();
  });

  it('fills the salary of jobs stored before the columns existed, once, when the database is upgraded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jw-salary-'));
    try {
      const path = join(dir, 'old.sqlite');
      const old = Store.open(path);
      old.putJob('p', job('x1', 'Salary range: €72.000 - €115.000'), T);
      old.putJob('p', job('x2', 'No figure'), T);
      old.close();
      const raw = new DatabaseSync(path);
      // put the file back as a version 6 database: no salary columns, no adapter memory
      raw.exec(
        'DROP TABLE place_lookups; DROP TABLE ats_lookups; DROP TABLE company_boards; ALTER TABLE call_log DROP COLUMN detail; ALTER TABLE search_hits DROP COLUMN excluded_title; DROP INDEX search_runs_search; ALTER TABLE search_runs DROP COLUMN disallowed; ALTER TABLE search_runs DROP COLUMN disallowed_key; ALTER TABLE search_hits DROP COLUMN excluded_reason; ALTER TABLE search_hits DROP COLUMN excluded_term; CREATE INDEX search_runs_platform_keywords ON search_runs (platform, keywords_key); DROP TABLE platform_memory; DROP INDEX search_runs_platform_keywords; ALTER TABLE search_runs DROP COLUMN keywords; ALTER TABLE search_runs DROP COLUMN keywords_key; ALTER TABLE search_hits DROP COLUMN excluded; DROP INDEX jobs_salary_max; ALTER TABLE jobs DROP COLUMN salary_min; ALTER TABLE jobs DROP COLUMN salary_max; ALTER TABLE jobs DROP COLUMN salary_currency; ALTER TABLE jobs DROP COLUMN salary_variable; PRAGMA user_version = 6;',
      );
      raw.close();
      const upgraded = Store.open(path);
      expect(upgraded.getJob('p', 'x1')?.salary).toMatchObject({ min: 72_000, max: 115_000 });
      expect(upgraded.getJob('p', 'x2')?.salary).toBeNull();
      expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ATS discovery', () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
  });
  afterEach(() => store.close());

  const match = { ats: 'greenhouse', handle: 'acme', jobs: 3, boardUrl: 'https://boards.greenhouse.io/acme' };

  it('logs the lookups, newest first, and drops them with the call log', () => {
    store.recordLookup({ company: 'Acme', tried: ['acme'], matches: [match] }, 1000);
    store.recordLookup({ company: 'Ghost', tried: ['ghost'], matches: [] }, 2000);
    const { rows, total } = store.listLookups(10, 0);
    expect(total).toBe(2);
    expect(rows.map((row) => [row.company, row.ts, row.matches.length])).toEqual([
      ['Ghost', 2000, 0],
      ['Acme', 1000, 1],
    ]);
    expect(rows[1]?.matches[0]).toEqual(match);
    expect(store.listLookups(1, 1).rows.map((row) => row.company)).toEqual(['Acme']);
    store.prune(2000 + 31 * 24 * 3600 * 1000);
    expect(store.listLookups(10, 0).total).toBe(0);
  });

  it('maps a company to one board per ATS, matching the name by its slug', () => {
    expect(store.addCompanyBoard({ company: 'Société Générale', ats: 'greenhouse', handle: 'sg' }, 1000)).toMatchObject({ handle: 'sg' });
    expect(store.findCompanyBoard('societe-generale', 'greenhouse')).toBe('sg');
    expect(store.findCompanyBoard('SOCIÉTÉ GÉNÉRALE', 'greenhouse')).toBe('sg');
    expect(store.findCompanyBoard('Société Générale', 'lever')).toBeNull();
    expect(store.findCompanyBoard('!!!', 'greenhouse')).toBeNull();
    // already mapped on that ATS: nothing changes
    expect(store.addCompanyBoard({ company: 'societe generale', ats: 'greenhouse', handle: 'other' }, 2000)).toBeNull();
    expect(store.findCompanyBoard('Société Générale', 'greenhouse')).toBe('sg');
    expect(store.addCompanyBoard({ company: 'Société Générale', ats: 'lever', handle: 'sg-lever' }, 2000)).not.toBeNull();
  });

  it('refuses a name, an ATS or a handle that is not valid', () => {
    expect(() => store.addCompanyBoard({ company: '  ', ats: 'lever', handle: 'a' }, 1)).toThrow(/name/);
    expect(() => store.addCompanyBoard({ company: 'A', ats: 'Lever!', handle: 'a' }, 1)).toThrow(/ATS/);
    expect(() => store.addCompanyBoard({ company: 'A', ats: 'lever', handle: '../x' }, 1)).toThrow(/handle/);
  });

  it('lists the mappings A to Z, searches by company or board, and forgets one', () => {
    store.addCompanyBoard({ company: 'Zeta', ats: 'lever', handle: 'zeta' }, 1);
    const acme = store.addCompanyBoard({ company: 'acme', ats: 'greenhouse', handle: 'acme-labs' }, 2);
    store.addCompanyBoard({ company: 'Beta', ats: 'ashby', handle: 'b_eta' }, 3);
    const list = (q?: string, ats?: string) =>
      store.listCompanyBoards({ ...(q === undefined ? {} : { q }), ...(ats === undefined ? {} : { ats }), limit: 10, offset: 0 });
    expect(list().rows.map((row) => row.company)).toEqual(['acme', 'Beta', 'Zeta']);
    expect(list('LABS').rows.map((row) => row.company)).toEqual(['acme']);
    expect(list('b_').rows.map((row) => row.company)).toEqual(['Beta']); // `_` is not a wildcard
    expect(list(undefined, 'lever').total).toBe(1);
    expect(store.deleteCompanyBoard(acme?.id ?? 0)).toBe(true);
    expect(store.deleteCompanyBoard(acme?.id ?? 0)).toBe(false);
    expect(list().total).toBe(2);
  });
});

describe('LinkedIn place lookups', () => {
  it('logs them newest first with their source and hits, and drops them with the call log', () => {
    const store = Store.open(':memory:');
    store.recordPlaceLookup({ query: 'Berlin', source: 'tool', hits: [{ id: '103035651', label: 'Berlin, Germany' }] }, 1000);
    store.recordPlaceLookup({ query: 'Nowhere', source: 'search', hits: [] }, 2000);
    const { rows, total } = store.listPlaceLookups(10, 0);
    expect(total).toBe(2);
    expect(rows.map((row) => [row.query, row.source, row.hits.length])).toEqual([
      ['Nowhere', 'search', 0],
      ['Berlin', 'tool', 1],
    ]);
    expect(store.listPlaceLookups(1, 1).rows[0]?.hits[0]).toEqual({ id: '103035651', label: 'Berlin, Germany' });
    store.prune(2000 + 31 * 24 * 3600 * 1000);
    expect(store.listPlaceLookups(10, 0).total).toBe(0);
    store.close();
  });
});

describe('adapter memory', () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
  });
  afterEach(() => store.close());

  it('keeps a value under a key, replaces it, forgets it, and lists by prefix oldest first', () => {
    store.setMemory('linkedin.geo:berlin', '{"id":"1"}', 1000);
    store.setMemory('linkedin.geo:lisbon', '{"id":"2"}', 2000);
    store.setMemory('other:key', 'x', 1500);
    expect(store.getMemory('linkedin.geo:berlin')).toBe('{"id":"1"}');
    expect(store.getMemory('missing')).toBeNull();
    expect(store.listMemory('linkedin.geo:').map((entry) => entry.key)).toEqual(['linkedin.geo:berlin', 'linkedin.geo:lisbon']);
    store.setMemory('linkedin.geo:berlin', '{"id":"3"}', 3000);
    expect(store.getMemory('linkedin.geo:berlin')).toBe('{"id":"3"}');
    expect(store.listMemory('linkedin.geo:').map((entry) => entry.key)).toEqual(['linkedin.geo:lisbon', 'linkedin.geo:berlin']);
    store.deleteMemory('linkedin.geo:berlin');
    expect(store.getMemory('linkedin.geo:berlin')).toBeNull();
  });

  it('treats a prefix with a wildcard character as text, not as a pattern', () => {
    store.setMemory('a%b:1', 'x', 1);
    store.setMemory('aXb:1', 'y', 2);
    expect(store.listMemory('a%b:').map((entry) => entry.key)).toEqual(['a%b:1']);
  });

  it('refuses a key or a value that is not usable', () => {
    expect(() => store.setMemory('', 'x', 1)).toThrow(StoreError);
    expect(() => store.setMemory('k'.repeat(121), 'x', 1)).toThrow(StoreError);
    expect(() => store.setMemory('bad\nkey', 'x', 1)).toThrow(StoreError);
    expect(() => store.setMemory('k', 'v'.repeat(401), 1)).toThrow(StoreError);
  });

  it('drops the oldest entries when it is full', () => {
    for (let i = 0; i < MAX_MEMORY_ENTRIES + 5; i++) store.setMemory(`k:${String(i).padStart(4, '0')}`, 'v', i);
    const keys = store.listMemory('k:').map((entry) => entry.key);
    expect(keys).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(keys[0]).toBe('k:0005');
    expect(store.getMemory('k:0000')).toBeNull();
  });
});

describe('searches as keyword lists', () => {
  const T0 = Date.UTC(2026, 9, 1, 12);
  const DAY = 86_400_000;
  let store: Store;
  const job = (id: string, title: string): NewJobRow => ({
    id,
    title,
    company: 'Acme',
    location: 'Remote',
    url: `https://x.test/${id}`,
    description: 'D',
  });
  beforeEach(() => {
    store = Store.open(':memory:');
    for (const [id, title] of [
      ['a1', 'React dev'],
      ['a2', 'Vue dev'],
      ['a3', 'Intern'],
    ] as const)
      store.putJob('linkedin', job(id, title), T0);
  });
  afterEach(() => store.close());

  it('keeps the list in the order it was given and counts two orderings or casings of it as one search', () => {
    store.recordSearch('linkedin', { keywords: ['Vue', 'React'], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0);
    store.recordSearch(
      'linkedin',
      { keywords: ['react', ' vue ', 'REACT'], disallowed: [], found: ['a2'], returned: ['a2'], excluded: [] },
      T0 + DAY,
    );
    const stats = store.searchStats({ since: T0, until: T0 + 3 * DAY, limit: 10 });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ keywords: ['react', 'vue'], runs: 2, jobsFound: 2 });
    expect(store.foundBy('linkedin', ['a1']).get('a1')).toEqual([{ keywords: ['react', 'vue'], disallowed: [] }]);
  });

  it('counts the jobs a search excluded apart from the ones it returned', () => {
    store.recordSearch(
      'linkedin',
      {
        keywords: ['dev'],
        disallowed: [],
        found: ['a1', 'a2', 'a3'],
        returned: ['a1'],
        excluded: [{ id: 'a3', title: 'T', reason: 'title', term: 'x' }],
      },
      T0,
    );
    expect(store.searchStats({ since: T0, until: T0 + DAY, limit: 10 })[0]).toMatchObject({
      jobsFound: 3,
      jobsReturned: 1,
      jobsExcluded: 1,
    });
  });

  it('gives the detail of one search: the counts and its jobs, returned first, then discarded, then the others', () => {
    store.recordSearch(
      'linkedin',
      {
        keywords: ['dev'],
        disallowed: [],
        found: ['a3', 'a2', 'a1'],
        returned: ['a1'],
        excluded: [{ id: 'a3', title: 'T', reason: 'title', term: 'x' }],
      },
      T0,
    );
    const detail = store.searchDetail('linkedin', ['DEV'], [], { limit: 10 });
    expect(detail).toMatchObject({ keywords: ['dev'], runs: 1, jobsFound: 3, jobsReturned: 1, jobsExcluded: 1 });
    expect(detail?.jobs.map((entry) => [entry.id, entry.outcome, entry.title])).toEqual([
      ['a1', 'returned', 'React dev'],
      ['a3', 'excluded', 'Intern'],
      ['a2', 'other', 'Vue dev'],
    ]);
    expect(store.searchDetail('linkedin', ['dev'], [], { limit: 2 })?.jobs).toHaveLength(2);
    expect(store.searchDetail('linkedin', ['nothing'], [], { limit: 10 })).toBeNull();
    expect(store.searchDetail('apec', ['dev'], [], { limit: 10 })).toBeNull();
    expect(store.searchDetail('linkedin', ['dev'], [], { limit: 10, since: T0 + DAY })).toBeNull(); // outside the window
  });

  it('keeps a job in the list after its text was evicted, with no title', () => {
    store.recordSearch('linkedin', { keywords: ['dev'], disallowed: [], found: ['gone1'], returned: [], excluded: [] }, T0);
    expect(store.searchDetail('linkedin', ['dev'], [], { limit: 10 })?.jobs).toEqual([
      {
        id: 'gone1',
        title: null,
        stored: false,
        company: null,
        location: null,
        url: null,
        lastSeen: null,
        outcome: 'other',
        excludedBy: null,
        timesListed: 1,
      },
    ]);
  });

  it('is a search of its own without keywords, and filters the jobs by the exact list', () => {
    store.recordSearch('linkedin', { keywords: [], disallowed: [], found: ['a1'], returned: ['a1'], excluded: [] }, T0);
    store.recordSearch(
      'linkedin',
      {
        keywords: ['react', 'vue'],
        disallowed: [],
        found: ['a2', 'a3'],
        returned: ['a2'],
        excluded: [{ id: 'a3', title: 'T', reason: 'title', term: 'x' }],
      },
      T0,
    );
    const ids = (keywords: string[]) =>
      store
        .listJobs({
          field: 'first_seen',
          since: 0,
          until: T0 + DAY,
          sources: [],
          boards: [],
          search: { keywords },
          limit: 10,
          withDescription: false,
        })
        .rows.map((row) => row.id)
        .sort();
    expect(ids([])).toEqual(['a1']);
    expect(ids(['Vue', 'react'])).toEqual(['a2', 'a3']); // any order, any case
    expect(ids(['react'])).toEqual([]); // not a part of the list: the whole list is the search
  });

  it('splits the old query text of the searches stored before keyword lists, on OR and on a pipe, once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jw-keywords-'));
    try {
      const path = join(dir, 'old.sqlite');
      const first = Store.open(path);
      first.recordSearch('linkedin', { keywords: ['x'], disallowed: [], found: ['a1'], returned: [], excluded: [] }, T0);
      first.close();
      const raw = new DatabaseSync(path);
      raw.exec(`DELETE FROM search_runs; DELETE FROM search_hits;
        INSERT INTO search_runs (id, ts, platform, query, found, returned) VALUES (1, ${T0}, 'linkedin', 'React OR Vue', 1, 0), (2, ${T0}, 'teamtailor', 'go | rust', 1, 0), (3, ${T0}, 'linkedin', 'director or manager', 1, 0), (4, ${T0}, 'wttj', '', 1, 0);`);
      raw.exec(
        'DROP TABLE place_lookups; DROP TABLE ats_lookups; DROP TABLE company_boards; ALTER TABLE call_log DROP COLUMN detail; ALTER TABLE search_hits DROP COLUMN excluded_title; DROP INDEX search_runs_search; ALTER TABLE search_runs DROP COLUMN disallowed; ALTER TABLE search_runs DROP COLUMN disallowed_key; ALTER TABLE search_hits DROP COLUMN excluded_reason; ALTER TABLE search_hits DROP COLUMN excluded_term; CREATE INDEX search_runs_platform_keywords ON search_runs (platform, keywords_key); DROP INDEX search_runs_platform_keywords; ALTER TABLE search_runs DROP COLUMN keywords; ALTER TABLE search_runs DROP COLUMN keywords_key; ALTER TABLE search_hits DROP COLUMN excluded; PRAGMA user_version = 8;',
      );
      raw.close();
      const upgraded = Store.open(path);
      const stats = upgraded.searchStats({ since: 0, until: T0 + DAY, limit: 10 });
      expect(stats.map((row) => [row.platform, row.keywords]).sort()).toEqual(
        [
          ['linkedin', ['director or manager']], // a lower-case "or" is a word of the title, not the operator
          ['linkedin', ['react', 'vue']],
          ['teamtailor', ['go', 'rust']],
          ['wttj', []],
        ].sort(),
      );
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('with disallowed terms', () => {
    const run = (
      disallowed: string[],
      excluded: { id: string; title: string | null; reason: 'title' | 'description' | 'salary'; term: string }[],
      at = T0,
    ) => store.recordSearch('linkedin', { keywords: ['dev'], disallowed, found: ['a1', 'a2', 'a3'], returned: ['a1'], excluded }, at);

    it('makes the same keywords with other disallowed terms another search, and the same terms in any order or case one search', () => {
      run([], []);
      run(['Intern', 'senior'], [{ id: 'a3', title: 'T', reason: 'title', term: 'Intern' }]);
      run(['SENIOR', 'intern', ' intern '], [{ id: 'a3', title: 'T', reason: 'title', term: 'intern' }], T0 + DAY);
      const stats = store.searchStats({ since: T0, until: T0 + 3 * DAY, limit: 10 });
      expect(stats.map((stat) => [stat.keywords, stat.disallowed, stat.runs]).sort()).toEqual([
        [['dev'], [], 1],
        [['dev'], ['intern', 'senior'], 2],
      ]);
    });

    it('keeps which term dropped each job and where it matched, and reads it back in the detail', () => {
      run(['intern', 'senior'], [{ id: 'a3', title: 'T', reason: 'description', term: 'Intern' }]);
      const detail = store.searchDetail('linkedin', ['dev'], ['Senior', 'INTERN'], { limit: 10 });
      expect(detail).toMatchObject({ disallowed: ['intern', 'senior'], jobsExcluded: 1 });
      expect(detail?.jobs.find((entry) => entry.id === 'a3')).toMatchObject({
        outcome: 'excluded',
        excludedBy: { reason: 'description', term: 'Intern' },
      });
      expect(detail?.jobs.find((entry) => entry.id === 'a1')?.excludedBy).toBeNull(); // a returned job was not dropped
      expect(detail?.jobs.find((entry) => entry.id === 'a2')?.excludedBy).toBeNull();
      // the search without these terms is another one: asking for it finds nothing
      expect(store.searchDetail('linkedin', ['dev'], [], { limit: 10 })).toBeNull();
    });

    it('keeps the title of a job the search dropped, also when the job itself was never stored, and says whether it is stored', () => {
      store.recordSearch(
        'linkedin',
        {
          keywords: ['dev'],
          disallowed: ['intern'],
          found: ['a1', 'a3', 'never1'],
          returned: ['a1'],
          // a3 is stored; never1 was dropped by its title before its page was read, so only the hit knows its title
          excluded: [
            { id: 'a3', title: 'Recorded with the hit', reason: 'title', term: 'intern' },
            { id: 'never1', title: 'Intern, Data', reason: 'title', term: 'intern' },
          ],
        },
        T0,
      );
      const jobs = store.searchDetail('linkedin', ['dev'], ['intern'], { limit: 10 })?.jobs ?? [];
      const byId = Object.fromEntries(jobs.map((entry) => [entry.id, entry]));
      expect(byId['never1']).toMatchObject({
        title: 'Intern, Data',
        stored: false,
        outcome: 'excluded',
        excludedBy: { reason: 'title', term: 'intern' },
      });
      expect(byId['a3']).toMatchObject({ title: 'Intern', stored: true }); // the stored job's own title wins over the recorded one
      expect(byId['a1']).toMatchObject({ title: 'React dev', stored: true });
    });

    it('has no title for a dropped job recorded without one, and cuts a very long title', () => {
      store.recordSearch(
        'linkedin',
        {
          keywords: ['dev'],
          disallowed: ['x'],
          found: ['old1', 'long1'],
          returned: [],
          excluded: [
            { id: 'old1', title: null, reason: 'title', term: 'x' },
            { id: 'long1', title: 'L'.repeat(900), reason: 'title', term: 'x' },
          ],
        },
        T0,
      );
      const byId = Object.fromEntries(
        (store.searchDetail('linkedin', ['dev'], ['x'], { limit: 10 })?.jobs ?? []).map((entry) => [entry.id, entry]),
      );
      expect(byId['old1']).toMatchObject({ title: null, stored: false });
      expect(byId['long1']?.title).toHaveLength(300);
    });

    it('says the salary is what dropped a job, with the salary the job states', () => {
      run([], [{ id: 'a2', title: 'T', reason: 'salary', term: '40000-45000 EUR' }]);
      expect(store.searchDetail('linkedin', ['dev'], [], { limit: 10 })?.jobs.find((entry) => entry.id === 'a2')?.excludedBy).toEqual({
        reason: 'salary',
        term: '40000-45000 EUR',
      });
    });

    it('gives each job the searches that listed it, with their counts and what each did with it', () => {
      run([], []); // a1 returned, a2 and a3 only matched
      store.recordSearch(
        'linkedin',
        {
          keywords: ['dev'],
          disallowed: ['intern'],
          found: ['a1', 'a3'],
          returned: ['a3'],
          excluded: [{ id: 'a1', title: 'T', reason: 'title', term: 'intern' }],
        },
        T0 + 2 * DAY,
      );
      const searches = store.jobSearches('linkedin', 'a1');
      expect(searches.map((search) => [search.disallowed, search.outcome, search.excludedBy?.term ?? null])).toEqual([
        [['intern'], 'excluded', 'intern'], // the most recent search first
        [[], 'returned', null],
      ]);
      expect(searches[0]).toMatchObject({
        keywords: ['dev'],
        runs: 1,
        jobsFound: 2,
        jobsReturned: 1,
        jobsExcluded: 1,
        platform: 'linkedin',
      });
      expect(store.jobSearches('linkedin', 'nobody')).toEqual([]);
      expect(store.jobSearches('apec', 'a1')).toEqual([]);
    });

    it('filters the jobs by the exact search, terms included, or by the keywords whatever the terms', () => {
      run([], []);
      run(['intern'], [{ id: 'a3', title: 'T', reason: 'title', term: 'intern' }], T0 + DAY);
      const ids = (search: { keywords: string[]; disallowed?: string[] }) =>
        store
          .listJobs({
            field: 'first_seen',
            since: 0,
            until: T0 + 10 * DAY,
            sources: [],
            boards: [],
            search,
            limit: 10,
            withDescription: false,
          })
          .rows.map((row) => row.id)
          .sort();
      expect(ids({ keywords: ['dev'] })).toEqual(['a1', 'a2', 'a3']); // any terms
      expect(ids({ keywords: ['dev'], disallowed: [] })).toEqual(['a1', 'a2', 'a3']); // the search with no terms listed them too
      expect(ids({ keywords: ['dev'], disallowed: ['Intern'] })).toEqual(['a1', 'a2', 'a3']);
      expect(ids({ keywords: ['dev'], disallowed: ['senior'] })).toEqual([]);
    });

    it('splits nothing in the data of a database older than disallowed terms: its searches have none', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jw-terms-'));
      try {
        const path = join(dir, 'old.sqlite');
        const first = Store.open(path);
        first.recordSearch('linkedin', { keywords: ['x'], disallowed: ['y'], found: ['a1'], returned: [], excluded: [] }, T0);
        first.close();
        const raw = new DatabaseSync(path);
        raw.exec(
          'DROP TABLE place_lookups; DROP TABLE ats_lookups; DROP TABLE company_boards; ALTER TABLE call_log DROP COLUMN detail; ALTER TABLE search_hits DROP COLUMN excluded_title; DROP INDEX search_runs_search; ALTER TABLE search_runs DROP COLUMN disallowed; ALTER TABLE search_runs DROP COLUMN disallowed_key; ALTER TABLE search_hits DROP COLUMN excluded_reason; ALTER TABLE search_hits DROP COLUMN excluded_term; CREATE INDEX search_runs_platform_keywords ON search_runs (platform, keywords_key); PRAGMA user_version = 9;',
        );
        raw.close();
        const upgraded = Store.open(path);
        expect(upgraded.searchStats({ since: 0, until: T0 + DAY, limit: 10 }).map((row) => [row.keywords, row.disallowed])).toEqual([
          [['x'], []],
        ]);
        upgraded.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
