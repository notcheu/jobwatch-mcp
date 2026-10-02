import { describe, expect, it } from 'vitest';
import { API_PREFIX, callDetailSchema, callRowSchema, jobDetailSchema, jobRowSchema, meSchema } from './index';

const row = {
  id: 1,
  requestId: 'r',
  tool: 't',
  platform: 'p',
  state: 'done',
  code: 'ok',
  startedAt: '2026-10-09T12:00:00.000Z',
  durationMs: 5,
  unitsReserved: 1,
  unitsSpent: 1,
  responseBytes: 10,
  estimatedTokens: 3,
  warnings: 0,
  keywords: null,
};
const job = {
  source: 'linkedin',
  id: '1',
  board: null,
  title: 't',
  company: 'c',
  location: 'l',
  url: 'https://x/1',
  firstSeen: '2026-10-09T12:00:00.000Z',
  fetchedAt: '2026-10-09T12:00:00.000Z',
  lastSeen: '2026-10-09T12:00:00.000Z',
  descriptionChars: 3,
  foundBy: [],
};

describe('the response types', () => {
  it('are mounted under /dashboard', () => {
    expect(API_PREFIX).toBe('/dashboard/api/v1');
  });

  it('reject a field they do not name, so a database column cannot leak through them', () => {
    expect(callRowSchema.safeParse(row).success).toBe(true);
    expect(callRowSchema.safeParse({ ...row, params: { keywords: 'x' } }).success).toBe(false);
    expect(jobRowSchema.safeParse(job).success).toBe(true);
    expect(jobRowSchema.safeParse({ ...job, description: 'the whole text' }).success).toBe(false);
    expect(
      meSchema.safeParse({
        mode: 'google',
        email: 'a@b.c',
        signedInAt: null,
        expiresAt: null,
        idleStopAt: null,
        writableUntil: null,
        version: 'x',
        token: 'y',
      }).success,
    ).toBe(false);
  });

  it('keep the parameters of a call and the description of a job to their detail types', () => {
    expect(
      callDetailSchema.safeParse({
        ...row,
        adapter: 'a',
        argsHash: null,
        params: { a: 1 },
        paramsTruncated: false,
        paramsDropped: false,
        jobText: null,
      }).success,
    ).toBe(true);
    expect(
      jobDetailSchema.safeParse({
        ...job,
        description: 'd',
        summary: 's',
        summaryKind: null,
        outline: [],
        hints: { stack: [], years: [], remote: [], salary: null },
      }).success,
    ).toBe(true);
  });
});
