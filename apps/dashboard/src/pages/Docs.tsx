import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, getExpandedRowModel, useReactTable } from '@tanstack/react-table';
import type { ModuleDoc, ParamDoc, ToolDoc } from '@jobwatch/dashboard-api';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** Copies `text`; says so for two seconds. A browser that refuses the clipboard shows "Copy failed" instead of nothing. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
      } catch {
        setState('failed');
      }
      setTimeout(() => setState('idle'), 2000);
    })();
  };
  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" aria-label={label} onClick={copy}>
      {state === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </Button>
  );
}

function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="rounded-md border bg-muted/40">
      <div className="flex justify-end border-b px-1 py-0.5">
        <CopyButton text={text} label={label} />
      </div>
      <pre className="overflow-auto p-3 text-xs">{text}</pre>
    </div>
  );
}

/** The three hints of a tool, each with what it means for the reader. */
function Annotations({ tool }: { tool: ToolDoc }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant="success" title="The tool reads and never changes anything on the platform.">
        read-only
      </Badge>
      {tool.annotations.idempotent && (
        <Badge variant="secondary" title="Calling it again with the same arguments changes nothing more.">
          idempotent
        </Badge>
      )}
      {tool.annotations.openWorld && (
        <Badge variant="outline" title="It reaches a site outside the router.">
          open-world
        </Badge>
      )}
      {tool.needsBrowser && (
        <Badge variant="outline" title="It runs in the browser container.">
          browser
        </Badge>
      )}
    </div>
  );
}

const param = createColumnHelper<ParamDoc>();
const paramColumns = [
  param.accessor('name', { header: 'Name', cell: (info) => <code className="text-xs">{info.getValue()}</code> }),
  param.accessor('type', { header: 'Type', cell: (info) => <code className="text-xs">{info.getValue()}</code> }),
  param.accessor('required', { header: 'Required', cell: (info) => (info.getValue() ? 'yes' : 'no') }),
  param.accessor('default', {
    header: 'Default',
    cell: (info) => (info.row.original.required ? '—' : <code className="text-xs">{JSON.stringify(info.getValue())}</code>),
  }),
  param.accessor('enum', {
    header: 'Values',
    cell: (info) => {
      const values = info.getValue();
      return values === null ? '—' : <code className="text-xs">{values.join(' | ')}</code>;
    },
  }),
  param.accessor('min', { header: 'Min', cell: (info) => info.getValue() ?? '—' }),
  param.accessor('max', { header: 'Max', cell: (info) => info.getValue() ?? '—' }),
  param.accessor('description', { header: 'Description', cell: (info) => <span className="text-xs">{info.getValue()}</span> }),
];

