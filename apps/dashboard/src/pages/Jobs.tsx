import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import type { JobDetail, JobRow } from '@jobwatch/dashboard-api';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DetailPanel, Field } from '@/components/DetailPanel';
import { JobSearches } from '@/components/JobSearches';
import { KeywordBadges } from '@/components/KeywordBadges';
import { usePlatform } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, compact, formatSalary } from '@/lib/format';
import { safeHttpsUrl, useDebounced } from '@/lib/hooks';

const column = createColumnHelper<JobRow>();

/** The table column id and the name the API sorts by. A column that is not here cannot be sorted. */
const SORT_NAMES: Record<string, string> = {
  title: 'title',
  company: 'company',
  salary: 'salary',
  firstSeen: 'first_seen',
  lastSeen: 'last_seen',
  descriptionChars: 'description_chars',
};
const SORT_COLUMNS = Object.fromEntries(Object.entries(SORT_NAMES).map(([id, name]) => [name, id]));

const columns = [
  column.accessor('title', {
    header: 'Title',
    cell: (c) => <span className="block max-w-80 truncate font-medium">{c.getValue() ?? '–'}</span>,
  }),
  column.accessor('company', { header: 'Company', cell: (c) => <span className="block max-w-44 truncate">{c.getValue() ?? '–'}</span> }),
  column.accessor((row) => row.salary?.max ?? null, {
    id: 'salary',
    header: 'Salary',
    cell: (c) => {
      const salary = c.row.original.salary;
      return salary === null ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <span className="whitespace-nowrap tabular-nums" title="Yearly, as stated in the job text">
          {formatSalary(salary)}
        </span>
      );
    },
  }),
  column.accessor('location', {
    header: 'Location',
    enableSorting: false,
    cell: (c) => <span className="block max-w-40 truncate text-muted-foreground">{c.getValue() ?? '–'}</span>,
  }),
  column.accessor('source', { header: 'Source', enableSorting: false, cell: (c) => <Badge variant="secondary">{c.getValue()}</Badge> }),
  column.accessor('board', {
    header: 'Board',
    enableSorting: false,
    cell: (c) =>
      c.getValue() === null ? <span className="text-muted-foreground">–</span> : <Badge variant="outline">{c.getValue()}</Badge>,
  }),
  column.accessor('firstSeen', {
    header: 'First seen',
    cell: (c) => <span title={new Date(c.getValue()).toLocaleString()}>{ago(c.getValue())}</span>,
  }),
  column.accessor('lastSeen', {
    header: 'Last seen',
    cell: (c) => <span title={new Date(c.getValue()).toLocaleString()}>{ago(c.getValue())}</span>,
  }),
  column.accessor('foundBy', {
    header: 'Found by',
    enableSorting: false,
    // one line per keyword list, each keyword its own badge: searches that differ only by their disallowed terms share a line (the job
    // detail tells them apart). The cell keeps its width and long keywords are cut with an ellipsis.
    cell: (c) => {
      const lines = new Map<string, { keywords: string[]; terms: Set<string> }>();
      for (const search of c.getValue()) {
        const line = lines.get(search.keywords.join('\u0000')) ?? { keywords: search.keywords, terms: new Set<string>() };
        for (const term of search.disallowed) line.terms.add(term);
        lines.set(search.keywords.join('\u0000'), line);
      }
      return (
        <div className="flex w-56 max-w-56 flex-col gap-1 overflow-hidden">
          {lines.size === 0 ? (
            <span className="text-muted-foreground">–</span>
          ) : (
            [...lines.entries()].map(([key, line]) => (
              <span key={key} title={line.terms.size === 0 ? undefined : `Without: ${[...line.terms].join(', ')}`}>
                <KeywordBadges keywords={line.keywords} empty="(no keywords)" />
              </span>
            ))
          )}
        </div>
      );
    },
  }),
  column.accessor('descriptionChars', { header: 'Size', cell: (c) => <span className="tabular-nums">{compact(c.getValue())}</span> }),
  column.display({
    id: 'link',
    header: '',
    enableHiding: false,
    cell: (c) => {
      const href = safeHttpsUrl(c.row.original.url);
      return href === undefined ? null : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${c.row.original.title ?? 'the posting'} on the site`}
          className="text-muted-foreground hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink className="size-4" />
        </a>
      );
    },
  }),
];

const PAGE_SIZES = [10, 25, 50, 100];

export function Jobs() {
  const source = usePlatform();
  const params = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const get = (key: string): string => search.get(key) ?? '';
  // the search a job was found by is its keyword list: one `found_by` per keyword in the URL, `react | vue` in the box
  const foundByText = search.get('no_keywords') === '1' ? '(no keywords)' : search.getAll('found_by').join(' | ');
  // the disallowed terms of that search, set by the link of a search (not typed): shown as a chip that clears them
  const terms = search.get('no_disallowed') === '1' ? [] : search.getAll('disallowed');
  const hasTermsFilter = search.get('no_disallowed') === '1' || terms.length > 0;
  const setFoundBy = (text: string): void => {
    const next = new URLSearchParams(search);
    next.delete('found_by');
    next.delete('no_keywords');
    next.delete('disallowed'); // a new set of keywords is not the same search
    next.delete('no_disallowed');
    next.delete('page');
    for (const keyword of text.split(/\s+OR\s+|\s*\|\s*/).map((part) => part.trim()))
      if (keyword !== '' && keyword !== '(no keywords)') next.append('found_by', keyword);
    if (text.trim() === '(no keywords)') next.set('no_keywords', '1');
    setSearch(next, { replace: true });
  };
  const [text, setText] = useState(get('q'));
  const q = useDebounced(text);
  const page = Math.max(1, Number(get('page')) || 1);
  const pageSize = PAGE_SIZES.includes(Number(get('pageSize'))) ? Number(get('pageSize')) : 25;
  const sortName = get('sort');
  const sorting: SortingState =
    SORT_COLUMNS[sortName] === undefined ? [] : [{ id: SORT_COLUMNS[sortName] ?? '', desc: get('dir') !== 'asc' }];
  // Last seen and Found by are off until asked for in the Columns menu: the second is a column of badges, and the job detail has the same data
  const [hidden, setHidden] = useState<VisibilityState>({ lastSeen: false, foundBy: false });
  const selected =
    params['source'] !== undefined && params['id'] !== undefined ? { source: params['source'], id: params['id'] } : undefined;

  const update = (changes: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    setSearch(next, { replace: true });
  };
  // the search box writes to the URL once the typist stops
  useEffect(() => {
    if (q !== get('q')) update({ q });
  }, [q]);

  const filters = {
    q: get('q'),
    source,
    board: get('board'),
    found_by: search.getAll('found_by'),
    no_keywords: search.get('no_keywords') ?? undefined,
    disallowed: search.getAll('disallowed'),
    no_disallowed: search.get('no_disallowed') ?? undefined,
    from: get('from'),
    to: get('to'),
    dateField: get('dateField') || undefined,
    sort: sortName || undefined,
    dir: sortName ? get('dir') || 'desc' : undefined,
    page,
    pageSize,
  };
  const jobs = useQuery({ queryKey: ['jobs', filters], queryFn: () => api.jobs(filters), placeholderData: (previous) => previous });
  const data = useMemo(() => jobs.data?.jobs ?? [], [jobs.data]);
  const total = jobs.data?.total ?? 0;

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility: hidden },
    manualSorting: true,
    manualPagination: true,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    onColumnVisibilityChange: (updater) => setHidden(updater),
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      update(first === undefined ? { sort: undefined, dir: undefined } : { sort: SORT_NAMES[first.id], dir: first.desc ? 'desc' : 'asc' });
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => `${row.source}/${row.id}`,
  });

  const open = (row: JobRow): void =>
    void navigate({ pathname: `/jobs/${encodeURIComponent(row.source)}/${encodeURIComponent(row.id)}`, search: search.toString() });
  const close = (): void => void navigate({ pathname: '/jobs', search: search.toString() });
  const body = useRef<HTMLTableSectionElement>(null);
  const focusRow = (from: HTMLElement, step: 1 | -1): void => {
    const rows = [...(body.current?.querySelectorAll<HTMLElement>('tr') ?? [])];
    rows[rows.indexOf(from) + step]?.focus();
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
          <Input
            aria-label="Search jobs"
            placeholder="Search title, company, place"
            className="w-64"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Input
            aria-label="Board"
            placeholder="Board"
            className="w-32"
            defaultValue={get('board')}
            onBlur={(event) => update({ board: event.target.value.trim() })}
            onKeyDown={(event) => event.key === 'Enter' && update({ board: event.currentTarget.value.trim() })}
          />
          <Input
            aria-label="Found by keywords"
            placeholder="Found by keywords (react | vue)"
            className="w-44"
            defaultValue={foundByText}
            key={foundByText}
            onBlur={(event) => setFoundBy(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && setFoundBy(event.currentTarget.value)}
          />
          {hasTermsFilter && (
            <button
              type="button"
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
              aria-label="Clear the disallowed terms filter"
              title="Only the search with exactly these disallowed terms. Click to include the same keywords whatever the terms."
              onClick={() => {
                const next = new URLSearchParams(search);
                next.delete('disallowed');
                next.delete('no_disallowed');
                next.delete('page');
                setSearch(next, { replace: true });
              }}
            >
              {terms.length === 0 ? 'without terms' : `without ${terms.join(', ')}`} ×
            </button>
          )}
          <select
            aria-label="Date to filter on"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={get('dateField') || 'first_seen'}
            onChange={(event) => update({ dateField: event.target.value === 'first_seen' ? undefined : event.target.value })}
          >
            <option value="first_seen">First seen</option>
            <option value="last_seen">Last seen</option>
            <option value="fetched_at">Text read</option>
          </select>
          <Input
            aria-label="From date"
            type="date"
            className="w-36"
            value={get('from')}
            onChange={(event) => update({ from: event.target.value })}
          />
          <Input
            aria-label="To date"
            type="date"
            className="w-36"
            value={get('to')}
            onChange={(event) => update({ to: event.target.value })}
          />
          <details className="relative ml-auto">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-accent">
              <Columns3 className="size-4" /> Columns
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-44 space-y-1 rounded-md border bg-popover p-2 text-sm shadow-md">
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
                    {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                  </label>
                ))}
            </div>
          </details>
        </div>

        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const sortable = header.column.getCanSort();
                    const direction = header.column.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}
                      >
                        {sortable ? (
                          <button
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {direction === 'asc' ? (
                              <ArrowUp className="size-3" />
                            ) : direction === 'desc' ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-40" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody ref={body}>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  data-state={selected?.source === row.original.source && selected.id === row.original.id ? 'selected' : undefined}
                  className="cursor-pointer"
                  onClick={() => open(row.original)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') open(row.original);
                    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {jobs.isSuccess && data.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No stored job matches. Widen the dates or clear a filter.</p>
          )}
          {jobs.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the jobs.</p>}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-2 text-sm">
          <span className="text-muted-foreground tabular-nums">
            {from}–{to} of {total}
          </span>
          <div className="flex items-center gap-2">
            <select
              aria-label="Rows per page"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={pageSize}
              onChange={(event) => update({ pageSize: event.target.value === '25' ? undefined : event.target.value })}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page * pageSize >= total} onClick={() => update({ page: String(page + 1) })}>
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      {selected !== undefined && <JobPanel source={selected.source} id={selected.id} onClose={close} />}
    </div>
  );
}

function JobPanel({ source, id, onClose }: { source: string; id: string; onClose: () => void }) {
  const job = useQuery({ queryKey: ['job', source, id], queryFn: () => api.job(source, id), retry: false });
  return (
    <DetailPanel title={job.data?.title ?? 'Job'} onClose={onClose}>
      {job.isError && <p className="text-sm text-muted-foreground">That job is no longer stored.</p>}
      {job.data && <JobBody job={job.data} />}
    </DetailPanel>
  );
}

function JobBody({ job }: { job: JobDetail }) {
  const href = safeHttpsUrl(job.url);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div>
        <div className="text-base font-semibold">{job.title ?? 'Untitled'}</div>
        <div className="text-sm text-muted-foreground">
          {job.company ?? '–'}
          {job.location !== null && ` · ${job.location}`}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{job.source}</Badge>
        {job.board !== null && <Badge variant="outline">{job.board}</Badge>}
        {href !== undefined && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open on the site <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First seen">{new Date(job.firstSeen).toLocaleString()}</Field>
        <Field label="Last seen">{new Date(job.lastSeen).toLocaleString()}</Field>
        <Field label="Text read">{new Date(job.fetchedAt).toLocaleString()}</Field>
        <Field label="Length">{compact(job.descriptionChars)} characters</Field>
        {job.salary !== null && <Field label="Salary (yearly)">{formatSalary(job.salary)}</Field>}
      </div>
      {job.foundBy.length > 0 && <JobSearches source={job.source} searches={job.foundBy} />}
      {(job.hints.remote.length > 0 || job.hints.years.length > 0 || job.hints.salary !== null) && (
        <Field label="Hints">
          <span className="flex flex-wrap gap-1">
            {job.hints.years.map((item) => (
              <Badge key={`y-${item}`} variant="outline">
                {item}+ years
              </Badge>
            ))}
            {job.hints.remote.map((item) => (
              <Badge key={`r-${item}`} variant="outline">
                {item}
              </Badge>
            ))}
            {job.hints.salary !== null && <Badge variant="warning">{job.hints.salary}</Badge>}
          </span>
        </Field>
      )}
      {job.summary !== '' && (
        <details open>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Summary{job.summaryKind === 'excerpt' ? ' (no headings found: the start of the text)' : ''}
          </summary>
          <p className="mt-1 text-sm whitespace-pre-wrap">{job.summary}</p>
        </details>
      )}
      {job.outline.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Sections</summary>
          <ul className="mt-1 text-sm">
            {job.outline.map((section) => (
              <li key={section.part} className="flex justify-between">
                <span>{section.part}</span>
                <span className="tabular-nums text-muted-foreground">{section.chars}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details open>
        <summary className="cursor-pointer text-xs text-muted-foreground">Description</summary>
        <div className="relative mt-1 rounded-md border bg-muted/40">
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1 h-7"
            aria-label="Copy the description"
            onClick={() => {
              void navigator.clipboard?.writeText(job.description).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <div
            aria-label="Description"
            className="max-h-[28rem] overflow-auto p-3 pr-16 text-sm leading-relaxed whitespace-pre-wrap break-words"
          >
            {job.description}
          </div>
        </div>
      </details>
    </>
  );
}
