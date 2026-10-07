import type { SearchHealthInfo } from '@jobwatch/dashboard-api';
import { Badge } from '@/components/ui/badge';

/** What a bad health means, in words. */
export const ISSUE_TEXT: Record<SearchHealthInfo['issues'][number], string> = {
  no_results: 'It ran more than once and found nothing: its keywords match no job.',
  mostly_discarded: 'Most of the jobs it finds are dropped by the disallowed terms or the salary floor.',
};

export function HealthBadge({ health }: { health: SearchHealthInfo }) {
  return health.status === 'good' ? (
    <Badge variant="success">healthy</Badge>
  ) : (
    <Badge variant="destructive" title={health.issues.map((issue) => ISSUE_TEXT[issue]).join(' ')}>
      {health.issues.includes('no_results') ? 'no results' : `${Math.round(health.discardedShare * 100)}% discarded`}
    </Badge>
  );
}

/** Why a job was dropped, in a short phrase: the term and where it was found (the salary is stated, not matched). */
export function describeExclusion(by: { reason: 'title' | 'description' | 'salary'; term: string } | null): string {
  if (by === null) return 'a disallowed term or the salary floor';
  if (by.reason === 'salary') return `its salary (${by.term}) is under the floor`;
  return `“${by.term}” in the ${by.reason}`;
}
