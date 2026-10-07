import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { CallDetail, CallRow } from '@jobwatch/dashboard-api';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DetailPanel, Field } from '@/components/DetailPanel';
import { JsonView } from '@/components/JsonView';
import { KeywordBadges } from '@/components/KeywordBadges';
import { usePlatform } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { bytes, clock, compact, duration } from '@/lib/format';
import { cn } from '@/lib/utils';

type Outcome = 'all' | 'running' | 'ok' | 'failed';

function outcomeBadge(row: Pick<CallRow, 'state' | 'code'>) {
  if (row.state === 'running') return <Badge variant="default">running</Badge>;
  if (row.code === 'ok') return <Badge variant="success">ok</Badge>;
  if (row.code === 'rate_limited') return <Badge variant="warning">rate limited</Badge>;
  return <Badge variant="destructive">{row.code ?? 'error'}</Badge>;
}

const column = createColumnHelper<CallRow>();
const columns = [
  column.accessor('startedAt', { header: 'Time', cell: (c) => <span className="tabular-nums">{clock(c.getValue())}</span> }),
  column.accessor('tool', { header: 'Tool', cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  column.accessor('keywords', {
    header: 'Keywords',
    cell: (c) => (
      <div className="w-56 max-w-56 overflow-hidden">
        <KeywordBadges keywords={c.getValue() ?? []} empty="–" />
      </div>
    ),
  }),
  column.display({ id: 'outcome', header: 'Outcome', cell: (c) => outcomeBadge(c.row.original) }),
  column.accessor('durationMs', { header: 'Duration', cell: (c) => <span className="tabular-nums">{duration(c.getValue())}</span> }),
  column.display({
    id: 'units',
    header: 'Units',
    cell: (c) => (
      <span className="tabular-nums">
        {c.row.original.unitsSpent} / {c.row.original.unitsReserved}
      </span>
    ),
  }),
  column.accessor('responseBytes', { header: 'Size', cell: (c) => <span className="tabular-nums">{bytes(c.getValue())}</span> }),
  column.accessor('estimatedTokens', { header: '~Tokens', cell: (c) => <span className="tabular-nums">{compact(c.getValue())}</span> }),
];

export function Runs() {
  const platform = usePlatform();
  const [outcome, setOutcome] = useState<Outcome>('all');
  const params = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const selected = params['id'] === undefined ? undefined : Number(params['id']);

  const calls = useQuery({
    queryKey: ['calls', platform, outcome],
    queryFn: () =>
      api.calls({
        ...(platform === undefined ? {} : { platform }),
        ...(outcome === 'running' ? { code: 'running' } : outcome === 'ok' ? { code: 'ok' } : {}),
        limit: 100,
      }),
    refetchInterval: 3000,
  });
  const rows = useMemo(
    () => (calls.data?.calls ?? []).filter((row) => outcome !== 'failed' || (row.state === 'done' && row.code !== 'ok')),
    [calls.data, outcome],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: (row) => String(row.id) });
  const open = (id: number): void => void navigate({ pathname: `/runs/${id}`, search: search.toString() });
  const close = (): void => void navigate({ pathname: '/runs', search: search.toString() });

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-5 py-2">
          {(['all', 'running', 'ok', 'failed'] as const).map((value) => (
            <Button key={value} size="sm" variant={outcome === value ? 'secondary' : 'ghost'} onClick={() => setOutcome(value)}>
              {value === 'all' ? 'All' : value === 'running' ? 'Running' : value === 'ok' ? 'Succeeded' : 'Failed'}
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            The most recent calls, kept with their parameters and loaded again after a restart
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  data-state={selected === row.original.id ? 'selected' : undefined}
                  className="cursor-pointer"
                  onClick={() => open(row.original.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') open(row.original.id);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {calls.isSuccess && rows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No calls yet. Run a search from Claude and it shows up here.</p>
          )}
          {calls.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the calls.</p>}
        </div>
      </div>
      {selected !== undefined && Number.isInteger(selected) && <CallPanel id={selected} onClose={close} />}
    </div>
  );
}

function CallPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const call = useQuery({
    queryKey: ['call', id],
    queryFn: () => api.call(id),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 2000 : false),
    retry: false,
  });
  return (
    <DetailPanel title={call.data ? call.data.tool : `Call ${id}`} onClose={onClose}>
      {call.isError && (
        <p className="text-sm text-muted-foreground">
          That call is no longer in the call log (older than the retention, or pushed out by newer ones).
        </p>
      )}
      {call.data && <CallBody call={call.data} />}
    </DetailPanel>
  );
}

function CallBody({ call }: { call: CallDetail }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {outcomeBadge(call)}
        <Badge variant="outline">{call.platform}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Started">{new Date(call.startedAt).toLocaleString()}</Field>
        <Field label="Duration">{duration(call.durationMs)}</Field>
        <Field label="Units spent / reserved">
          {call.unitsSpent} / {call.unitsReserved}
        </Field>
        <Field label="Returned to Claude">
          {bytes(call.responseBytes)} · ~{compact(call.estimatedTokens)} tokens
        </Field>
        <Field label="Warnings">{call.warnings}</Field>
        <Field label="Adapter">{call.adapter}</Field>
        {call.keywords !== null && (
          <Field label="Keywords">
            <KeywordBadges keywords={call.keywords} />
          </Field>
        )}
        {call.jobText !== null && (
          <Field label="Job text sent / available">
            {compact(call.jobText.returned)} / {compact(call.jobText.available)} characters
          </Field>
        )}
      </div>
      <div>
        <div className={cn('mb-1 text-xs text-muted-foreground')}>Parameters</div>
        {call.params !== null ? (
          <JsonView value={call.params} label="Parameters of the call" />
        ) : (
          <p className="text-sm text-muted-foreground">{call.paramsDropped ? 'Dropped to keep the memory bounded.' : 'Not recorded.'}</p>
        )}
        {call.paramsTruncated && <p className="mt-1 text-xs text-warning">Too long to keep whole: only the start is shown.</p>}
      </div>
      <Field label="Request id">
        <code className="text-xs">{call.requestId}</code>
      </Field>
      {call.argsHash !== null && (
        <Field label="Argument hash">
          <code className="text-xs">{call.argsHash}</code>
        </Field>
      )}
    </>
  );
}
