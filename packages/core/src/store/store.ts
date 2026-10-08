import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SearchRecord } from '@jobwatch/sdk';
import { findSalaryRange, slugify } from '@jobwatch/sdk';

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
  /** What the dashboard shows of the call beyond the fields above; absent for a call that never got that far. */
  detail?: CallDetailRecord;
}

/** The part of a call's history that lives in the `detail` column: counts, and the validated arguments capped by the caller. */
export interface CallDetailRecord {
  startedAt: number;
  unitsReserved: number;
  unitsSpent: number;
  responseBytes: number;
  estimatedTokens: number;
  warnings: number;
  params: Record<string, unknown> | null;
  paramsTruncated: boolean;
  jobText: { available: number; returned: number } | null;
}

/** Retention: usage events only need to cover the longest rate window with margin. */
/** The call log is kept `CALL_LOG_RETENTION_DAYS` (default 30), parameters included. */
export const DEFAULT_CALL_LOG_RETENTION_DAYS = 30;
export const USAGE_RETENTION_MS = 2 * 24 * 3600 * 1000;
/** Stored job postings: kept `JOB_RETENTION_DAYS` (default 30) from the last time they were seen. */
export const DEFAULT_JOB_RETENTION_DAYS = 30;
export const MAX_JOB_DESCRIPTION_CHARS = 20_000;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Each entry upgrades the schema by one version (`PRAGMA user_version`). Never edit a released migration: add a new one.
 * Migration 2 adds the `jobs` table, 3 its `last_seen` column, 4 its `board` column, 5 the search history (`search_runs`, `search_hits`),
 * 6 the per-tool daily totals (`tool_usage_daily`), 7 the salary columns of `jobs`, 8 the adapters' key-value memory (`platform_memory`),
 * 9 the keyword list of a search and the jobs it excluded, 10 its disallowed terms and the term that dropped each job,
 * 11 the title of a dropped job, 12 the detail of a call (its parameters among it), 13 the company lookups and the company-to-board map, 14 the log of LinkedIn place lookups, 15 the adapters written on the dashboard (`custom_adapters`) and the log of their changes, 16 the board of a search (`search_runs.board`).
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
  // 9: a search's keywords are a LIST (any of them matches). `keywords` is that list as JSON, in the order it was given; `keywords_key` is
  // the same list lower-cased and sorted, so two orderings of the same keywords are one search. `search_hits.excluded` marks the jobs the
  // search dropped because of a disallowed term or a salary floor. The old `query` text is split into the list by the backfill.
  `
  ALTER TABLE search_runs ADD COLUMN keywords     TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE search_runs ADD COLUMN keywords_key TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE search_hits ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX search_runs_platform_keywords ON search_runs (platform, keywords_key);
  `,
  // 10: a search is its keywords AND its disallowed terms (the same keywords with other terms keeps other jobs). `disallowed` is the list as
  // JSON and `disallowed_key` the same list lower-cased and sorted. A job a search dropped keeps the reason and the term that did it.
  `
  ALTER TABLE search_runs ADD COLUMN disallowed     TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE search_runs ADD COLUMN disallowed_key TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE search_hits ADD COLUMN excluded_reason TEXT;
  ALTER TABLE search_hits ADD COLUMN excluded_term   TEXT;
  DROP INDEX search_runs_platform_keywords;
  CREATE INDEX search_runs_search ON search_runs (platform, keywords_key, disallowed_key);
  `,
  // 11: the title of a job a search dropped. A job dropped by its title is never stored, so without this its hit would have no title.
  `
  ALTER TABLE search_hits ADD COLUMN excluded_title TEXT;
  `,
  // 12: what the dashboard shows of a call beyond the row above (units, bytes, tokens, warnings, the capped parameters), as JSON, so the call
  // log survives a restart. Null for a call made before this migration. Deleted with its row, after CALL_LOG_RETENTION_DAYS.
  `
  ALTER TABLE call_log ADD COLUMN detail TEXT;
  `,
  // 13: ATS discovery. ats_lookups is the log of what a company lookup found (matches as JSON: ats, handle, jobs, board page);
  // company_boards is the operator's map of a company to its board on an ATS, read first by every ATS tool. company_key is the slug
  // of the name, so "Société Générale" and "societe-generale" are one company.
  `
  CREATE TABLE ats_lookups (
    id      INTEGER PRIMARY KEY,
    ts      INTEGER NOT NULL,
    company TEXT    NOT NULL,
    tried   TEXT    NOT NULL,
    matches TEXT    NOT NULL
  );
  CREATE INDEX ats_lookups_ts ON ats_lookups (ts);

  CREATE TABLE company_boards (
    id          INTEGER PRIMARY KEY,
    company_key TEXT    NOT NULL,
    company     TEXT    NOT NULL,
    ats         TEXT    NOT NULL,
    handle      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (company_key, ats)
  );
  `,
  // 14: the log of LinkedIn place lookups (a linkedin_locations query, or a search that looked a place name up by itself); hits as JSON.
  `
  CREATE TABLE place_lookups (
    id     INTEGER PRIMARY KEY,
    ts     INTEGER NOT NULL,
    query  TEXT    NOT NULL,
    hits   TEXT    NOT NULL
  );
  CREATE INDEX place_lookups_ts ON place_lookups (ts);
  `,
  // 15: the adapters an operator writes on the dashboard: a handle (the id is custom-<handle>), the kind of context the script gets, the
  // one host it may reach, and the script. custom_adapter_events is who changed what and when (the script itself is not kept in it,
  // only its hash), so a change can be traced; it outlives the adapter it is about.
  `
  CREATE TABLE custom_adapters (
    handle     TEXT PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('http', 'browser')),
    url        TEXT    NOT NULL,
    script     TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE custom_adapter_events (
    id      INTEGER PRIMARY KEY,
    ts      INTEGER NOT NULL,
    handle  TEXT    NOT NULL,
    actor   TEXT    NOT NULL,
    action  TEXT    NOT NULL,
    sha256  TEXT
  );
  CREATE INDEX custom_adapter_events_handle ON custom_adapter_events (handle, id);
  `,
  // 16: a search of a company-board tool is one per board: the board (the company handle, lower case) is part of its identity, so
  // "react" on Ashby's pennylane and "react" on Ashby's doctolib are two searches. '' for a platform that is one big board (LinkedIn,
  // Apec) and for what was recorded before this migration, which mixed the boards of a call.
  `
  ALTER TABLE search_runs ADD COLUMN board TEXT NOT NULL DEFAULT '';
  DROP INDEX search_runs_search;
  CREATE INDEX search_runs_search ON search_runs (platform, board, keywords_key, disallowed_key);
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
    private readonly callLogRetentionMs: number,
  ) {}

  /** `path` may be `:memory:` (tests). A file is created with mode 0600 together with its parent directory. */
  static open(path: string, options: { jobRetentionDays?: number; callLogRetentionDays?: number } = {}): Store {
    const days = options.jobRetentionDays ?? DEFAULT_JOB_RETENTION_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new StoreError('jobRetentionDays must be a whole number of days between 1 and 3650');
    const callDays = options.callLogRetentionDays ?? DEFAULT_CALL_LOG_RETENTION_DAYS;
    if (!Number.isInteger(callDays) || callDays < 1 || callDays > 3650)
      throw new StoreError('callLogRetentionDays must be a whole number of days between 1 and 3650');
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
      if (before > 0 && before < 9) Store.backfillSearchKeywords(db);
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (cause) {
      db.close();
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(`Cannot prepare the database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    return new Store(db, days * 24 * 3600 * 1000, callDays * 24 * 3600 * 1000);
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

  /**
   * Split the `query` text of the searches recorded before migration 9 into the keyword list: on a LinkedIn `OR` and on a pipe, the two
   * ways the old text joined several keywords. One pass, once.
   */
  private static backfillSearchKeywords(db: DatabaseSync): void {
    const update = db.prepare('UPDATE search_runs SET keywords = ?, keywords_key = ? WHERE id = ?');
    const rows = db.prepare("SELECT id, query FROM search_runs WHERE query <> ''").all() as Rows[];
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const list = normalizeKeywords(String(row['query']).split(/\s+OR\s+|\s*\|\s*/));
        update.run(JSON.stringify(list), keywordsKey(list), Number(row['id']));
      }
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

  // ------------------------------------------------------------------------------------------- ATS discovery

  /** Log one company lookup. The log is kept as long as the call log (`prune`), and at most MAX_ATS_LOOKUPS rows. */
  recordLookup(lookup: { company: string; tried: readonly string[]; matches: readonly CompanyBoardLookupMatch[] }, now: number): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO ats_lookups (ts, company, tried, matches) VALUES (?, ?, ?, ?)')
        .run(now, lookup.company.slice(0, 300), JSON.stringify(lookup.tried.slice(0, 20)), JSON.stringify(lookup.matches.slice(0, 20)));
      this.db
        .prepare('DELETE FROM ats_lookups WHERE id IN (SELECT id FROM ats_lookups ORDER BY id DESC LIMIT -1 OFFSET ?)')
        .run(MAX_ATS_LOOKUPS);
    });
  }

  /** The lookups, newest first. */
  listLookups(limit: number, offset: number): { rows: AtsLookup[]; total: number } {
    const total = Number((this.db.prepare('SELECT count(*) AS n FROM ats_lookups').get() as Rows | undefined)?.['n'] ?? 0);
    const rows = this.db
      .prepare('SELECT id, ts, company, tried, matches FROM ats_lookups ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Rows[];
    return {
      total,
      rows: rows.map((row) => ({
        id: Number(row['id']),
        ts: Number(row['ts']),
        company: String(row['company']),
        tried: JSON.parse(String(row['tried'])) as string[],
        matches: JSON.parse(String(row['matches'])) as CompanyBoardLookupMatch[],
      })),
    };
  }

  /** The handle mapped to a company on an ATS, or null. */
  findCompanyBoard(company: string, ats: string): string | null {
    const key = slugify(company);
    if (key === '') return null;
    const row = this.db.prepare('SELECT handle FROM company_boards WHERE company_key = ? AND ats = ?').get(key, ats) as Rows | undefined;
    return row === undefined ? null : String(row['handle']);
  }

  /** Map a company to a board. Returns null when the company already has a board on that ATS (delete it first to change it). */
  addCompanyBoard(entry: { company: string; ats: string; handle: string }, now: number): CompanyBoard | null {
    const company = entry.company.trim().slice(0, 120);
    const key = slugify(company);
    if (key === '') throw new StoreError('the company needs a name');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(entry.ats)) throw new StoreError('invalid ATS name');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(entry.handle)) throw new StoreError('invalid board handle');
    const result = this.db
      .prepare('INSERT OR IGNORE INTO company_boards (company_key, company, ats, handle, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, company, entry.ats, entry.handle, now);
    if (Number(result.changes) === 0) return null;
    return { id: Number(result.lastInsertRowid), company, ats: entry.ats, handle: entry.handle, createdAt: now };
  }

  /** The mapped companies, A to Z; `q` keeps those whose name or board handle contains it. */
  listCompanyBoards(filter: { q?: string; ats?: string; limit: number; offset: number }): { rows: CompanyBoard[]; total: number } {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];
    if (filter.q !== undefined && filter.q.trim() !== '') {
      const like = `%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push("(company LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (filter.ats !== undefined) {
      where.push('ats = ?');
      params.push(filter.ats);
    }
    const condition = where.join(' AND ');
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM company_boards WHERE ${condition}`).get(...params) as Rows | undefined)?.['n'] ?? 0,
    );
    const rows = this.db
      .prepare(
        `SELECT id, company, ats, handle, created_at FROM company_boards WHERE ${condition} ORDER BY company COLLATE NOCASE, ats LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as Rows[];
    return {
      total,
      rows: rows.map((row) => ({
        id: Number(row['id']),
        company: String(row['company']),
        ats: String(row['ats']),
        handle: String(row['handle']),
        createdAt: Number(row['created_at']),
      })),
    };
  }

  /** Forget a mapping. False when there was none. */
  deleteCompanyBoard(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM company_boards WHERE id = ?').run(id).changes) > 0;
  }

  // ----------------------------------------------------------------------------------------------- custom adapters

  listCustomAdapters(): CustomAdapterRow[] {
    return (this.db.prepare('SELECT * FROM custom_adapters ORDER BY name COLLATE NOCASE, handle').all() as Rows[]).map(toCustomAdapter);
  }

  getCustomAdapter(handle: string): CustomAdapterRow | null {
    const row = this.db.prepare('SELECT * FROM custom_adapters WHERE handle = ?').get(handle) as Rows | undefined;
    return row === undefined ? null : toCustomAdapter(row);
  }

  /** Create or replace an adapter; every change is logged with who made it. Returns false when `create` finds the handle taken. */
  saveCustomAdapter(
    entry: { handle: string; name: string; kind: 'http' | 'browser'; url: string; script: string },
    options: { create: boolean; actor: string },
    now: number,
  ): boolean {
    if (!CUSTOM_HANDLE.test(entry.handle)) throw new StoreError('invalid custom adapter handle');
    if (entry.name.trim() === '' || entry.name.length > 60) throw new StoreError('the name is 1 to 60 characters');
    if (entry.script.length > MAX_CUSTOM_SCRIPT_CHARS) throw new StoreError('the script is too long');
    return this.transaction(() => {
      const exists = this.getCustomAdapter(entry.handle) !== null;
      if (options.create === exists) return false;
      if (exists)
        this.db
          .prepare('UPDATE custom_adapters SET name = ?, kind = ?, url = ?, script = ?, updated_at = ? WHERE handle = ?')
          .run(entry.name.trim(), entry.kind, entry.url, entry.script, now, entry.handle);
      else
        this.db
          .prepare(
            'INSERT INTO custom_adapters (handle, name, kind, url, script, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
          )
          .run(entry.handle, entry.name.trim(), entry.kind, entry.url, entry.script, now, now);
      this.logCustomEvent(
        entry.handle,
        options.actor,
        exists ? 'updated' : 'created',
        createHash('sha256').update(entry.script).digest('hex'),
        now,
      );
      return true;
    });
  }

  setCustomAdapterEnabled(handle: string, enabled: boolean, actor: string, now: number): boolean {
    return this.transaction(() => {
      const changed = Number(
        this.db.prepare('UPDATE custom_adapters SET enabled = ?, updated_at = ? WHERE handle = ?').run(enabled ? 1 : 0, now, handle)
          .changes,
      );
      if (changed > 0) this.logCustomEvent(handle, actor, enabled ? 'enabled' : 'disabled', null, now);
      return changed > 0;
    });
  }

  deleteCustomAdapter(handle: string, actor: string, now: number): boolean {
    return this.transaction(() => {
      const changed = Number(this.db.prepare('DELETE FROM custom_adapters WHERE handle = ?').run(handle).changes);
      if (changed > 0) this.logCustomEvent(handle, actor, 'deleted', null, now);
      return changed > 0;
    });
  }

  customAdapterEvents(handle: string, limit: number): CustomAdapterEvent[] {
    const rows = this.db
      .prepare('SELECT ts, actor, action, sha256 FROM custom_adapter_events WHERE handle = ? ORDER BY id DESC LIMIT ?')
      .all(handle, limit) as Rows[];
    return rows.map((row) => ({
      ts: Number(row['ts']),
      actor: String(row['actor']),
      action: String(row['action']),
      sha256: row['sha256'] === null ? null : String(row['sha256']),
    }));
  }

  private logCustomEvent(handle: string, actor: string, action: string, sha256: string | null, now: number): void {
    this.db
      .prepare('INSERT INTO custom_adapter_events (ts, handle, actor, action, sha256) VALUES (?, ?, ?, ?, ?)')
      .run(now, handle, actor.slice(0, 120), action, sha256);
  }

  // ------------------------------------------------------------------------------------------ LinkedIn places

  /** Log one place lookup (newest kept, at most MAX_PLACE_LOOKUPS rows; dropped with the call log). */
  recordPlaceLookup(lookup: { query: string; hits: readonly { id: string; label: string }[] }, now: number): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO place_lookups (ts, query, hits) VALUES (?, ?, ?)')
        .run(now, lookup.query.slice(0, 100), JSON.stringify(lookup.hits.slice(0, 10)));
      this.db
        .prepare('DELETE FROM place_lookups WHERE id IN (SELECT id FROM place_lookups ORDER BY id DESC LIMIT -1 OFFSET ?)')
        .run(MAX_PLACE_LOOKUPS);
    });
  }

  /** The place lookups, newest first. */
  listPlaceLookups(limit: number, offset: number): { rows: PlaceLookup[]; total: number } {
    const total = Number((this.db.prepare('SELECT count(*) AS n FROM place_lookups').get() as Rows | undefined)?.['n'] ?? 0);
    const rows = this.db
      .prepare('SELECT id, ts, query, hits FROM place_lookups ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Rows[];
    return {
      total,
      rows: rows.map((row) => ({
        id: Number(row['id']),
        ts: Number(row['ts']),
        query: String(row['query']),
        hits: JSON.parse(String(row['hits'])) as { id: string; label: string }[],
      })),
    };
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
        'INSERT INTO call_log (ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        call.ts,
        call.requestId,
        call.tool,
        call.adapter,
        call.platform,
        call.outcome,
        call.durationMs,
        call.argsHash,
        call.detail === undefined ? null : JSON.stringify(call.detail),
      );
  }

  /**
   * The last `limit` calls that kept their detail, oldest first, to fill the dashboard's call log again after a restart. A call from
   * before the detail was stored, or one with a damaged detail, is left out. Only what retention has not deleted yet.
   */
  restoreCalls(limit: number): (CallRecord & { detail: CallDetailRecord })[] {
    const rows = this.db
      .prepare(
        'SELECT ts, request_id, tool, adapter, platform, outcome, duration_ms, args_hash, detail FROM call_log WHERE detail IS NOT NULL ORDER BY id DESC LIMIT ?',
      )
      .all(Math.max(1, Math.min(limit, 10_000))) as unknown as Rows[];
    const out: (CallRecord & { detail: CallDetailRecord })[] = [];
    for (const row of rows.reverse()) {
      const detail = parseCallDetail(row['detail']);
      if (detail === null) continue;
      out.push({
        ts: Number(row['ts']),
        requestId: String(row['request_id']),
        tool: String(row['tool']),
        adapter: String(row['adapter']),
        platform: String(row['platform']),
        outcome: String(row['outcome']),
        durationMs: Number(row['duration_ms']),
        argsHash: String(row['args_hash']),
        detail,
      });
    }
    return out;
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
      const exactTerms = filter.search.disallowed !== undefined;
      where.push(
        `EXISTS (SELECT 1 FROM search_hits h JOIN search_runs r ON r.id = h.run_id WHERE h.job_id = jobs.id AND r.platform = jobs.platform AND r.keywords_key = ?${
          exactTerms ? ' AND r.disallowed_key = ?' : ''
        })`,
      );
      params.push(keywordsKey(normalizeKeywords(filter.search.keywords)));
      if (filter.search.disallowed !== undefined) params.push(keywordsKey(normalizeTerms(filter.search.disallowed)));
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
   * Remember one search: its keyword list (trimmed, lower-cased, capped; empty = no keyword, as for a whole-board listing) and the ids it
   * listed. `found` and `returned` are the real counts; at most MAX_SEARCH_HITS ids are kept, the returned ones first, then the excluded.
   */
  recordSearch(platform: string, search: SearchRecord, now: number): void {
    const keywords = normalizeKeywords(search.keywords);
    const disallowed = normalizeTerms(search.disallowed);
    const board = (search.board ?? '').slice(0, 120);
    const returned = new Set(search.returned);
    const dropped = new Map(search.excluded.map((entry) => [entry.id, entry] as const));
    const found = [...new Set(search.found)];
    const kept = [
      ...found.filter((id) => returned.has(id)),
      ...found.filter((id) => !returned.has(id) && dropped.has(id)),
      ...found.filter((id) => !returned.has(id) && !dropped.has(id)),
    ].slice(0, MAX_SEARCH_HITS);
    this.transaction(() => {
      const run = this.db
        .prepare(
          'INSERT INTO search_runs (ts, platform, board, query, keywords, keywords_key, disallowed, disallowed_key, found, returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          now,
          platform,
          board,
          keywords.join(' | '),
          JSON.stringify(keywords),
          keywordsKey(keywords),
          JSON.stringify(disallowed),
          keywordsKey(disallowed),
          found.length,
          returned.size,
        );
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO search_hits (run_id, job_id, returned, excluded, excluded_reason, excluded_term, excluded_title) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const id of kept) {
        if (!JOB_ID.test(id)) continue;
        const why = returned.has(id) ? undefined : dropped.get(id);
        insert.run(
          Number(run.lastInsertRowid),
          id,
          returned.has(id) ? 1 : 0,
          why === undefined ? 0 : 1,
          why?.reason ?? null,
          why === undefined ? null : why.term.slice(0, MAX_TERM_CHARS),
          why?.title === undefined || why.title === null ? null : why.title.slice(0, 300),
        );
      }
    });
  }

  /** Per search (a platform, its board, its keyword list and its disallowed terms), over [since, until): runs, and the distinct jobs it matched, returned, dropped and found first. */
  searchStats(filter: { since: number; until: number; platform?: string; board?: string; limit: number }): SearchStat[] {
    const rows = this.db
      .prepare(
        `SELECT r.platform AS platform, r.board AS board, r.keywords_key AS keywords_key, r.disallowed_key AS disallowed_key,
                count(DISTINCT r.id) AS runs, min(r.ts) AS first_run, max(r.ts) AS last_run,
                count(DISTINCT h.job_id) AS jobs_found,
                count(DISTINCT CASE WHEN h.returned = 1 THEN h.job_id END) AS jobs_returned,
                count(DISTINCT CASE WHEN h.excluded = 1 THEN h.job_id END) AS jobs_excluded,
                count(DISTINCT CASE WHEN j.first_seen >= ? THEN h.job_id END) AS jobs_new
         FROM search_runs r
         LEFT JOIN search_hits h ON h.run_id = r.id
         LEFT JOIN jobs j ON j.platform = r.platform AND j.id = h.job_id
         WHERE r.ts >= ? AND r.ts < ? ${filter.platform === undefined ? '' : 'AND r.platform = ?'} ${filter.board === undefined ? '' : 'AND r.board = ?'}
         GROUP BY r.platform, r.board, r.keywords_key, r.disallowed_key
         ORDER BY jobs_found DESC, runs DESC, r.platform, r.board, r.keywords_key, r.disallowed_key
         LIMIT ?`,
      )
      .all(
        ...[
          filter.since,
          filter.since,
          filter.until,
          ...(filter.platform === undefined ? [] : [filter.platform]),
          ...(filter.board === undefined ? [] : [filter.board]),
          filter.limit,
        ],
      ) as Rows[];
    return rows.map((row) => ({
      platform: String(row['platform']),
      board: boardOf(row['board']),
      keywords: parseKeywords(row['keywords_key']),
      disallowed: parseKeywords(row['disallowed_key']),
      runs: Number(row['runs']),
      firstRun: Number(row['first_run']),
      lastRun: Number(row['last_run']),
      jobsFound: Number(row['jobs_found']),
      jobsReturned: Number(row['jobs_returned']),
      jobsExcluded: Number(row['jobs_excluded']),
      jobsNew: Number(row['jobs_new']),
    }));
  }

  /** The searches (keywords and disallowed terms, lower case, sorted) that listed each of these jobs, within the history that is kept. */
  foundBy(platform: string, ids: readonly string[]): Map<string, SearchRef[]> {
    const out = new Map<string, SearchRef[]>();
    const stmt = this.db.prepare(
      `SELECT DISTINCT r.board AS board, r.keywords_key AS keywords_key, r.disallowed_key AS disallowed_key FROM search_hits h JOIN search_runs r ON r.id = h.run_id
       WHERE r.platform = ? AND h.job_id = ? ORDER BY r.board, r.keywords_key, r.disallowed_key`,
    );
    for (const id of new Set(ids)) {
      const searches = (stmt.all(platform, id) as Rows[]).map((row) => ({
        board: boardOf(row['board']),
        keywords: parseKeywords(row['keywords_key']),
        disallowed: parseKeywords(row['disallowed_key']),
      }));
      if (searches.length > 0) out.set(id, searches);
    }
    return out;
  }

  /** The counts of one search over a window, or null when it did not run in it. */
  private searchSummary(
    platform: string,
    board: string,
    keywordsK: string,
    disallowedK: string,
    since: number,
    until: number,
  ): SearchStat | null {
    const row = this.db
      .prepare(
        `SELECT count(DISTINCT r.id) AS runs, min(r.ts) AS first_run, max(r.ts) AS last_run,
                count(DISTINCT h.job_id) AS jobs_found,
                count(DISTINCT CASE WHEN h.returned = 1 THEN h.job_id END) AS jobs_returned,
                count(DISTINCT CASE WHEN h.excluded = 1 THEN h.job_id END) AS jobs_excluded,
                count(DISTINCT CASE WHEN j.first_seen >= ? THEN h.job_id END) AS jobs_new
         FROM search_runs r
         LEFT JOIN search_hits h ON h.run_id = r.id
         LEFT JOIN jobs j ON j.platform = r.platform AND j.id = h.job_id
         WHERE r.platform = ? AND r.board = ? AND r.keywords_key = ? AND r.disallowed_key = ? AND r.ts >= ? AND r.ts < ?`,
      )
      .get(since, platform, board, keywordsK, disallowedK, since, until) as Rows | undefined;
    if (row === undefined || Number(row['runs']) === 0) return null;
    return {
      platform,
      board: boardOf(board),
      keywords: parseKeywords(keywordsK),
      disallowed: parseKeywords(disallowedK),
      runs: Number(row['runs']),
      firstRun: Number(row['first_run']),
      lastRun: Number(row['last_run']),
      jobsFound: Number(row['jobs_found']),
      jobsReturned: Number(row['jobs_returned']),
      jobsExcluded: Number(row['jobs_excluded']),
      jobsNew: Number(row['jobs_new']),
    };
  }

  /**
   * One search (a platform, its board, its keywords and its disallowed terms, any order or case): when it ran, what it matched, and the jobs, those
   * it returned first, then those it dropped (each with the term that did it). `since` and `until` narrow the runs counted.
   */
  searchDetail(
    platform: string,
    keywords: readonly string[],
    disallowed: readonly string[],
    options: { limit: number; since?: number; until?: number; board?: string | null },
  ): SearchDetail | null {
    const keywordsK = keywordsKey(normalizeKeywords(keywords));
    const disallowedK = keywordsKey(normalizeTerms(disallowed));
    const since = options.since ?? 0;
    const until = options.until ?? Number.MAX_SAFE_INTEGER;
    const board = options.board ?? '';
    const summary = this.searchSummary(platform, board, keywordsK, disallowedK, since, until);
    if (summary === null) return null;
    const rows = this.db
      .prepare(
        `SELECT h.job_id AS id, max(h.returned) AS returned, max(h.excluded) AS excluded, count(DISTINCT r.id) AS seen,
                max(h.excluded_reason) AS excluded_reason, max(h.excluded_term) AS excluded_term, max(h.excluded_title) AS excluded_title,
                j.id AS stored_id, j.title AS stored_title, j.company AS company, j.location AS location, j.url AS url, j.last_seen AS last_seen
         FROM search_runs r
         JOIN search_hits h ON h.run_id = r.id
         LEFT JOIN jobs j ON j.platform = r.platform AND j.id = h.job_id
         WHERE r.platform = ? AND r.board = ? AND r.keywords_key = ? AND r.disallowed_key = ? AND r.ts >= ? AND r.ts < ?
         GROUP BY h.job_id
         ORDER BY max(h.returned) DESC, max(h.excluded) DESC, max(j.last_seen) DESC, h.job_id
         LIMIT ?`,
      )
      .all(platform, board, keywordsK, disallowedK, since, until, options.limit) as Rows[];
    const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
    return {
      ...summary,
      jobs: rows.map((row) => {
        const returned = Number(row['returned']) === 1;
        const dropped = !returned && Number(row['excluded']) === 1;
        return {
          id: String(row['id']),
          // the stored job's title, else the one kept with the hit when the search dropped it
          title: text(row['stored_title']) ?? text(row['excluded_title']),
          stored: row['stored_id'] !== null && row['stored_id'] !== undefined,
          company: text(row['company']),
          location: text(row['location']),
          url: text(row['url']),
          lastSeen: row['last_seen'] === null || row['last_seen'] === undefined ? null : Number(row['last_seen']),
          outcome: returned ? 'returned' : dropped ? 'excluded' : 'other',
          excludedBy: dropped ? excludedBy(row) : null,
          timesListed: Number(row['seen']),
        };
      }),
    };
  }

  /**
   * Every search that listed one job, with the counts of that search and what happened to this job in it (returned, or dropped by which
   * term). Within the history that is kept; the most recently run first.
   */
  jobSearches(platform: string, id: string): JobSearch[] {
    const groups = this.db
      .prepare(
        `SELECT r.board AS board, r.keywords_key AS keywords_key, r.disallowed_key AS disallowed_key, max(h.returned) AS returned, max(h.excluded) AS excluded,
                max(h.excluded_reason) AS excluded_reason, max(h.excluded_term) AS excluded_term, max(r.ts) AS last_run
         FROM search_hits h JOIN search_runs r ON r.id = h.run_id
         WHERE r.platform = ? AND h.job_id = ?
         GROUP BY r.board, r.keywords_key, r.disallowed_key
         ORDER BY last_run DESC, r.board, r.keywords_key, r.disallowed_key`,
      )
      .all(platform, id) as Rows[];
    const out: JobSearch[] = [];
    for (const group of groups) {
      const stat = this.searchSummary(
        platform,
        String(group['board']),
        String(group['keywords_key']),
        String(group['disallowed_key']),
        0,
        Number.MAX_SAFE_INTEGER,
      );
      if (stat === null) continue;
      const returned = Number(group['returned']) === 1;
      const dropped = !returned && Number(group['excluded']) === 1;
      out.push({
        ...stat,
        outcome: returned ? 'returned' : dropped ? 'excluded' : 'other',
        excludedBy: dropped ? excludedBy(group) : null,
      });
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
    const calls = Number(this.db.prepare('DELETE FROM call_log WHERE ts < ?').run(now - this.callLogRetentionMs).changes);
    this.db.prepare('DELETE FROM ats_lookups WHERE ts < ?').run(now - this.callLogRetentionMs);
    this.db.prepare('DELETE FROM place_lookups WHERE ts < ?').run(now - this.callLogRetentionMs);
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

/** The handle of a custom adapter; its module id is `custom-<handle>`. */
export const CUSTOM_HANDLE = /^[a-z][a-z0-9]{1,23}$/;
export const MAX_CUSTOM_SCRIPT_CHARS = 60_000;

/** An adapter written on the dashboard. */
export interface CustomAdapterRow {
  handle: string;
  name: string;
  kind: 'http' | 'browser';
  /** The one https address the script may reach; its host is the adapter's allowed host. */
  url: string;
  script: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CustomAdapterEvent {
  ts: number;
  actor: string;
  action: string;
  sha256: string | null;
}

const toCustomAdapter = (row: Rows): CustomAdapterRow => ({
  handle: String(row['handle']),
  name: String(row['name']),
  kind: row['kind'] === 'browser' ? 'browser' : 'http',
  url: String(row['url']),
  script: String(row['script']),
  enabled: Number(row['enabled']) === 1,
  createdAt: Number(row['created_at']),
  updatedAt: Number(row['updated_at']),
});

/** Lookups kept in the LinkedIn places log. */
const MAX_PLACE_LOOKUPS = 2000;
/** Lookups kept in the ATS discovery log. */
const MAX_ATS_LOOKUPS = 2000;

export type { SearchRecord };

/** One board a company lookup found, as the log keeps it. */
export interface CompanyBoardLookupMatch {
  ats: string;
  handle: string;
  jobs: number;
  boardUrl: string;
}

export interface AtsLookup {
  id: number;
  ts: number;
  company: string;
  tried: string[];
  matches: CompanyBoardLookupMatch[];
}

export interface PlaceLookup {
  id: number;
  ts: number;
  query: string;
  hits: { id: string; label: string }[];
}

/** A company the operator mapped to its board on an ATS. */
export interface CompanyBoard {
  id: number;
  company: string;
  ats: string;
  handle: string;
  createdAt: number;
}

/** A search as a job lists it: its keywords and its disallowed terms, lower case and sorted. */
export interface SearchRef {
  /** The company board the search read (an ATS handle, lower case), or null for a platform that is one big board and for searches recorded before boards were kept. */
  board: string | null;
  keywords: string[];
  disallowed: string[];
}

/** Why a job was dropped: where the term was found, and the term (for `salary`, the salary the job states). */
export interface ExcludedBy {
  reason: 'title' | 'description' | 'salary';
  term: string;
}

export interface SearchStat extends SearchRef {
  platform: string;
  runs: number;
  firstRun: number;
  lastRun: number;
  jobsFound: number;
  jobsReturned: number;
  /** Jobs the search dropped because of a disallowed term or a salary floor. */
  jobsExcluded: number;
  jobsNew: number;
}

export interface SearchDetailJob {
  id: string;
  /** The stored job's title, else the one recorded when the search dropped it; null when neither exists (the job was evicted, or the search is older than titles). */
  title: string | null;
  /** False when the job's text is not in the database: it was dropped by its title before its page was read, or it was evicted. */
  stored: boolean;
  company: string | null;
  location: string | null;
  url: string | null;
  lastSeen: number | null;
  /** `returned` handed back to the caller, `excluded` dropped by a disallowed term or salary floor, `other` listed but not returned (a cap, only_new, a filter). */
  outcome: 'returned' | 'excluded' | 'other';
  /** For an `excluded` job: the term that dropped it, when the search recorded it (null for a search recorded before terms were kept). */
  excludedBy: ExcludedBy | null;
  timesListed: number;
}

/** A search that listed one job, with the counts of that search and what happened to the job in it. */
export interface JobSearch extends SearchStat {
  outcome: 'returned' | 'excluded' | 'other';
  excludedBy: ExcludedBy | null;
}

export interface SearchDetail extends SearchStat {
  jobs: SearchDetailJob[];
}

/** Most keywords kept for one search. */
const MAX_SEARCH_KEYWORDS = 20;

/** The board of a search as the API says it: '' is none. */
const boardOf = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));

/** The keywords of a search as stored: trimmed, single-spaced, lower case, capped, no empty entry and no duplicate. The order is kept. */
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of keywords) {
    const clean = keyword.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_SEARCH_KEYWORDS) break;
  }
  return out;
}

/** Longest disallowed term kept for a search, and most terms. */
const MAX_TERM_CHARS = 60;
const MAX_SEARCH_TERMS = 60;

/** The disallowed terms of a search as stored: trimmed, single-spaced, lower case, capped, no empty entry and no duplicate. */
export function normalizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const clean = term.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TERM_CHARS);
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_SEARCH_TERMS) break;
  }
  return out;
}

function excludedBy(row: Rows): ExcludedBy | null {
  const reason = row['excluded_reason'];
  const term = row['excluded_term'];
  if ((reason !== 'title' && reason !== 'description' && reason !== 'salary') || typeof term !== 'string') return null;
  return { reason, term };
}

/** What makes two keyword lists one search: the same keywords in any order. */
export const keywordsKey = (keywords: readonly string[]): string => JSON.stringify([...keywords].sort());

/** The detail of a stored call, or null when it is not what was written (a damaged row never stops the router from starting). */
function parseCallDetail(value: unknown): CallDetailRecord | null {
  try {
    const parsed = JSON.parse(String(value)) as Partial<CallDetailRecord> | null;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.startedAt !== 'number') return null;
    const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    const params = parsed.params;
    const text = parsed.jobText;
    return {
      startedAt: parsed.startedAt,
      unitsReserved: count(parsed.unitsReserved),
      unitsSpent: count(parsed.unitsSpent),
      responseBytes: count(parsed.responseBytes),
      estimatedTokens: count(parsed.estimatedTokens),
      warnings: count(parsed.warnings),
      params: typeof params === 'object' && params !== null && !Array.isArray(params) ? params : null,
      paramsTruncated: parsed.paramsTruncated === true,
      jobText: typeof text === 'object' && text !== null ? { available: count(text.available), returned: count(text.returned) } : null,
    };
  } catch {
    return null;
  }
}

function parseKeywords(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
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
  /**
   * Only jobs a search with exactly these keywords (any order, case-insensitive) listed; an empty list is the searches with no keyword.
   * With `disallowed`, only the search that also had exactly these disallowed terms (an empty list: none); without it, whatever its terms.
   */
  search?: { keywords: readonly string[]; disallowed?: readonly string[] };
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
