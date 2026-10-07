import type { JobSearch } from '@jobwatch/dashboard-api';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { DisallowedBadges, KeywordBadges } from '@/components/KeywordBadges';
import { HealthBadge, describeExclusion } from '@/components/SearchHealth';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { searchDetailLink } from '@/lib/format';

/** What a search did with the job this table belongs to; for a dropped job, the term that did it on a line of its own. */
function Outcome({ search }: { search: JobSearch }) {
  if (search.outcome === 'returned') return <Badge variant="success">returned</Badge>;
  if (search.outcome === 'excluded') {
    const by = search.excludedBy;
    return (
      <div className="flex min-w-0 max-w-full flex-col items-start gap-0.5" title={`Dropped: ${describeExclusion(by)}`}>
        <Badge variant="destructive">dropped</Badge>
        {by !== null && (
          <span className="block max-w-full truncate text-destructive">{by.reason === 'salary' ? 'by its salary' : `by “${by.term}”`}</span>
        )}
      </div>
    );
  }
  return (
    <Badge variant="outline" title="The search matched this job but did not hand it back (a limit, only_new or a filter).">
      not returned
    </Badge>
  );
}

/**
 * The searches that found a job, as a short table that stays closed until it is asked for: a job found by many searches would
 * otherwise push its description out of sight. One row per search (keywords and disallowed terms), what that search did with this job,
 * how healthy it is, and a link to it.
 */
export function JobSearches({ source, searches }: { source: string; searches: readonly JobSearch[] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section aria-label="Searches that found this job" className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Found by {searches.length} search{searches.length === 1 ? '' : 'es'}
      </button>
      <div id={panel} hidden={!open}>
        {open && (
          <div className="overflow-x-auto rounded-md border">
            <Table aria-label="Searches that found this job" className="table-fixed text-xs">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-2">Search</TableHead>
                  <TableHead className="h-8 w-36 px-2">This job · health</TableHead>
                  <TableHead className="h-8 w-12 px-2">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {searches.map((search) => (
                  <TableRow key={`${search.keywords.join('\u0000')}|${search.disallowed.join('\u0000')}`}>
                    <TableCell className="px-2 py-1.5 align-top">
                      <div className="space-y-1">
                        <KeywordBadges keywords={search.keywords} />
                        {search.disallowed.length > 0 && (
                          <div className="flex flex-wrap items-start gap-1 text-muted-foreground">
                            without <DisallowedBadges terms={search.disallowed} />
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="px-2 py-1.5 align-top">
                      <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
                        <Outcome search={search} />
                        <span
                          title={`${search.jobsFound} jobs found, ${search.jobsExcluded} dropped, over ${search.runs} run${search.runs === 1 ? '' : 's'}`}
                        >
                          <HealthBadge health={search.health} />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-2 py-1.5 align-top">
                      <Link
                        to={searchDetailLink(source, search.keywords, search.disallowed)}
                        className="text-primary hover:underline"
                        aria-label={`Open the search ${search.keywords.length === 0 ? 'without keywords' : search.keywords.join(', ')}`}
                      >
                        Open
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
