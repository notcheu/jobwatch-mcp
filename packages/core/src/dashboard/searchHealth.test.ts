import { describe, expect, it } from 'vitest';
import { searchHealth } from './searchHealth';

describe('searchHealth', () => {
  it('is good for a search that brings jobs in and keeps most of them', () => {
    expect(searchHealth({ runs: 4, jobsFound: 20, jobsExcluded: 3 })).toEqual({ status: 'good', issues: [], discardedShare: 0.15 });
  });

  it('is bad when a search that ran more than once listed nothing, and not after a single run', () => {
    expect(searchHealth({ runs: 2, jobsFound: 0, jobsExcluded: 0 })).toMatchObject({ status: 'bad', issues: ['no_results'] });
    expect(searchHealth({ runs: 1, jobsFound: 0, jobsExcluded: 0 })).toMatchObject({ status: 'good' });
  });

  it('is bad when most of what it lists is discarded, once there are enough jobs to judge', () => {
    expect(searchHealth({ runs: 1, jobsFound: 10, jobsExcluded: 8 })).toEqual({
      status: 'bad',
      issues: ['mostly_discarded'],
      discardedShare: 0.8,
    });
    expect(searchHealth({ runs: 1, jobsFound: 10, jobsExcluded: 7 }).status).toBe('good'); // 70 % is under the line
    expect(searchHealth({ runs: 3, jobsFound: 4, jobsExcluded: 4 }).status).toBe('good'); // 4 jobs are too few to say
  });
});
