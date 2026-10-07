/**
 * How well a search is doing, from what the history of searches keeps (docs/plans/17-dashboard.md, Searches). A search has a bad
 * health when it is wasting calls, and says why:
 *   - `no_results`: it ran at least twice and listed nothing, so its keywords match nothing (or the site changed);
 *   - `mostly_discarded`: it listed enough jobs to judge and most of them were dropped by disallowed terms or the salary floor, so
 *     the keywords bring in what the terms then throw away.
 * The thresholds are constants so a test and the dashboard read the same numbers.
 */
export const HEALTH_MIN_RUNS_EMPTY = 2;
export const HEALTH_MIN_FOUND = 5;
export const HEALTH_MAX_DISCARDED_SHARE = 0.8;

export type HealthIssue = 'no_results' | 'mostly_discarded';

export interface SearchHealth {
  status: 'good' | 'bad';
  issues: HealthIssue[];
  /** Share of the listed jobs that were dropped by disallowed terms or the salary floor, 0 to 1 (0 when nothing was listed). */
  discardedShare: number;
}

export function searchHealth(stat: { runs: number; jobsFound: number; jobsExcluded: number }): SearchHealth {
  const discardedShare = stat.jobsFound === 0 ? 0 : stat.jobsExcluded / stat.jobsFound;
  const issues: HealthIssue[] = [];
  if (stat.jobsFound === 0 && stat.runs >= HEALTH_MIN_RUNS_EMPTY) issues.push('no_results');
  if (stat.jobsFound >= HEALTH_MIN_FOUND && discardedShare >= HEALTH_MAX_DISCARDED_SHARE) issues.push('mostly_discarded');
  return { status: issues.length === 0 ? 'good' : 'bad', issues, discardedShare };
}
