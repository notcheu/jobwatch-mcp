import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobwatchError } from '@jobwatch/sdk';
import { Store } from '../store/store';
import { createStoredJobsTool } from './storedJobs';

const NOW = Date.UTC(2026, 9, 9, 12);
const day = (d: number, hour = 9): number => Date.UTC(2026, 9, d, hour);

const job = (id: string, title: string, description: string, board: string | null = null) => ({
  id,
  board,
  title,
  company: 'Acme',
  location: 'Paris',
  url: `https://example.com/${id}`,
  description,
});

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
  store.putJob('linkedin', job('1000001', 'Senior Frontend Engineer', 'We use React and TypeScript every day.'), day(5));
  store.putJob('linkedin', job('1000002', 'Backend Engineer', 'Go services. A bit of React tooling.'), day(6));
  store.putJob('apec', job('2000001', 'Data Engineer', 'Python and Spark.'), day(6, 15));
  store.putJob('teamtailor', job('3000001', 'Frontend Developer', 'React, Vue.', 'bsport'), day(8));
  store.putJob('linkedin', job('1000003', 'Old Frontend Engineer', 'React.'), day(1));
});
afterEach(() => store.close());

const run = async (args: object, now = NOW) => {
  const tool = createStoredJobsTool(store, () => now);
  return tool.handler(tool.input.parse(args), {} as never);
};

describe('stored_jobs', () => {
  it('lists the last 7 days by default, newest first, with no text', async () => {
    const { data } = await run({});
    expect(data.jobs.map((j) => j.id)).toEqual(['3000001', '2000001', '1000002', '1000001']);
    expect(data.window).toMatchObject({ since: '2026-10-02T12:00:00.000Z', until: '2026-10-09T12:00:00.000Z', date_field: 'first_seen' });
    for (const j of data.jobs) {
      expect(j.summary).toBe('');
      expect(j.description).toBe('');
      expect(j.description_chars).toBeGreaterThan(0);
    }
  });

  it('takes ISO dates: since inclusive, until exclusive, a bare date is midnight UTC', async () => {
    expect((await run({ since: '2026-10-06', until: '2026-10-08' })).data.jobs.map((j) => j.id)).toEqual(['2000001', '1000002']);
    expect((await run({ since: '2026-10-05T09:00:00Z', until: '2026-10-06T09:00:00Z' })).data.jobs.map((j) => j.id)).toEqual(['1000001']);
  });

  it('refuses a bad or inverted window', async () => {
    await expect(run({ since: 'last week' })).rejects.toBeInstanceOf(JobwatchError);
    await expect(run({ since: '2026-10-09', until: '2026-10-01' })).rejects.toThrow('before');
  });

  it('filters by source and board', async () => {
    expect((await run({ sources: ['linkedin'] })).data.jobs.map((j) => j.id)).toEqual(['1000002', '1000001']);
    expect((await run({ boards: ['bsport'] })).data.jobs.map((j) => j.id)).toEqual(['3000001']);
  });

  it('uses the date field asked for', async () => {
    store.touchJobs('linkedin', ['1000003'], day(8, 20));
    expect((await run({ date_field: 'last_seen', since: '2026-10-08' })).data.jobs.map((j) => j.id)).toEqual(['1000003', '3000001']);
  });

  it('adds a summary or the full text only when asked', async () => {
    const full = (await run({ detail: 'full', sources: ['apec'] })).data.jobs[0];
    expect(full?.description).toBe('Python and Spark.');
    const summary = (await run({ detail: 'summary', sources: ['apec'] })).data.jobs[0];
    expect(summary?.summary).toContain('Python');
    expect(summary?.description).toBe('');
    const clipped = (await run({ detail: 'full', description_max_chars: 500, sources: ['linkedin'] })).data.jobs[0];
    expect(clipped?.description_truncated).toBe(false);
  });

  it('shows which terms each job contains, and how the terms did over the whole window', async () => {
    const { data } = await run({ terms: ['React', 'frontend', 'Vue'] });
    const byId = Object.fromEntries(data.jobs.map((j) => [j.id, j]));
    expect(byId['1000001']).toMatchObject({ title_terms: ['frontend'], description_terms: ['React'] });
    expect(byId['2000001']).toMatchObject({ title_terms: [], description_terms: [] });
    expect(data.stats.terms).toEqual([
      { term: 'React', jobs: 3, in_title: 0, in_description_only: 3 },
      { term: 'frontend', jobs: 2, in_title: 2, in_description_only: 0 },
      { term: 'Vue', jobs: 1, in_title: 0, in_description_only: 1 },
    ]);
    expect(data.stats.matching_any_term).toBe(3);
  });

  it('only_matching lists the matching jobs but the statistics still count them all', async () => {
    const { data } = await run({ terms: ['Vue'], only_matching: true });
    expect(data.jobs.map((j) => j.id)).toEqual(['3000001']);
    expect(data.total).toBe(1);
    expect(data.stats.jobs).toBe(4);
  });

  it('counts jobs per source, board and day', async () => {
    const { stats } = (await run({})).data;
    expect(stats.by_source).toEqual([
      { source: 'linkedin', jobs: 2 },
      { source: 'apec', jobs: 1 },
      { source: 'teamtailor', jobs: 1 },
    ]);
    expect(stats.by_board).toEqual([{ source: 'teamtailor', board: 'bsport', jobs: 1 }]);
    expect(stats.by_day).toEqual([
      { day: '2026-10-05', jobs: 1 },
      { day: '2026-10-06', jobs: 2 },
      { day: '2026-10-08', jobs: 1 },
    ]);
    expect(stats.terms).toEqual([]);
    expect(stats.matching_any_term).toBeNull();
  });

  it('pages with limit and offset', async () => {
    const first = (await run({ limit: 3 })).data;
    expect(first.jobs).toHaveLength(3);
    expect(first.next_offset).toBe(3);
    const second = (await run({ limit: 3, offset: first.next_offset ?? 0 })).data;
    expect(second.jobs.map((j) => j.id)).toEqual(['1000001']);
    expect(second.next_offset).toBeNull();
  });

  it('spends no platform budget and reads the window from the database only', async () => {
    const tool = createStoredJobsTool(store, () => NOW);
    const result = await tool.handler(tool.input.parse({}), {} as never);
    expect(result.cost).toBe(0);
  });
});
