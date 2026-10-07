import { useQuery } from '@tanstack/react-query';
import type { SearchDetailInfo, SearchHealthInfo, SearchJob, SearchRow } from '@jobwatch/dashboard-api';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DetailPanel, Field } from '@/components/DetailPanel';
import { KeywordBadges } from '@/components/KeywordBadges';
import { usePlatform } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, jobsOfSearch, searchDetailLink } from '@/lib/format';

const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const;

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

/** How well each search does: the keywords it uses, what it finds, what gets discarded, and what it brings that is new. */
export function Searches() {
  const source = usePlatform();
  const navigate = useNavigate();
  const params = useParams();
  const [query] = useSearchParams();
  const [days, setDays] = useState<number>(Number(query.get('days')) === 30 ? 30 : 7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const searches = useQuery({
    queryKey: ['searches', source, days],
    queryFn: () => api.searches({ since, ...(source === undefined ? {} : { source }) }),
  });
  const rows = searches.data?.searches ?? [];
  const selected = params['source'] === undefined ? undefined : { source: params['source'], keywords: query.getAll('k') };
  const open = (row: SearchRow): void => void navigate(searchDetailLink(row.source, row.keywords, days));
  const close = (): void =>
    void navigate({ pathname: '/searches', search: source === undefined ? '' : `?tool=${encodeURIComponent(source)}` });
  const isSelected = (row: SearchRow): boolean =>
    selected !== undefined &&
    selected.source === row.source &&
    row.keywords.join('\u0000') === [...selected.keywords].sort().join('\u0000');

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-5 py-2">
          {WINDOWS.map((window) => (
            <Button key={window.days} size="sm" variant={days === window.days ? 'secondary' : 'ghost'} onClick={() => setDays(window.days)}>
              Last {window.label}
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">Click a search to see its health and its jobs</span>
        </div>
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {['Source', 'Keywords', 'Health', 'Runs', 'Jobs found', 'Discarded', 'Returned', 'New', 'Last run'].map((title) => (
                  <TableHead key={title}>{title}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={`${row.source}|${row.keywords.join('\u0000')}`}
                  tabIndex={0}
                  className="cursor-pointer"
                  data-state={isSelected(row) ? 'selected' : undefined}
                  onClick={() => open(row)}
                  onKeyDown={(event) => event.key === 'Enter' && open(row)}
                >
                  <TableCell>
                    <Badge variant="secondary">{row.source}</Badge>
                  </TableCell>
                  <TableCell className="max-w-80 font-medium">
                    <KeywordBadges keywords={row.keywords} />
                  </TableCell>
                  <TableCell>
                    <HealthBadge health={row.health} />
                  </TableCell>
                  <TableCell className="tabular-nums">{row.runs}</TableCell>
                  <TableCell className="tabular-nums">{row.jobsFound}</TableCell>
                  <TableCell className="tabular-nums" title="Dropped by a disallowed term or the salary floor">
                    {row.jobsExcluded}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.jobsReturned}</TableCell>
                  <TableCell className="tabular-nums">{row.jobsNew}</TableCell>
                  <TableCell className="text-muted-foreground">{ago(row.lastRun)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {searches.isSuccess && rows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No search recorded in this window. Searches are remembered from the moment the router records them.
            </p>
          )}
          {searches.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the searches.</p>}
        </div>
      </div>
      {selected !== undefined && <SearchPanel source={selected.source} keywords={selected.keywords} days={days} onClose={close} />}
    </div>
  );
}

function SearchPanel({ source, keywords, days, onClose }: { source: string; keywords: string[]; days: number; onClose: () => void }) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const search = useQuery({
    queryKey: ['search', source, keywords, days],
    queryFn: () => api.search(source, { keywords, since }),
    retry: false,
  });
  const title = keywords.length === 0 ? `${source}: no keywords` : `${source}: ${keywords.join(', ')}`;
  return (
    <DetailPanel title={title} onClose={onClose}>
      {search.isError && <p className="text-sm text-muted-foreground">That search did not run in the last {days} days.</p>}
      {search.data && <SearchBody search={search.data} days={days} />}
    </DetailPanel>
  );
}

const OUTCOME = {
  returned: { label: 'returned', variant: 'success' },
  excluded: { label: 'discarded', variant: 'destructive' },
  other: { label: 'listed', variant: 'outline' },
} as const;

function SearchBody({ search, days }: { search: SearchDetailInfo; days: number }) {
  const matched = search.jobsFound - search.jobsExcluded;
  const share = search.jobsFound === 0 ? 0 : Math.round((matched / search.jobsFound) * 100);
  return (
    <>
      <div className="space-y-2">
        <KeywordBadges keywords={search.keywords} />
        <div className="text-xs text-muted-foreground">
          {search.source} · {search.runs} run{search.runs === 1 ? '' : 's'} in the last {days} days · last {ago(search.lastRun)}
        </div>
      </div>

      <section aria-label="Health" className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Health</h3>
          <HealthBadge health={search.health} />
        </div>
        {search.health.issues.length === 0 ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> Nothing to fix: it brings jobs in and keeps most of them.
          </p>
        ) : (
          <ul className="space-y-1">
            {search.health.issues.map((issue) => (
              <li key={issue} className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {ISSUE_TEXT[issue]}
              </li>
            ))}
          </ul>
        )}
        <div
          className="h-2 overflow-hidden rounded-full bg-destructive/40"
          role="img"
          aria-label={`${matched} of ${search.jobsFound} jobs matched, ${search.jobsExcluded} discarded`}
        >
          <div
            className="h-full bg-primary"
            role="presentation"
            ref={(node) => {
              if (node) node.style.width = `${share}%`;
            }}
          />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Jobs found</dt>
          <dd className="text-right tabular-nums">{search.jobsFound}</dd>
          <dt className="text-muted-foreground">Matched</dt>
          <dd className="text-right tabular-nums">{matched}</dd>
          <dt className="text-muted-foreground" title="Dropped by a disallowed term or the salary floor">
            Discarded
          </dt>
          <dd className="text-right tabular-nums">{search.jobsExcluded}</dd>
          <dt className="text-muted-foreground">Returned</dt>
          <dd className="text-right tabular-nums">{search.jobsReturned}</dd>
          <dt className="text-muted-foreground">New</dt>
          <dd className="text-right tabular-nums">{search.jobsNew}</dd>
        </dl>
      </section>

      <Link to={jobsOfSearch(search.source, search.keywords)} className="inline-block text-sm text-primary hover:underline">
        See all the jobs this search found →
      </Link>

      <Field label={`Jobs (${search.jobs.length}${search.jobsTruncated ? '+' : ''})`}>
        <ul className="divide-y rounded-md border" aria-label="Jobs of this search">
          {search.jobs.map((job) => (
            <JobItem key={job.id} source={search.source} job={job} />
          ))}
        </ul>
        {search.jobsTruncated && (
          <p className="mt-1 text-xs text-muted-foreground">Only the first jobs are listed here: see all of them with the link above.</p>
        )}
        {search.jobs.length === 0 && <p className="text-sm text-muted-foreground">This search listed no job.</p>}
      </Field>
    </>
  );
}

function JobItem({ source, job }: { source: string; job: SearchJob }) {
  const outcome = OUTCOME[job.outcome];
  const label = job.title ?? 'Job no longer stored';
  return (
    <li className="flex items-start justify-between gap-2 p-2 text-sm">
      <div className="min-w-0">
        {job.title === null ? (
          <span className="text-muted-foreground">{label}</span>
        ) : (
          <Link
            to={`/jobs/${encodeURIComponent(source)}/${encodeURIComponent(job.id)}`}
            className="block truncate font-medium hover:underline"
            title={label}
          >
            {label}
          </Link>
        )}
        <div className="truncate text-xs text-muted-foreground">
          {job.company ?? '–'}
          {job.location !== null && ` · ${job.location}`}
        </div>
      </div>
      <Badge variant={outcome.variant} className="shrink-0">
        {outcome.label}
      </Badge>
    </li>
  );
}
