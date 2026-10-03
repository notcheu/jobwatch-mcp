import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CALL_LOG_RETENTION_MS,
  MAX_JOB_DESCRIPTION_CHARS,
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
    expect(() => Store.open(join(blocker, 'sub', 'x.sqlite'))).toThrow(/Is JW_DATA_DIR writable\?/);
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
    expect(store.prune(now)).toEqual({ calls: 1, usage: 1, jobs: 0 });
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
    store.recordSearch('linkedin', { query: 'React  Engineer', found: ['a1', 'a2', 'a3'], returned: ['a1', 'a2'] }, T0);
    store.recordSearch('linkedin', { query: 'react engineer', found: ['a1', 'a4'], returned: ['a1'] }, T0 + DAY);
    store.recordSearch('linkedin', { query: 'vue', found: ['a9'], returned: [] }, T0 + DAY);
    const stats = store.searchStats({ since: T0, until: T0 + 3 * DAY, limit: 10 });
    expect(stats).toEqual([
      { platform: 'linkedin', query: 'react engineer', runs: 2, lastRun: T0 + DAY, jobsFound: 4, jobsReturned: 2, jobsNew: 2 },
      { platform: 'linkedin', query: 'vue', runs: 1, lastRun: T0 + DAY, jobsFound: 1, jobsReturned: 0, jobsNew: 0 },
    ]);
  });

  it('leaves runs outside the window and other platforms out, and a new job is one first stored inside the window', () => {
    store.recordSearch('linkedin', { query: 'x', found: ['a1'], returned: ['a1'] }, T0 - DAY);
    store.recordSearch('apec', { query: 'x', found: ['a1'], returned: ['a1'] }, T0);
    expect(store.searchStats({ since: T0, until: T0 + DAY, limit: 10 }).map((s) => s.platform)).toEqual(['apec']);
    expect(store.searchStats({ since: T0, until: T0 + DAY, platform: 'linkedin', limit: 10 })).toEqual([]);
    store.recordSearch('linkedin', { query: 'x', found: ['a2'], returned: ['a2'] }, T0 + 2 * DAY);
    expect(store.searchStats({ since: T0 + 2 * DAY, until: T0 + 3 * DAY, limit: 10 })[0]?.jobsNew).toBe(0); // a2 was first stored a day earlier
  });

  it('keeps at most 1000 ids per run, the returned ones first', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `j${i}`);
    store.recordSearch('teamtailor', { query: '', found: ids, returned: ['j1400'] }, T0);
    const [stat] = store.searchStats({ since: T0, until: T0 + DAY, limit: 5 });
    expect(stat).toMatchObject({ runs: 1, jobsFound: 1000, jobsReturned: 1 });
    expect(store.foundBy('teamtailor', ['j1400'])).toEqual(new Map()); // empty keywords are not reported
  });

  it('says which keywords listed a job, and lists the jobs of a keyword', () => {
    store.recordSearch('linkedin', { query: 'react', found: ['a1', 'a2'], returned: ['a1'] }, T0);
    store.recordSearch('linkedin', { query: 'REACT', found: ['a1'], returned: ['a1'] }, T0 + DAY);
    store.recordSearch('linkedin', { query: 'vue', found: ['a1'], returned: [] }, T0 + DAY);
    expect(store.foundBy('linkedin', ['a1', 'a2', 'zz'])).toEqual(
      new Map([
        ['a1', ['react', 'vue']],
        ['a2', ['react']],
      ]),
    );
    const listed = store.listJobs({
      field: 'first_seen',
      since: 0,
      until: T0 + 10 * DAY,
      sources: [],
      boards: [],
      search: 'Vue',
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
    short.recordSearch('linkedin', { query: 'old', found: ['a1'], returned: ['a1'] }, T0);
    short.recordSearch('linkedin', { query: 'new', found: ['a1'], returned: ['a1'] }, T0 + 5 * DAY);
    short.prune(T0 + 5 * DAY + 1000);
    expect(short.searchStats({ since: 0, until: T0 + 10 * DAY, limit: 10 }).map((s) => s.query)).toEqual(['new']);
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
      // put the file back as a version 6 database: no salary columns
      raw.exec(
        'DROP INDEX jobs_salary_max; ALTER TABLE jobs DROP COLUMN salary_min; ALTER TABLE jobs DROP COLUMN salary_max; ALTER TABLE jobs DROP COLUMN salary_currency; ALTER TABLE jobs DROP COLUMN salary_variable; PRAGMA user_version = 6;',
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
