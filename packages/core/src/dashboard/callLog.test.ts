import { describe, expect, it } from 'vitest';
import type { CallDetail, ToolOutcome } from '../call';
import { CallLog, keywordsOf } from './callLog';

const detail = (over: Partial<CallDetail> = {}): CallDetail => ({
  startedAt: 1000,
  unitsReserved: 5,
  unitsSpent: 3,
  responseBytes: 900,
  estimatedTokens: 260,
  warnings: 1,
  params: { keywords: 'React Engineer', geo: 'france' },
  paramsTruncated: false,
  ...over,
});
const outcome = (requestId: string, over: Partial<ToolOutcome> = {}): ToolOutcome => ({
  tool: 'linkedin_search',
  adapter: 'linkedin',
  platform: 'linkedin',
  code: 'ok',
  durationMs: 120,
  requestId,
  argsHash: 'abc',
  detail: detail(),
  ...over,
});
const start = (log: CallLog, requestId: string, tool = 'linkedin_search', platform = 'linkedin') =>
  log.start({ requestId, tool, adapter: platform, platform, startedAt: 1000 });

describe('CallLog', () => {
  it('shows a call as running, then settles it with the detail', () => {
    const log = new CallLog(10);
    start(log, 'r1');
    expect(log.list({ limit: 10 }).calls[0]).toMatchObject({ state: 'running', code: null, durationMs: null });
    log.finish(outcome('r1'));
    expect(log.list({ limit: 10 }).calls[0]).toMatchObject({
      state: 'done',
      code: 'ok',
      durationMs: 120,
      unitsReserved: 5,
      unitsSpent: 3,
      responseBytes: 900,
      estimatedTokens: 260,
      keywords: 'React Engineer',
      params: { keywords: 'React Engineer', geo: 'france' },
    });
  });

  it('keeps only the newest calls up to the capacity, newest first, and forgets the evicted one', () => {
    const log = new CallLog(3);
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      start(log, id);
      log.finish(outcome(id));
    }
    expect(log.size).toBe(3);
    expect(log.list({ limit: 10 }).calls.map((c) => c.requestId)).toEqual(['r4', 'r3', 'r2']);
    log.finish(outcome('r1', { code: 'timeout' }));
    expect(log.list({ limit: 10 }).calls.map((c) => c.requestId)).toContain('r1'); // a finish for an evicted call is added back as finished
  });

  it('filters by tool, platform and outcome (running is an outcome too) and pages with a cursor', () => {
    const log = new CallLog(50);
    start(log, 'a', 'apec_search', 'apec');
    log.finish(outcome('a', { tool: 'apec_search', platform: 'apec', code: 'rate_limited' }));
    for (const id of ['b', 'c', 'd']) {
      start(log, id);
      log.finish(outcome(id));
    }
    start(log, 'live');
    expect(log.list({ tool: 'apec_search', limit: 10 }).calls.map((c) => c.requestId)).toEqual(['a']);
    expect(log.list({ platform: 'linkedin', limit: 10 }).total).toBe(4);
    expect(log.list({ code: 'rate_limited', limit: 10 }).calls).toHaveLength(1);
    expect(log.list({ code: 'running', limit: 10 }).calls.map((c) => c.requestId)).toEqual(['live']);
    const first = log.list({ limit: 2 });
    expect(first.calls.map((c) => c.requestId)).toEqual(['live', 'd']);
    const second = log.list({ limit: 2, before: first.next ?? 0 });
    expect(second.calls.map((c) => c.requestId)).toEqual(['c', 'b']);
    expect(log.list({ limit: 10, before: 1 }).next).toBeNull();
  });

  it('drops the parameters of the oldest calls when they use more than the memory bound, keeping the rows', () => {
    const log = new CallLog(10, 100);
    for (const id of ['r1', 'r2', 'r3']) {
      start(log, id);
      log.finish(outcome(id, { detail: detail({ params: { blob: 'x'.repeat(60) } }) }));
    }
    const byId = Object.fromEntries(log.list({ limit: 10 }).calls.map((c) => [c.requestId, c]));
    expect(byId['r1']).toMatchObject({ params: null, paramsDropped: true, code: 'ok' });
    expect(byId['r2']).toMatchObject({ params: null, paramsDropped: true });
    expect(byId['r3']?.params).not.toBeNull();
    expect(byId['r3']?.paramsDropped).toBe(false);
  });

  it('gives back the parameter bytes of an evicted call', () => {
    const log = new CallLog(2, 200);
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      start(log, id);
      log.finish(outcome(id, { detail: detail({ params: { blob: 'x'.repeat(60) } }) }));
    }
    expect(log.list({ limit: 10 }).calls.map((c) => c.paramsDropped)).toEqual([false, false]);
  });

  it('finds one call by its sequence number', () => {
    const log = new CallLog(5);
    start(log, 'r1');
    expect(log.get(1)?.requestId).toBe('r1');
    expect(log.get(99)).toBeUndefined();
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new CallLog(0)).toThrow(RangeError);
    expect(() => new CallLog(1.5)).toThrow(RangeError);
  });
});

describe('keywordsOf', () => {
  it('reads the keywords of a search, or the title words of an ATS search joined', () => {
    expect(keywordsOf({ keywords: '  react  ' })).toBe('react');
    expect(keywordsOf({ title_any: ['front', 'react'], boards: ['acme'] })).toBe('front | react');
    expect(keywordsOf({ title_any: [] })).toBeNull();
    expect(keywordsOf({ ids: ['1'] })).toBeNull();
    expect(keywordsOf(null)).toBeNull();
    expect(keywordsOf({ keywords: 'x'.repeat(500) })?.length).toBe(200);
  });
});
