import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobwatchError } from '@jobwatch/sdk';
import { Store } from '../store/store';
import { createStoredSearchesTool } from './storedSearches';
import { createStoredJobsTool } from './storedJobs';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12);
const job = (id: string, title: string) => ({
  id,
  board: null,
  title,
  company: 'Acme',
  location: 'Paris',
  url: `https://x/${id}`,
  description: 'React',
});

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
  store.putJob('linkedin', job('1000001', 'Frontend'), NOW - 3 * DAY);
  store.putJob('linkedin', job('1000002', 'Backend'), NOW - 2 * DAY);
  store.recordSearch('linkedin', { query: 'react', found: ['1000001', '1000002', '1000003'], returned: ['1000001'] }, NOW - 3 * DAY);
  store.recordSearch('linkedin', { query: 'go', found: ['1000002'], returned: ['1000002'] }, NOW - 2 * DAY);
  store.recordSearch('wttj', { query: '', found: ['w1'], returned: ['w1'] }, NOW - DAY);
});
afterEach(() => store.close());

const searches = async (args: object) => {
  const tool = createStoredSearchesTool(store, () => NOW);
  return tool.handler(tool.input.parse(args), {} as never);
};

describe('stored_searches', () => {
  it('lists each keyword with its runs and jobs listed, returned and new, over the last 7 days by default', async () => {
    const { data, cost } = await searches({});
    expect(cost).toBe(0);
    expect(data.window.until).toBe('2026-10-09T12:00:00.000Z');
    expect(data.searches.map((s) => [s.source, s.query, s.runs, s.jobs_found, s.jobs_returned, s.jobs_new])).toEqual([
      ['linkedin', 'react', 1, 3, 1, 2],
      ['linkedin', 'go', 1, 1, 1, 1],
      ['wttj', '', 1, 1, 1, 0],
    ]);
  });

  it('narrows to a platform and a window, and refuses a bad window', async () => {
    expect((await searches({ source: 'wttj' })).data.searches).toHaveLength(1);
    expect((await searches({ since: '2026-10-08', until: '2026-10-09' })).data.searches.map((s) => s.source)).toEqual(['wttj']);
    await expect(searches({ since: 'soon' })).rejects.toBeInstanceOf(JobwatchError);
    await expect(searches({ since: '2026-10-09', until: '2026-10-01' })).rejects.toThrow('before');
  });
});

describe('stored_jobs with the search history', () => {
  const jobs = async (args: object) => {
    const tool = createStoredJobsTool(store, () => NOW);
    return tool.handler(tool.input.parse(args), {} as never);
  };

  it('shows the keywords that listed each job and filters by one', async () => {
    const all = (await jobs({})).data.jobs;
    expect(Object.fromEntries(all.map((j) => [j.id, j.found_by]))).toEqual({ '1000001': ['react'], '1000002': ['go', 'react'] });
    expect((await jobs({ found_by: 'GO' })).data.jobs.map((j) => j.id)).toEqual(['1000002']);
    expect((await jobs({ found_by: 'nothing' })).data.jobs).toEqual([]);
  });
});
