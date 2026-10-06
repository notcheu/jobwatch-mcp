import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findSalaryRange } from '@jobwatch/sdk';

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
/** Stored job postings: kept `JOB_RETENTION_DAYS` (default 30) from the last time they were seen. */
export const DEFAULT_JOB_RETENTION_DAYS = 30;
export const MAX_JOB_DESCRIPTION_CHARS = 20_000;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Each entry upgrades the schema by one version (`PRAGMA user_version`). Never edit a released migration: add a new one.
 * Migration 2 adds the `jobs` table, 3 its `last_seen` column, 4 its `board` column, 5 the search history (`search_runs`, `search_hits`),
 * 6 the per-tool daily totals (`tool_usage_daily`), 7 the salary columns of `jobs`, 8 the adapters' key-value memory (`platform_memory`).
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
  // 5: the search keywords and the job ids each search listed (what a search brought in). Evicted with the jobs, by ts.
  `
  CREATE TABLE search_runs (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    platform TEXT    NOT NULL,
    query    TEXT    NOT NULL COLLATE NOCASE,
    found    INTEGER NOT NULL,
    returned INTEGER NOT NULL
  );
  CREATE INDEX search_runs_ts ON search_runs (ts);
  CREATE INDEX search_runs_platform_query ON search_runs (platform, query);
  CREATE TABLE search_hits (
    run_id   INTEGER NOT NULL,
    job_id   TEXT    NOT NULL,
    returned INTEGER NOT NULL,
    PRIMARY KEY (run_id, job_id)
  ) WITHOUT ROWID;
  CREATE INDEX search_hits_job ON search_hits (job_id);
  `,
  // 6: what each tool did per UTC day, for the dashboard's lifetime and historical analytics: counts, bytes and durations only, never
  // parameters. Kept DAILY_USAGE_RETENTION_DAYS days.
  `
  CREATE TABLE tool_usage_daily (
    day              TEXT    NOT NULL,
    tool             TEXT    NOT NULL,
    platform         TEXT    NOT NULL,
    calls            INTEGER NOT NULL DEFAULT 0,
    errors           INTEGER NOT NULL DEFAULT 0,
    response_bytes   INTEGER NOT NULL DEFAULT 0,
    tokens           INTEGER NOT NULL DEFAULT 0,
    units            INTEGER NOT NULL DEFAULT 0,
    duration_ms      INTEGER NOT NULL DEFAULT 0,
    max_duration_ms  INTEGER NOT NULL DEFAULT 0,
    text_available   INTEGER NOT NULL DEFAULT 0,
    text_returned    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, tool)
  ) WITHOUT ROWID;
  `,
  // 7: the yearly salary a job text states (see `findSalaryRange` in the SDK), read when the job is stored. NULL when the text states none.
  `
  ALTER TABLE jobs ADD COLUMN salary_min INTEGER;
  ALTER TABLE jobs ADD COLUMN salary_max INTEGER;
  ALTER TABLE jobs ADD COLUMN salary_currency TEXT;
  ALTER TABLE jobs ADD COLUMN salary_variable INTEGER;
  CREATE INDEX jobs_salary_max ON jobs (salary_max);
  `,
  // 8: a small key-value memory adapters use (`ctx.memory`): what they looked up once and need not look up again.
  `
  CREATE TABLE platform_memory (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX platform_memory_updated ON platform_memory (updated_at);
  `,
];

/** Days of per-tool daily totals kept (docs/plans/17-dashboard.md, D8). */
export const DAILY_USAGE_RETENTION_DAYS = 400;

export const SCHEMA_VERSION = MIGRATIONS.length;

interface Rows {
  [column: string]: number | string | null;
}

