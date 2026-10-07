import { ANY_SEPARATOR, splitKeywords } from '@jobwatch/sdk';
import type { CallDetail, CallStart, ToolOutcome } from '../call';

/** One call as the dashboard shows it. Lives in memory only and is gone when the router restarts. */
export interface CallEntry {
  /** Increasing sequence number: the cursor for paging. */
  id: number;
  requestId: string;
  tool: string;
  adapter: string;
  platform: string;
  startedAt: number;
  /** `running` until the call settles. */
  state: 'running' | 'done';
  code: ToolOutcome['code'] | null;
  durationMs: number | null;
  argsHash: string | null;
  unitsReserved: number;
  unitsSpent: number;
  responseBytes: number;
  estimatedTokens: number;
  warnings: number;
  /** The search keywords as a list, when the tool is a search (the `keywords` or `title_any` argument; a string with OR or a pipe is split). */
  keywords: string[] | null;
  /** The validated arguments of the call (docs/plans/17-dashboard.md, D9). Only the detail view returns them. */
  params: Record<string, unknown> | null;
  paramsTruncated: boolean;
  /** true when the parameters were dropped to keep the buffer under its memory bound (the oldest go first). */
  paramsDropped: boolean;
  jobText: { available: number; returned: number } | null;
}

export interface CallQuery {
  tool?: string;
  platform?: string;
  code?: string;
  /** Only calls with a sequence number below this (the previous page's last id). */
  before?: number;
  limit: number;
}

/** The search keywords of a call from its parameters, or null. */
export function keywordsOf(params: Record<string, unknown> | null): string[] | null {
  if (params === null) return null;
  for (const name of ['keywords', 'title_any']) {
    const value = params[name];
    const entries =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((word): word is string => typeof word === 'string') : [];
    const list = splitKeywords(entries, ANY_SEPARATOR)
      .map((keyword) => keyword.slice(0, 100))
      .slice(0, 20);
    if (list.length > 0) return list;
  }
  return null;
}

/**
 * The last `capacity` calls, in memory (docs/plans/17-dashboard.md, D4). Bounded, so a busy router cannot grow it; a restart
 * empties it. The parameters of a call are kept here and nowhere else: not in the database, not in the logs.
 */
export class CallLog {
  private readonly entries: CallEntry[] = [];
  private readonly byRequest = new Map<string, CallEntry>();
  private next = 1;
  private paramsBytes = 0;
  private readonly sizes = new Map<number, number>();

  /**
   * `maxParamsBytes` bounds the memory the parameters may use in total (4 MiB by default): 2000 calls with 16 KB each would be
   * 32 MB, which the router's memory budget does not allow. Over the bound, the parameters of the oldest calls are dropped first.
   */
  constructor(
    readonly capacity = 2000,
    readonly maxParamsBytes = 4 * 1024 * 1024,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  }

  /** A call was admitted to run. */
  start(call: CallStart): void {
    this.push({
      id: this.next++,
      requestId: call.requestId,
      tool: call.tool,
      adapter: call.adapter,
      platform: call.platform,
      startedAt: call.startedAt,
      state: 'running',
      code: null,
      durationMs: null,
      argsHash: null,
      unitsReserved: 0,
      unitsSpent: 0,
      responseBytes: 0,
      estimatedTokens: 0,
      warnings: 0,
      keywords: null,
      params: null,
      paramsTruncated: false,
      paramsDropped: false,
      jobText: null,
    });
  }

  /** A call finished. A call the log never saw start (it was evicted meanwhile) is added as finished. */
  finish(outcome: ToolOutcome): void {
    const detail: CallDetail | undefined = outcome.detail;
    let entry = this.byRequest.get(outcome.requestId);
    if (entry === undefined) {
      this.start({
        requestId: outcome.requestId,
        tool: outcome.tool,
        adapter: outcome.adapter,
        platform: outcome.platform,
        startedAt: detail?.startedAt ?? Date.now(),
      });
      entry = this.byRequest.get(outcome.requestId);
      if (entry === undefined) return;
    }
    entry.state = 'done';
    entry.code = outcome.code;
    entry.durationMs = outcome.durationMs;
    entry.argsHash = outcome.argsHash;
    if (detail !== undefined) {
      entry.unitsReserved = detail.unitsReserved;
      entry.unitsSpent = detail.unitsSpent;
      entry.responseBytes = detail.responseBytes;
      entry.estimatedTokens = detail.estimatedTokens;
      entry.warnings = detail.warnings;
      entry.params = detail.params;
      entry.paramsTruncated = detail.paramsTruncated;
      entry.keywords = keywordsOf(detail.params);
      entry.jobText = detail.jobText ?? null;
      if (detail.params !== null) {
        const size = JSON.stringify(detail.params).length;
        this.sizes.set(entry.id, size);
        this.paramsBytes += size;
        this.shed();
      }
    }
  }

  get(id: number): CallEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** Newest first. */
  list(query: CallQuery): { calls: CallEntry[]; total: number; next: number | null } {
    const matches = (entry: CallEntry): boolean =>
      (query.tool === undefined || entry.tool === query.tool) &&
      (query.platform === undefined || entry.platform === query.platform) &&
      (query.code === undefined || (query.code === 'running' ? entry.state === 'running' : entry.code === query.code)) &&
      (query.before === undefined || entry.id < query.before);
    const all = this.entries.filter(matches).reverse();
    const calls = all.slice(0, query.limit);
    const last = calls.at(-1);
    return { calls, total: all.length, next: all.length > calls.length && last !== undefined ? last.id : null };
  }

  /** Every call still in the buffer, oldest first (for the analytics). */
  all(): readonly CallEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  private push(entry: CallEntry): void {
    this.entries.push(entry);
    this.byRequest.set(entry.requestId, entry);
    while (this.entries.length > this.capacity) {
      const evicted = this.entries.shift();
      if (evicted !== undefined) {
        this.byRequest.delete(evicted.requestId);
        this.forget(evicted.id);
      }
    }
  }

  private forget(id: number): void {
    this.paramsBytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
  }

  /** Drop the parameters of the oldest calls until the total is back under the bound. */
  private shed(): void {
    for (const entry of this.entries) {
      if (this.paramsBytes <= this.maxParamsBytes) return;
      if (entry.params === null) continue;
      entry.params = null;
      entry.paramsDropped = true;
      this.forget(entry.id);
    }
  }
}
