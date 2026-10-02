import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Milliseconds since the epoch. Injected everywhere time matters, so tests control it. */
export type Clock = () => number;

export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export type BreakerReason = 'needs_login' | 'checkpoint';

export interface BreakerRow {
  platform: string;
  reason: BreakerReason;
  openedAt: number;
  /** When the breaker closes by itself; null = stays open until someone closes it (after a successful login). */
  until: number | null;
}

export interface UsageEvent {
  ts: number;
  cost: number;
}

export interface CallRecord {
  ts: number;
  requestId: string;
  tool: string;
  adapter: string;
  platform: string;
  outcome: string;
  durationMs: number;
  argsHash: string;
}

/** Retention: the call log keeps 30 days; usage events only need to cover the longest rate window with margin. */
export const CALL_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const USAGE_RETENTION_MS = 2 * 24 * 3600 * 1000;
/** Stored job postings: kept `JW_JOB_RETENTION_DAYS` (default 30) from the last time they were seen. */
export const DEFAULT_JOB_RETENTION_DAYS = 30;
export const MAX_JOB_DESCRIPTION_CHARS = 20_000;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Each entry upgrades the schema by one version (`PRAGMA user_version`). Never edit a released migration: add a new one.
 * Migration 2 adds the `jobs` table, 3 its `last_seen` column, 4 its `board` column.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE usage (
    id       INTEGER PRIMARY KEY,
    platform TEXT    NOT NULL,
    ts       INTEGER NOT NULL,
    cost     INTEGER NOT NULL CHECK (cost > 0)
  );
  CREATE INDEX usage_platform_ts ON usage (platform, ts);

  CREATE TABLE breaker (
    platform  TEXT PRIMARY KEY,
    reason    TEXT    NOT NULL CHECK (reason IN ('needs_login', 'checkpoint')),
    opened_at INTEGER NOT NULL,
    until_ts  INTEGER
  );

  CREATE TABLE call_log (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    request_id  TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    adapter     TEXT    NOT NULL,
    platform    TEXT    NOT NULL,
    outcome     TEXT    NOT NULL,
    duration_ms INTEGER NOT NULL,
    args_hash   TEXT    NOT NULL
  );
  CREATE INDEX call_log_ts ON call_log (ts);
  `,
  // 2: the jobs an adapter already opened (public postings; no cookies, no arguments). Evicted by `prune` on fetched_at.
  `
  CREATE TABLE jobs (
    platform    TEXT    NOT NULL,
    id          TEXT    NOT NULL,
    first_seen  INTEGER NOT NULL,
    fetched_at  INTEGER NOT NULL,
    title       TEXT,
    company     TEXT,
    location    TEXT,
    url         TEXT    NOT NULL,
    description TEXT    NOT NULL,
    PRIMARY KEY (platform, id)
  ) WITHOUT ROWID;
  CREATE INDEX jobs_fetched_at ON jobs (fetched_at);
  `,
  // 3: last_seen, refreshed whenever the job is seen again (search card included); eviction counts from it, not from fetched_at.
  `
  ALTER TABLE jobs ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
  UPDATE jobs SET last_seen = fetched_at;
  DROP INDEX jobs_fetched_at;
  CREATE INDEX jobs_last_seen ON jobs (last_seen);
  `,
  // 4: board = where within the platform the job was found (an ATS company handle); `platform` is the source platform.
  `
  ALTER TABLE jobs ADD COLUMN board TEXT;
  CREATE INDEX jobs_platform_board ON jobs (platform, board);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

interface Rows {
  [column: string]: number | string | null;
}

/**
 * The router's only persistent state: rate-limit usage, circuit breakers and the call log (SQLite, WAL).
 * Synchronous on purpose: one process, tiny rows, and a rate check must be atomic with its decision.
 * Also holds the job postings adapters chose to remember (`jobs`: public text, retention below). Never stores cookies, tokens,
 * tool arguments or raw pages: otherwise only counters, platform names and hashes.
 */