/**
 * The router's only persistent state: rate-limit usage, circuit breakers and the call log (SQLite, WAL).
 * Synchronous on purpose: one process, tiny rows, and a rate check must be atomic with its decision.
 * Also holds the job postings adapters chose to remember (`jobs`: public text, retention below) and the history of searches (the
 * search keywords and the job ids each search listed). Never stores cookies, tokens, other tool arguments or raw pages: otherwise
 * only counters, platform names and hashes.
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
        `Cannot open the database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}. Is DATA_DIR writable?`,
        { cause },
      );
    }
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const before = Store.migrate(db);
      if (before < 7) Store.backfillSalaries(db);
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (cause) {
      db.close();
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(`Cannot prepare the database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    return new Store(db, days * 24 * 3600 * 1000);
  }

  /** Read the salary of the jobs stored before the salary columns existed (migration 7). One pass, once. */
  private static backfillSalaries(db: DatabaseSync): void {
    const found: (string | number | null)[][] = [];
    for (const row of db.prepare('SELECT platform, id, description FROM jobs').iterate() as Iterable<Rows>) {
      const salary = findSalaryRange(String(row['description']));
      if (salary !== null)
        found.push([salary.min, salary.max, salary.currency, salary.variable, String(row['platform']), String(row['id'])]);
    }
    const update = db.prepare(
      'UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_variable = ? WHERE platform = ? AND id = ?',
    );
    db.exec('BEGIN');
    try {
      for (const values of found) update.run(...values);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Bring the schema up to date. Returns the version the database had before. */
  private static migrate(db: DatabaseSync): number {
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
    return current;
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

  /** Add one finished call to the totals of its UTC day. Counts, bytes and durations only. */
  recordDailyUsage(call: DailyUsageDelta): void {
    this.db
      .prepare(
        `INSERT INTO tool_usage_daily (day, tool, platform, calls, errors, response_bytes, tokens, units, duration_ms, max_duration_ms, text_available, text_returned)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, tool) DO UPDATE SET
           calls = calls + 1, errors = errors + excluded.errors, response_bytes = response_bytes + excluded.response_bytes,
           tokens = tokens + excluded.tokens, units = units + excluded.units, duration_ms = duration_ms + excluded.duration_ms,
           max_duration_ms = max(max_duration_ms, excluded.max_duration_ms),
           text_available = text_available + excluded.text_available, text_returned = text_returned + excluded.text_returned`,
      )
      .run(
        new Date(call.ts).toISOString().slice(0, 10),
        call.tool,
        call.platform,
        call.error ? 1 : 0,
        call.responseBytes,
        call.tokens,
        call.units,
        call.durationMs,
        call.durationMs,
        call.textAvailable,
        call.textReturned,
      );
  }

  /** The daily totals from `fromDay` to `toDay` inclusive (YYYY-MM-DD), oldest day first. */
  dailyUsage(fromDay: string, toDay: string): DailyUsageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_usage_daily WHERE day >= ? AND day <= ? ORDER BY day, tool')
      .all(fromDay, toDay) as unknown as Rows[];
    return rows.map((row) => ({
      day: String(row['day']),
      tool: String(row['tool']),
      platform: String(row['platform']),
      calls: Number(row['calls']),
      errors: Number(row['errors']),
      responseBytes: Number(row['response_bytes']),
      tokens: Number(row['tokens']),
      units: Number(row['units']),
      durationMs: Number(row['duration_ms']),
      maxDurationMs: Number(row['max_duration_ms']),
      textAvailable: Number(row['text_available']),
      textReturned: Number(row['text_returned']),
    }));
  }

  // ------------------------------------------------------------------------------------------------ adapter memory

  getMemory(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM platform_memory WHERE key = ?').get(key) as Rows | undefined;
    return row === undefined ? null : String(row['value']);
  }

  /** Store a short text under a key. Keys and values are validated; when the memory is full the oldest entries go. */
  setMemory(key: string, value: string, now: number): void {
    if (key.length < 1 || key.length > MAX_MEMORY_KEY || [...key].some((char) => char.charCodeAt(0) < 32))
      throw new StoreError('invalid memory key');
    if (value.length > MAX_MEMORY_VALUE) throw new StoreError('memory value too long');
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO platform_memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run(key, value, now);
      this.db
        .prepare(
          'DELETE FROM platform_memory WHERE key IN (SELECT key FROM platform_memory ORDER BY updated_at DESC, key LIMIT -1 OFFSET ?)',
        )
        .run(MAX_MEMORY_ENTRIES);
    });
  }

  deleteMemory(key: string): void {
    this.db.prepare('DELETE FROM platform_memory WHERE key = ?').run(key);
  }

  listMemory(prefix: string): { key: string; value: string; updatedAt: number }[] {
    const rows = this.db
      .prepare('SELECT key, value, updated_at FROM platform_memory WHERE substr(key, 1, ?) = ? ORDER BY updated_at, key')
      .all(prefix.length, prefix) as unknown as Rows[];
    return rows.map((row) => ({ key: String(row['key']), value: String(row['value']), updatedAt: Number(row['updated_at']) }));
  }

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
    const description = job.description.slice(0, MAX_JOB_DESCRIPTION_CHARS);
    const salary = findSalaryRange(description);
    this.db
      .prepare(
        `INSERT INTO jobs (platform, id, first_seen, fetched_at, last_seen, title, company, location, board, url, description,
                           salary_min, salary_max, salary_currency, salary_variable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, id) DO UPDATE SET
           fetched_at = excluded.fetched_at, last_seen = excluded.last_seen, title = excluded.title, company = excluded.company, location = excluded.location, board = excluded.board,
           url = excluded.url, description = excluded.description,
           salary_min = excluded.salary_min, salary_max = excluded.salary_max, salary_currency = excluded.salary_currency, salary_variable = excluded.salary_variable`,
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
        description,
        salary?.min ?? null,
        salary?.max ?? null,
        salary?.currency ?? null,
        salary?.variable ?? null,
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
    if (filter.q !== undefined && filter.q.trim() !== '') {
      const like = `%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (filter.search !== undefined) {
      where.push(
        'EXISTS (SELECT 1 FROM search_hits h JOIN search_runs r ON r.id = h.run_id WHERE h.job_id = jobs.id AND r.platform = jobs.platform AND r.query = ?)',
      );
      params.push(filter.search);
    }
    if (filter.boards.length > 0) {
      where.push(`board IN (${filter.boards.map(() => '?').join(', ')})`);
      params.push(...filter.boards);
    }
    const condition = where.join(' AND ');
    const sortColumn = filter.sort === undefined ? column : JOB_SORT_COLUMNS[filter.sort];
    const direction = filter.dir === 'asc' ? 'ASC' : 'DESC';
    // a job with no salary comes last whichever way the column is sorted
    const order =
      sortColumn === 'salary_max'
        ? `salary_max IS NULL, salary_max ${direction}`
        : `${sortColumn}${sortColumn === 'title' || sortColumn === 'company' ? ' COLLATE NOCASE' : ''} ${direction}`;
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${condition}`).get(...params) as Rows | undefined)?.['n'] ?? 0,
    );
    const columns = `platform, id, first_seen, fetched_at, last_seen, title, company, location, board, url, salary_min, salary_max, salary_currency, salary_variable, length(description) AS description_chars${
      filter.withDescription ? ', description' : ", '' AS description"
    }`;
    const rows = this.db
      .prepare(`SELECT ${columns} FROM jobs WHERE ${condition} ORDER BY ${order}, platform, id LIMIT ? OFFSET ?`)
      .all(...params, filter.limit, filter.offset ?? 0) as Rows[];
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

  // ------------------------------------------------------------------------------------------------------ searches

  /**
   * Remember one search: its keywords (`query`, trimmed and capped; reported in lower case; empty = no keyword, as for a whole-board listing) and the ids it
   * listed. `found` and `returned` are the real counts; at most MAX_SEARCH_HITS ids are kept, the returned ones first.
   */
  recordSearch(platform: string, search: SearchRecord, now: number): void {
    const query = search.query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
    const returned = new Set(search.returned);
    const found = [...new Set(search.found)];
    const kept = [...found.filter((id) => returned.has(id)), ...found.filter((id) => !returned.has(id))].slice(0, MAX_SEARCH_HITS);
    this.transaction(() => {
      const run = this.db
        .prepare('INSERT INTO search_runs (ts, platform, query, found, returned) VALUES (?, ?, ?, ?, ?)')
        .run(now, platform, query, found.length, returned.size);
      const insert = this.db.prepare('INSERT OR IGNORE INTO search_hits (run_id, job_id, returned) VALUES (?, ?, ?)');
      for (const id of kept) if (JOB_ID.test(id)) insert.run(Number(run.lastInsertRowid), id, returned.has(id) ? 1 : 0);
    });
  }

  /** Per platform and keyword, over [since, until): how often it ran and how many distinct jobs it listed, returned and found first. */
  searchStats(filter: { since: number; until: number; platform?: string; limit: number }): SearchStat[] {
    const rows = this.db
      .prepare(
        `SELECT r.platform AS platform, lower(r.query) AS query, count(DISTINCT r.id) AS runs, max(r.ts) AS last_run,
                count(DISTINCT h.job_id) AS jobs_found,
                count(DISTINCT CASE WHEN h.returned = 1 THEN h.job_id END) AS jobs_returned,
                count(DISTINCT CASE WHEN j.first_seen >= ? THEN h.job_id END) AS jobs_new
         FROM search_runs r
         LEFT JOIN search_hits h ON h.run_id = r.id
         LEFT JOIN jobs j ON j.platform = r.platform AND j.id = h.job_id
         WHERE r.ts >= ? AND r.ts < ? ${filter.platform === undefined ? '' : 'AND r.platform = ?'}
         GROUP BY r.platform, lower(r.query)
         ORDER BY jobs_found DESC, runs DESC, r.platform, lower(r.query)
         LIMIT ?`,
      )
      .all(
        ...[filter.since, filter.since, filter.until, ...(filter.platform === undefined ? [] : [filter.platform]), filter.limit],
      ) as Rows[];
    return rows.map((row) => ({
      platform: String(row['platform']),
      query: String(row['query']),
      runs: Number(row['runs']),
      lastRun: Number(row['last_run']),
      jobsFound: Number(row['jobs_found']),
      jobsReturned: Number(row['jobs_returned']),
      jobsNew: Number(row['jobs_new']),
    }));
  }

  /** For each of these jobs, the distinct keywords of the searches that listed it (empty keywords left out). */
  foundBy(platform: string, ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const stmt = this.db.prepare(
      `SELECT DISTINCT lower(r.query) AS query FROM search_hits h JOIN search_runs r ON r.id = h.run_id
       WHERE r.platform = ? AND h.job_id = ? AND r.query <> '' ORDER BY lower(r.query)`,
    );
    for (const id of new Set(ids)) {
      const queries = (stmt.all(platform, id) as Rows[]).map((row) => String(row['query']));
      if (queries.length > 0) out.set(id, queries);
    }
    return out;
  }

  /**
   * Forget everything one platform stored: its jobs and its searches (with their hits), so the next call starts fresh. Usage, breaker,
   * call log and daily analytics stay: they are not job data, and wiping the usage would reset a request budget.
   */
  clearPlatform(platform: string): { jobs: number; searches: number } {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM search_hits WHERE run_id IN (SELECT id FROM search_runs WHERE platform = ?)').run(platform);
      const searches = Number(this.db.prepare('DELETE FROM search_runs WHERE platform = ?').run(platform).changes);
      const jobs = Number(this.db.prepare('DELETE FROM jobs WHERE platform = ?').run(platform).changes);
      return { jobs, searches };
    });
  }

  /** Delete what is past retention. Returns how many rows went. */
  prune(now: number): { calls: number; usage: number; jobs: number } {
    const oldRuns = now - this.jobRetentionMs;
    this.db.prepare('DELETE FROM search_hits WHERE run_id IN (SELECT id FROM search_runs WHERE ts < ?)').run(oldRuns);
    this.db.prepare('DELETE FROM search_runs WHERE ts < ?').run(oldRuns);
    const jobs = Number(this.db.prepare('DELETE FROM jobs WHERE last_seen < ?').run(now - this.jobRetentionMs).changes);
    this.db
      .prepare('DELETE FROM tool_usage_daily WHERE day < ?')
      .run(new Date(now - DAILY_USAGE_RETENTION_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10));
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

export interface DailyUsageDelta {
  ts: number;
  tool: string;
  platform: string;
  error: boolean;
  responseBytes: number;
  tokens: number;
  units: number;
  durationMs: number;
  textAvailable: number;
  textReturned: number;
}

export interface DailyUsageRow {
  day: string;
  tool: string;
  platform: string;
  calls: number;
  errors: number;
  responseBytes: number;
  tokens: number;
  units: number;
  durationMs: number;
  maxDurationMs: number;
  textAvailable: number;
  textReturned: number;
}

const MAX_QUERY_CHARS = 200;
const MAX_MEMORY_KEY = 120;
const MAX_MEMORY_VALUE = 400;
/** Entries kept in the adapters' memory, all adapters together. */
export const MAX_MEMORY_ENTRIES = 1000;
/** Ids kept per search: a board listing can hold thousands of postings, and the counts stay exact whatever is kept. */
const MAX_SEARCH_HITS = 1000;

export interface SearchRecord {
  query: string;
  found: readonly string[];
  returned: readonly string[];
}

export interface SearchStat {
  platform: string;
  query: string;
  runs: number;
  lastRun: number;
  jobsFound: number;
  jobsReturned: number;
  jobsNew: number;
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

/** Columns a job list can be sorted by (the names the dashboard sends). */
export const JOB_SORT_COLUMNS = {
  first_seen: 'first_seen',
  last_seen: 'last_seen',
  fetched_at: 'fetched_at',
  title: 'title',
  company: 'company',
  description_chars: 'description_chars',
  salary: 'salary_max',
} as const;

export interface JobListFilter {
  field: keyof typeof JOB_DATE_COLUMNS;
  /** Milliseconds, inclusive. */
  since: number;
  /** Milliseconds, exclusive. */
  until: number;
  /** Empty = every source / board. */
  sources: readonly string[];
  boards: readonly string[];
  /** Only jobs whose title, company or location contains this text (case-insensitive). */
  q?: string;
  /** Sort column (default: the date column of `field`) and direction (default newest first). */
  sort?: keyof typeof JOB_SORT_COLUMNS;
  dir?: 'asc' | 'desc';
  /** Rows to skip, for paging. */
  offset?: number;
  /** Only jobs a search with exactly these keywords (case-insensitive) listed. */
  search?: string;
  /** Most rows returned; `total` still counts them all. */
  limit: number;
  withDescription: boolean;
}

export interface ListedJobRow extends StoredJobRow {
  platform: string;
  descriptionChars: number;
}

/** The yearly salary read from a job text when it was stored. */
export interface StoredSalary {
  min: number;
  max: number;
  currency: string;
  variable: number | null;
}

export interface StoredJobRow extends NewJobRow {
  salary: StoredSalary | null;
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
    salary:
      row['salary_max'] === null || row['salary_max'] === undefined
        ? null
        : {
            min: Number(row['salary_min']),
            max: Number(row['salary_max']),
            currency: String(row['salary_currency']),
            variable: row['salary_variable'] === null ? null : Number(row['salary_variable']),
          },
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
