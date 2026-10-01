import { createBrowserTestContext } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import { termMatcher, type Card } from './parse';
import { readNew } from './read';

const card = (id: string, title = 'Engineer'): Card => ({
  id,
  title,
  company: 'Acme',
  location: 'Paris',
  work_mode: 'unknown',
  salary_text: null,
  posted_text: null,
  posted_hours_ago: null,
  promoted: false,
  easy_apply: false,
  url: `https://www.linkedin.com/jobs/view/${id}/`,
});

const ids = ['4000000001', '4000000002', '4000000003'];
const page = {
  present: ['#job-details'],
  evaluate: () => ({ description: 'Text', closed: false, title: 'R | C | LinkedIn', loginForm: false }),
};
const make = () =>
  createBrowserTestContext({
    allowedHosts: ['www.linkedin.com'],
    pages: Object.fromEntries(ids.map((id) => [`https://www.linkedin.com/jobs/view/${id}/`, page])),
  });

describe('readNew', () => {
  const base = {
    skip: new Set<string>(),
    stored: 'evaluate' as const,
    maxJobs: 25,
    maxReturned: 50,
    matchTitle: termMatcher([]),
    matchDescription: null,
  };

  it('stops opening when the time budget is spent and reports the rest as remaining', async () => {
    const { ctx, jobs } = make();
    let clock = 0;
    const outcome = await readNew(
      ctx,
      ids.map((id) => card(id)),
      { ...base, deadline: 25, now: () => (clock += 10) },
    );
    expect(outcome.accepted.map((j) => j.id)).toEqual(['4000000001', '4000000002']);
    expect(outcome.remaining).toEqual(['4000000003']);
    expect([...jobs.jobs.keys()]).toEqual(['4000000001', '4000000002']);
  });

  it('counts a failed visit against max_jobs', async () => {
    const unusable = { present: ['#job-details'], evaluate: () => ({ description: null, closed: false, title: '', loginForm: false }) };
    const { ctx } = createBrowserTestContext({
      allowedHosts: ['www.linkedin.com'],
      pages: {
        'https://www.linkedin.com/jobs/view/4000000001/': unusable,
        'https://www.linkedin.com/jobs/view/4000000002/': page,
        'https://www.linkedin.com/jobs/view/4000000003/': page,
      },
    });
    const outcome = await readNew(
      ctx,
      ids.map((id) => card(id)),
      { ...base, maxJobs: 2, deadline: Infinity },
    );
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.remaining).toEqual(['4000000003']);
  });

  it('keeps what was already stored when a later visit throws (a lost session)', async () => {
    const loginWall = { present: [], evaluate: () => ({ loginForm: true, description: null, closed: false, title: '' }) };
    const { ctx, jobs } = createBrowserTestContext({
      allowedHosts: ['www.linkedin.com'],
      pages: { 'https://www.linkedin.com/jobs/view/4000000001/': page, 'https://www.linkedin.com/jobs/view/4000000002/': loginWall },
    });
    await expect(readNew(ctx, [card('4000000001'), card('4000000002')], { ...base, deadline: Infinity })).rejects.toThrow();
    expect([...jobs.jobs.keys()]).toEqual(['4000000001']);
  });
});