export class Store {
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly jobRetentionMs: number,
  ) {}

  /** `path` may be `:memory:` (tests). A file is created with mode 0600 together with its parent directory. */
  static open(path: string, options: { jobRetentionDays?: number } = {}): Store {
    const days = options.jobRetentionDays ?? DEFAULT_JOB_RETENTION_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new StoreError('jobRetentionDays must be a whole number of days between 1 and 3650');
    let db: DatabaseSync;
    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
        // Create the file owner-only BEFORE SQLite touches it: the -wal and -shm side files copy the mode the main file has
        // at the moment they are created, so chmod-ing afterwards would leave them readable by other users.
        closeSync(openSync(path, 'a', 0o600));
      }
      db = new DatabaseSync(path);
    } catch (cause) {
      throw new StoreError(
        `Cannot open the database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}. Is JW_DATA_DIR writable?`,
        { cause },
      );
    }
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      Store.migrate(db);
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (cause) {
      db.close();
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(`Cannot prepare the database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    return new Store(db, days * 24 * 3600 * 1000);
  }

  private static migrate(db: DatabaseSync): void {
    const row = db.prepare('PRAGMA user_version').get() as Rows | undefined;
    const current = Number(row?.['user_version'] ?? 0);
    if (current > SCHEMA_VERSION) {
      throw new StoreError(
        `The database has schema version ${current} but this build only understands up to ${SCHEMA_VERSION}: refusing to run an older router on a newer database.`,
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[version] ?? '');
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Rows | undefined)?.['user_version'] ?? 0);
  }

  /** Run `work` in one write transaction: all of it happens, or none of it. Used to make "check then take" atomic. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- usage (rate limiting)

  /** The keys (`greenhouse#algolia` -> `algolia`) of a platform that have usage events newer than `sinceMs`. */
  usageKeys(platform: string, sinceMs: number): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT platform FROM usage WHERE ts > ? AND substr(platform, 1, ?) = ?')
      .all(sinceMs, platform.length + 1, `${platform}#`) as unknown as Rows[];
    return rows.map((row) => String(row['platform']).slice(platform.length + 1)).sort();
  }

  /** Events of a platform newer than `sinceMs`, oldest first. */
  usageSince(platform: string, sinceMs: number): UsageEvent[] {
    const rows = this.db
      .prepare('SELECT ts, cost FROM usage WHERE platform = ? AND ts > ? ORDER BY ts ASC, id ASC')
      .all(platform, sinceMs) as unknown as Rows[];
    return rows.map((row) => ({ ts: Number(row['ts']), cost: Number(row['cost']) }));
  }

  /** Returns the id of the new event, so the charge can be settled once the real cost is known. */
  addUsage(platform: string, ts: number, cost: number): number {
    return Number(this.db.prepare('INSERT INTO usage (platform, ts, cost) VALUES (?, ?, ?)').run(platform, ts, cost).lastInsertRowid);
  }

  /** Lower an event's cost (a refund); 0 removes it. Never raises it. */
  settleUsage(id: number, cost: number): void {
    if (cost <= 0) this.db.prepare('DELETE FROM usage WHERE id = ?').run(id);
    else this.db.prepare('UPDATE usage SET cost = ? WHERE id = ? AND cost > ?').run(cost, id, cost);
  }

  // ---- circuit breaker

  getBreaker(platform: string): BreakerRow | undefined {
    const row = this.db.prepare('SELECT platform, reason, opened_at, until_ts FROM breaker WHERE platform = ?').get(platform) as
      Rows | undefined;
    return row === undefined ? undefined : toBreaker(row);
  }

  listBreakers(): BreakerRow[] {
    return (this.db.prepare('SELECT platform, reason, opened_at, until_ts FROM breaker ORDER BY platform').all() as unknown as Rows[]).map(
      toBreaker,
    );
  }

  /** Insert or replace the breaker of a platform. */
  putBreaker(row: BreakerRow): void {
    this.db
      .prepare(
        'INSERT INTO breaker (platform, reason, opened_at, until_ts) VALUES (?, ?, ?, ?) ON CONFLICT (platform) DO UPDATE SET reason = excluded.reason, opened_at = excluded.opened_at, until_ts = excluded.until_ts',
      )
      .run(row.platform, row.reason, row.openedAt, row.until);
  }

  deleteBreaker(platform: string): boolean {
    return Number(this.db.prepare('DELETE FROM breaker WHERE platform = ?').run(platform).changes) > 0;
  }

  // ---- call log

  recordCall(call: CallRecord): void {
    this.db
      .prepare(
        'INSERT INTO call_log (ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(call.ts, call.requestId, call.tool, call.adapter, call.platform, call.outcome, call.durationMs, call.argsHash);
  }

  recentCalls(limit: number): CallRecord[] {
    const rows = this.db
      .prepare('SELECT ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash FROM call_log ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as unknown as Rows[];
    return rows.map((row) => ({
      ts: Number(row['ts']),
      requestId: String(row['request_id']),
      tool: String(row['tool']),
      adapter: String(row['adapter']),
      platform: String(row['platform']),
      outcome: String(row['outcome']),
      durationMs: Number(row['duration_ms']),
      argsHash: String(row['args_hash']),
    }));
  }

  countCalls(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM call_log').get() as Rows | undefined)?.['n'] ?? 0);
  }

  // ------------------------------------------------------------------------------------------------------ jobs

  /** Which of `ids` are stored for `platform`. */
  knownJobs(platform: string, ids: readonly string[]): Set<string> {
    const found = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 AS hit FROM jobs WHERE platform = ? AND id = ?');
    for (const id of new Set(ids)) if (stmt.get(platform, id) !== undefined) found.add(id);
    return found;
  }

  getJob(platform: string, id: string): StoredJobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE platform = ? AND id = ?').get(platform, id) as Rows | undefined;
    return row === undefined ? null : toJob(row);
  }

  /** Insert, or replace and refresh `fetched_at` and `last_seen`; `first_seen` survives a refresh. Validates and caps what an adapter sends. */
  putJob(platform: string, job: NewJobRow, now: number): void {
    if (!JOB_ID.test(job.id)) throw new StoreError('invalid job id');
    const text = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
    this.db
      .prepare(
        `INSERT INTO jobs (platform, id, first_seen, fetched_at, last_seen, title, company, location, board, url, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, id) DO UPDATE SET
           fetched_at = excluded.fetched_at, last_seen = excluded.last_seen, title = excluded.title, company = excluded.company, location = excluded.location, board = excluded.board,
           url = excluded.url, description = excluded.description`,
      )
      .run(
        platform,
        job.id,
        now,
        now,
        now,
        text(job.title, 300),
        text(job.company, 300),
        text(job.location, 300),
        text(job.board ?? null, 120),
        job.url.slice(0, 500),
        job.description.slice(0, MAX_JOB_DESCRIPTION_CHARS),
      );
  }

  /** Mark stored jobs as seen at `now`. Never moves `last_seen` backwards; ids that are not stored are ignored. */
  touchJobs(platform: string, ids: readonly string[], now: number): void {
    const stmt = this.db.prepare('UPDATE jobs SET last_seen = ? WHERE platform = ? AND id = ? AND last_seen < ?');
    this.transaction(() => {
      for (const id of new Set(ids)) stmt.run(now, platform, id, now);
    });
  }

  /**
   * Stored jobs whose `field` falls in [since, until), newest first, for the weekly summaries. `description` is only read when
   * asked (the length is always known), so a listing without text does not pull every description out of SQLite.
   */
  listJobs(filter: JobListFilter): { rows: ListedJobRow[]; total: number } {
    const column = JOB_DATE_COLUMNS[filter.field];
    const where = [`${column} >= ?`, `${column} < ?`];
    const params: (string | number)[] = [filter.since, filter.until];
    if (filter.sources.length > 0) {
      where.push(`platform IN (${filter.sources.map(() => '?').join(', ')})`);
      params.push(...filter.sources);
    }
    if (filter.boards.length > 0) {
      where.push(`board IN (${filter.boards.map(() => '?').join(', ')})`);
      params.push(...filter.boards);
    }
    const condition = where.join(' AND ');
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${condition}`).get(...params) as Rows | undefined)?.['n'] ?? 0,
    );
    const columns = `platform, id, first_seen, fetched_at, last_seen, title, company, location, board, url, length(description) AS description_chars${
      filter.withDescription ? ', description' : ", '' AS description"
    }`;
    const rows = this.db
      .prepare(`SELECT ${columns} FROM jobs WHERE ${condition} ORDER BY ${column} DESC, platform, id LIMIT ?`)
      .all(...params, filter.limit) as Rows[];
    return {
      rows: rows.map((row) => ({ ...toJob(row), platform: String(row['platform']), descriptionChars: Number(row['description_chars']) })),
      total,
    };
  }

  countJobs(platform?: string): number {
    const row = (
      platform === undefined
        ? this.db.prepare('SELECT count(*) AS n FROM jobs').get()
        : this.db.prepare('SELECT count(*) AS n FROM jobs WHERE platform = ?').get(platform)
    ) as Rows | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /** Delete what is past retention. Returns how many rows went. */
  prune(now: number): { calls: number; usage: number; jobs: number } {
    const jobs = Number(this.db.prepare('DELETE FROM jobs WHERE last_seen < ?').run(now - this.jobRetentionMs).changes);
    const calls = Number(this.db.prepare('DELETE FROM call_log WHERE ts < ?').run(now - CALL_LOG_RETENTION_MS).changes);
    const usage = Number(this.db.prepare('DELETE FROM usage WHERE ts < ?').run(now - USAGE_RETENTION_MS).changes);
    return { calls, usage, jobs };
  }

  /** Safe to call more than once (shutdown can be triggered by two signals). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export interface NewJobRow {
  id: string;
  board?: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string;
  description: string;
}

/** Which timestamp of a job a date range applies to. */
export const JOB_DATE_COLUMNS = { first_seen: 'first_seen', fetched_at: 'fetched_at', last_seen: 'last_seen' } as const;

export interface JobListFilter {
  field: keyof typeof JOB_DATE_COLUMNS;
  /** Milliseconds, inclusive. */
  since: number;
  /** Milliseconds, exclusive. */
  until: number;
  /** Empty = every source / board. */
  sources: readonly string[];
  boards: readonly string[];
  /** Most rows returned; `total` still counts them all. */
  limit: number;
  withDescription: boolean;
}

export interface ListedJobRow extends StoredJobRow {
  platform: string;
  descriptionChars: number;
}

export interface StoredJobRow extends NewJobRow {
  firstSeen: number;
  fetchedAt: number;
  lastSeen: number;
}

function toJob(row: Rows): StoredJobRow {
  const nullable = (value: number | string | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row['id']),
    title: nullable(row['title']),
    company: nullable(row['company']),
    location: nullable(row['location']),
    board: nullable(row['board']),
    url: String(row['url']),
    description: String(row['description']),
    firstSeen: Number(row['first_seen']),
    fetchedAt: Number(row['fetched_at']),
    lastSeen: Number(row['last_seen']),
  };
}

function toBreaker(row: Rows): BreakerRow {
  return {
    platform: String(row['platform']),
    reason: row['reason'] as BreakerReason,
    openedAt: Number(row['opened_at']),
    until: row['until_ts'] === null ? null : Number(row['until_ts']),
  };
}
