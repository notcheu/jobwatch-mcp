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

/**
 * Each entry upgrades the schema by one version (`PRAGMA user_version`). Never edit a released migration: add a new one.
 * Step 6 adds columns for cold starts and peak memory to `call_log` as migration 2.
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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

interface Rows {
  [column: string]: number | string | null;
}

/**
 * The router's only persistent state: rate-limit usage, circuit breakers and the call log (SQLite, WAL).
 * Synchronous on purpose: one process, tiny rows, and a rate check must be atomic with its decision.
 * Never stores cookies, tokens, arguments or page content: only counters, platform names and hashes.
 */
export class Store {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  /** `path` may be `:memory:` (tests). A file is created with mode 0600 together with its parent directory. */
  static open(path: string): Store {
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
    return new Store(db);
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

  /** Events of a platform newer than `sinceMs`, oldest first. */
  usageSince(platform: string, sinceMs: number): UsageEvent[] {
    const rows = this.db
      .prepare('SELECT ts, cost FROM usage WHERE platform = ? AND ts > ? ORDER BY ts ASC, id ASC')
      .all(platform, sinceMs) as unknown as Rows[];
    return rows.map((row) => ({ ts: Number(row['ts']), cost: Number(row['cost']) }));
  }

  addUsage(platform: string, ts: number, cost: number): void {
    this.db.prepare('INSERT INTO usage (platform, ts, cost) VALUES (?, ?, ?)').run(platform, ts, cost);
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

  /** Delete what is past retention. Returns how many rows went. */
  prune(now: number): { calls: number; usage: number } {
    const calls = Number(this.db.prepare('DELETE FROM call_log WHERE ts < ?').run(now - CALL_LOG_RETENTION_MS).changes);
    const usage = Number(this.db.prepare('DELETE FROM usage WHERE ts < ?').run(now - USAGE_RETENTION_MS).changes);
    return { calls, usage };
  }

  /** Safe to call more than once (shutdown can be triggered by two signals). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function toBreaker(row: Rows): BreakerRow {
  return {
    platform: String(row['platform']),
    reason: row['reason'] as BreakerReason,
    openedAt: Number(row['opened_at']),
    until: row['until_ts'] === null ? null : Number(row['until_ts']),
  };
}