function ParamTable({ params }: { params: ParamDoc[] }) {
  const table = useReactTable({ data: params, columns: paramColumns, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.name });
  if (params.length === 0) return <p className="text-xs text-muted-foreground">This tool takes no arguments.</p>;
  return (
    <Table aria-label="Parameters">
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
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className="align-top">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ToolDetail({ tool, module }: { tool: ToolDoc; module: ModuleDoc }) {
  const hosts = module.openHttps ? [...module.allowedHosts, 'any public https host'] : module.allowedHosts;
  return (
    <div className="space-y-4 p-4">
      <p className="text-sm">{tool.description}</p>
      <Annotations tool={tool} />
      <div className="text-xs text-muted-foreground">
        Reaches: {hosts.join(', ')} · reserves up to {tool.costMax} budget unit{tool.costMax === 1 ? '' : 's'} per call
      </div>
      <section aria-label="Parameters" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters</h3>
        <ParamTable params={tool.params} />
      </section>
      <section aria-label="Examples" className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Examples</h3>
        {tool.examples.map((example) => (
          <div key={example.title} className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium">{example.title}</div>
            <div className="flex items-start justify-between gap-2 rounded-md bg-muted/40 p-2 text-sm">
              <span>{example.prompt}</span>
              <CopyButton text={example.prompt} label={`Copy the prompt: ${example.title}`} />
            </div>
            <CodeBlock text={json(example.input)} label={`Copy the input: ${example.title}`} />
          </div>
        ))}
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Smallest accepted input, to start from</div>
          <CodeBlock text={json(tool.sampleInput)} label={`Copy the smallest input of ${tool.name}`} />
        </div>
        {[...tool.examples.map((example) => json(example.input)), json(tool.sampleInput)].some((text) => /<[^>]+>/.test(text)) && (
          <p className="text-xs text-muted-foreground">Replace the values in &lt;angle brackets&gt; with your own before you run it.</p>
        )}
      </section>
    </div>
  );
}

const tool = createColumnHelper<ToolDoc>();

/** The tools of one module, one row each; a row opens to its full documentation. */
function ToolsTable({ module }: { module: ModuleDoc }) {
  const columns = [
    tool.accessor('name', {
      header: 'Tool',
      cell: (info) => (
        <button
          type="button"
          className="flex items-center gap-1.5 font-medium"
          aria-expanded={info.row.getIsExpanded()}
          aria-label={`${info.row.getIsExpanded() ? 'Hide' : 'Show'} ${info.getValue()}`}
          onClick={info.row.getToggleExpandedHandler()}
        >
          {info.row.getIsExpanded() ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {info.getValue()}
        </button>
      ),
    }),
    tool.accessor('title', { header: 'Title', cell: (info) => <span className="text-sm">{info.getValue()}</span> }),
    tool.display({ id: 'annotations', header: 'Hints', cell: (info) => <Annotations tool={info.row.original} /> }),
    tool.accessor('costMax', { header: 'Cost', cell: (info) => <span className="tabular-nums">{info.getValue()}</span> }),
  ];
  const table = useReactTable({
    data: module.tools,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.name,
  });
  return (
    <Table aria-label={`${module.displayName} tools`}>
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
          <Fragment key={row.id}>
            <TableRow>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
            {row.getIsExpanded() && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="bg-muted/20 p-0">
                  <ToolDetail tool={row.original} module={module} />
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function ModuleCard({ module }: { module: ModuleDoc }) {
  return (
    <Card aria-label={module.displayName}>
      <CardHeader className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm normal-case tracking-normal text-foreground">{module.displayName}</CardTitle>
          <Badge variant="secondary">{module.kind === 'browser' ? 'browser' : 'HTTP'}</Badge>
          <Badge variant={module.enabled ? 'success' : 'outline'}>{module.enabled ? 'enabled' : 'disabled'}</Badge>
          <code className="text-xs text-muted-foreground">{module.id}</code>
        </div>
        <p className="text-xs text-muted-foreground">{module.description}</p>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <ToolsTable module={module} />
      </CardContent>
    </Card>
  );
}

type Kind = 'adapters' | 'utilities';

/** What every tool does, its arguments and worked examples. Read-only: whether a module is enabled is shown, changed under Tools. */
export function Docs() {
  const [params, setParams] = useSearchParams();
  const kind: Kind = params.get('kind') === 'utilities' ? 'utilities' : 'adapters';
  const docs = useQuery({ queryKey: ['docs'], queryFn: api.docs, refetchInterval: 30_000 });
  const modules = (docs.data?.modules ?? []).filter((module) => (kind === 'adapters') === (module.role === 'adapter'));
  return (
    <div className="w-full space-y-4 overflow-auto p-5">
      <Tabs value={kind} onValueChange={(value) => setParams(value === 'utilities' ? { kind: 'utilities' } : {})}>
        <TabsList>
          <TabsTrigger value="adapters">Adapters</TabsTrigger>
          <TabsTrigger value="utilities">Utilities</TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        {kind === 'adapters'
          ? 'Adapters fetch jobs from a platform.'
          : 'Utilities are helper tools that fetch no jobs. Each has its own budget.'}{' '}
        A disabled module is documented here but Claude cannot call it: enable it under Tools &amp; status or with the CLI.
      </p>
      {modules.map((module) => (
        <ModuleCard key={module.id} module={module} />
      ))}
      {docs.isSuccess && modules.length === 0 && <p className="text-sm text-muted-foreground">Nothing is installed here.</p>}
      {docs.isError && <p className="text-sm text-destructive">Could not load the documentation.</p>}
    </div>
  );
}
