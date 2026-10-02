import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useState } from 'react';
import { usePlatform } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const;

/** How well each search keyword does: a keyword that finds nothing new is only bringing the same jobs back. */
export function Searches() {
  const source = usePlatform();
  const navigate = useNavigate();
  const [days, setDays] = useState<number>(7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const searches = useQuery({
    queryKey: ['searches', source, days],
    queryFn: () => api.searches({ since, ...(source === undefined ? {} : { source }) }),
  });
  const rows = searches.data?.searches ?? [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-5 py-2">
        {WINDOWS.map((window) => (
          <Button key={window.days} size="sm" variant={days === window.days ? 'secondary' : 'ghost'} onClick={() => setDays(window.days)}>
            Last {window.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">Click a keyword to list the jobs it found</span>
      </div>
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {['Source', 'Keywords', 'Runs', 'Jobs found', 'Returned', 'New', 'New / found', 'Last run'].map((title) => (
                <TableHead key={title}>{title}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const ratio = row.jobsFound === 0 ? 0 : row.jobsNew / row.jobsFound;
              return (
                <TableRow
                  key={`${row.source}|${row.query}`}
                  tabIndex={row.query === '' ? undefined : 0}
                  className={row.query === '' ? '' : 'cursor-pointer'}
                  onClick={() =>
                    row.query !== '' &&
                    void navigate({
                      pathname: '/jobs',
                      search: `?found_by=${encodeURIComponent(row.query)}&tool=${encodeURIComponent(row.source)}`,
                    })
                  }
                  onKeyDown={(event) =>
                    event.key === 'Enter' &&
                    row.query !== '' &&
                    void navigate({
                      pathname: '/jobs',
                      search: `?found_by=${encodeURIComponent(row.query)}&tool=${encodeURIComponent(row.source)}`,
                    })
                  }
                >
                  <TableCell>
                    <Badge variant="secondary">{row.source}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    {row.query === '' ? <span className="text-muted-foreground">(no keywords)</span> : row.query}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.runs}</TableCell>
                  <TableCell className="tabular-nums">{row.jobsFound}</TableCell>
                  <TableCell className="tabular-nums">{row.jobsReturned}</TableCell>
                  <TableCell className="tabular-nums">{row.jobsNew}</TableCell>
                  <TableCell className="w-40">
                    <div className="flex items-center gap-2" title={`${Math.round(ratio * 100)} % of what it found was new`}>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary"
                          role="presentation"
                          ref={(node) => {
                            if (node) node.style.width = `${Math.round(ratio * 100)}%`;
                          }}
                        />
                      </div>
                      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Math.round(ratio * 100)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ago(row.lastRun)}</TableCell>
                </TableRow>
              );
            })}
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
  );
}
