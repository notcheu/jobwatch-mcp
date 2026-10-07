import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomAdapter } from '@jobwatch/dashboard-api';
import { AlertTriangle, BookOpen, Maximize2, Minimize2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { CodeEditor } from '@/components/CodeEditor';
import { ScriptDocs } from '@/components/ScriptDocs';
import { useChangeError } from '@/components/Discovery';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, navigation } from '@/lib/api';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';

type Kind = 'http' | 'browser';

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'http', label: 'HTTP', hint: 'The script gets http (get, postJson) and the helpers. No browser: light and fast.' },
  {
    value: 'browser',
    label: 'Browser',
    hint: 'The script also gets session: the page of its own Chrome (goto, text, evaluate...). It shares the one-browser-at-a-time budget with the other browser adapters.',
  },
];

const HANDLE = /^[a-z][a-z0-9]{1,23}$/;

/** Dialog content, mounted only while it is open, so every opening starts from what the router says now. */
function AdapterForm({
  handle,
  expanded,
  onToggleExpanded,
  onClose,
  onReauth,
  onNotice,
}: {
  handle: string | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onReauth: () => void;
  onNotice: (message: string) => void;
}) {
  const client = useQueryClient();
  const editing = handle !== undefined;
  const existing = useQuery({ queryKey: ['custom-adapter', handle], queryFn: () => api.customAdapter(handle as string), enabled: editing });
  const [name, setName] = useState('');
  const [newHandle, setNewHandle] = useState('');
  const [kind, setKind] = useState<Kind>('http');
  const [url, setUrl] = useState('https://');
  const [script, setScript] = useState('');
  const untouched = useRef(true); // the script is still a sample: changing the context may swap it for the other sample
  const loaded = useRef(false);
  // the sample gives a new adapter its script; the reference of the context is shown whether the adapter is new or not
  const sample = useQuery({
    queryKey: ['custom-adapter-sample', kind],
    queryFn: () => api.customAdapterSample(kind),
    placeholderData: (previous) => previous, // the reference stays while the other context's loads
  });
  const [docsOpen, setDocsOpen] = useState(false);
  const docsId = useId();
  const { error, fail } = useChangeError(() => {
    onClose();
    onReauth();
  });

  useEffect(() => {
    const found = existing.data;
    if (found === undefined || loaded.current) return;
    loaded.current = true;
    untouched.current = false;
    setName(found.name);
    setKind(found.kind);
    setUrl(found.url);
    setScript(found.script);
  }, [existing.data]);
  useEffect(() => {
    if (!editing && untouched.current && sample.data !== undefined) setScript(sample.data.script);
  }, [editing, sample.data]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.updateCustomAdapter(handle, { name: name.trim(), kind, url: url.trim(), script })
        : api.createCustomAdapter({ handle: newHandle.trim(), name: name.trim(), kind, url: url.trim(), script }),
    onSuccess: (saved) => {
      onNotice(
        editing
          ? `${saved.name} saved.${saved.enabled ? ' The new script applies to the next call.' : ''}`
          : `${saved.name} created. Turn it on to list its tool.`,
      );
      void client.invalidateQueries({ queryKey: ['custom-adapters'] });
      void client.invalidateQueries({ queryKey: ['custom-adapter', saved.handle] });
      void client.invalidateQueries({ queryKey: ['tools'] });
      onClose();
    },
    onError: (failure) => fail(failure, 'The adapter could not be saved.'),
  });
  const valid =
    name.trim() !== '' && (editing || HANDLE.test(newHandle.trim())) && /^https:\/\/[^\s/]+/.test(url.trim()) && script.trim() !== '';
  const kindHint = KINDS.find((entry) => entry.value === kind)?.hint;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader className="shrink-0">
        <div className="flex items-start justify-between gap-3">
          <DialogTitle>{editing ? `Edit ${existing.data?.name ?? handle}` : 'Create a custom adapter'}</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mt-1 -mr-2 size-8 shrink-0"
            aria-label={expanded ? 'Shrink the window' : 'Expand the window'}
            aria-pressed={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </div>
        <DialogDescription>
          Its script runs in a sandbox with no network of its own and reads one site: what it finds goes through the same filters and
          storage as the other company-board tools. It never changes anything on a site.
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-[minmax(15rem,21rem)_minmax(0,1fr)] md:overflow-hidden">
        <div className="min-h-0 space-y-4 md:overflow-auto md:pr-1">
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="custom-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="custom-name"
                value={name}
                maxLength={60}
                placeholder="Acme careers"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="custom-handle" className="text-sm font-medium">
                Handle
              </label>
              <Input
                id="custom-handle"
                value={editing ? handle : newHandle}
                disabled={editing}
                maxLength={24}
                placeholder="acmejobs"
                aria-invalid={!editing && newHandle !== '' && !HANDLE.test(newHandle) ? true : undefined}
                onChange={(event) => setNewHandle(event.target.value.toLowerCase())}
              />
              <p className="text-xs text-muted-foreground">
                {editing ? 'It cannot change.' : '2 to 24 lower-case letters and digits.'} The tool is{' '}
                <code>custom_{(editing ? handle : newHandle) || 'handle'}</code>.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="custom-kind" className="text-sm font-medium">
                Context
              </label>
              <select
                id="custom-kind"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value as Kind)}
              >
                {KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{kindHint}</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="custom-url" className="text-sm font-medium">
                URL target
              </label>
              <Input
                id="custom-url"
                value={url}
                maxLength={300}
                placeholder="https://careers.acme.com"
                onChange={(event) => setUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">The one https host the script may reach.</p>
            </div>
          </div>
          {editing && existing.data !== undefined && existing.data.events.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">History ({existing.data.events.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {existing.data.events.map((event, index) => (
                  <li key={index} className="flex gap-2 text-muted-foreground">
                    <span title={new Date(event.at).toLocaleString()}>{ago(event.at)}</span>
                    <span>{event.actor}</span>
                    <span className="font-medium text-foreground">{event.action}</span>
                    {event.sha256 !== null && <code title="SHA-256 of the script">{event.sha256.slice(0, 8)}</code>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div className="flex min-h-80 min-w-0 flex-col gap-1 md:min-h-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Script</div>
            <Button
              type="button"
              variant={docsOpen ? 'secondary' : 'ghost'}
              size="icon"
              className="size-7"
              aria-label={docsOpen ? 'Hide the documentation' : 'Show the documentation'}
              aria-expanded={docsOpen}
              aria-controls={docsId}
              title="Documentation: the globals and the shapes of the input and the output"
              onClick={() => setDocsOpen((value) => !value)}
            >
              <BookOpen className="size-4" />
            </Button>
          </div>
          {docsOpen && sample.data !== undefined && (
            <ScriptDocs id={docsId} blocks={sample.data.docs} className="max-h-80 shrink-0 md:max-h-[45%]" />
          )}
          {docsOpen && sample.data === undefined && (
            <p id={docsId} className="text-xs text-muted-foreground">
              {sample.isError ? 'The documentation could not be loaded.' : 'Loading the documentation…'}
            </p>
          )}
          <CodeEditor
            label="Script"
            className="min-h-0 flex-1"
            value={script}
            onChange={(next) => {
              untouched.current = false;
              setScript(next);
            }}
          />
        </div>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="shrink-0">
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || save.isPending || (editing && existing.data === undefined)}>
          {editing ? 'Save' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The adapters an operator wrote: a list with a switch each, a form with a small code editor to create or change one. */
export function CustomAdapters() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['custom-adapters'], queryFn: api.customAdapters, refetchInterval: 10_000 });
  const [form, setForm] = useState<{ handle?: string } | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [reauth, setReauth] = useState(false);
  const [removing, setRemoving] = useState<CustomAdapter>();
  const { error, clear, fail } = useChangeError(() => setReauth(true));
  const toggle = useMutation({
    mutationFn: (entry: { handle: string; enabled: boolean }) => api.setCustomAdapterEnabled(entry.handle, entry.enabled),
    onSuccess: (saved) => {
      clear();
      setNotice(`${saved.name} ${saved.enabled ? 'turned on' : 'turned off'}. Reconnect the Claude connector to see the new tool list.`);
      void client.invalidateQueries({ queryKey: ['custom-adapters'] });
      void client.invalidateQueries({ queryKey: ['tools'] });
    },
    onError: (failure) => fail(failure, 'The change failed.'),
  });
  const remove = useMutation({
    mutationFn: (handle: string) => api.deleteCustomAdapter(handle),
    onSuccess: () => {
      clear();
      setRemoving(undefined);
      void client.invalidateQueries({ queryKey: ['custom-adapters'] });
      void client.invalidateQueries({ queryKey: ['tools'] });
    },
    onError: (failure) => {
      setRemoving(undefined);
      fail(failure, 'The adapter could not be deleted.');
    },
  });
  const items = list.data?.items ?? [];
  const available = list.data?.available ?? false;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {list.data !== undefined && !available && (
        <p role="note" className="border-b border-warning/40 bg-warning/10 px-5 py-2 text-sm">
          Custom adapters are off. Set <code>CUSTOM_ADAPTERS=on</code> in the router environment and restart it: until then nothing here is
          loaded and no change is accepted.
        </p>
      )}
      {available && list.data?.sandbox === 'process' && (
        <p role="alert" className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-5 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            The scripts run in a bare Node process, with no container and no memory or CPU cap (<code>CUSTOM_ADAPTERS_SANDBOX=process</code>
            ): for local development only. Use the docker sandbox anywhere else.
          </span>
        </p>
      )}
      {reauth && (
        <div role="alert" className="flex items-center justify-between border-b border-warning/40 bg-warning/10 px-5 py-2 text-sm">
          <span>Changes need a recent sign-in. Sign in again to continue.</span>
          <Button size="sm" onClick={() => navigation.toReauth()}>
            Sign in again
          </Button>
        </div>
      )}
      {notice !== undefined && (
        <p role="status" className="border-b bg-success/10 px-5 py-2 text-sm">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-b px-5 py-2">
        <span className="text-xs text-muted-foreground">
          An adapter is code you write: it runs only in the sandbox, reads one site and changes nothing on it.
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!available}
          onClick={() => {
            setExpanded(false);
            setForm({});
          }}
        >
          <Plus className="size-4" /> Create adapter
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>On</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((adapter) => (
              <TableRow key={adapter.handle}>
                <TableCell className="max-w-56 font-medium break-words">
                  {adapter.name}
                  {adapter.problem !== null && <p className="text-xs font-normal text-destructive">Not loaded: {adapter.problem}</p>}
                </TableCell>
                <TableCell>
                  <code className="text-xs">{adapter.tool}</code>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{adapter.kind === 'browser' ? 'Browser' : 'HTTP'}</Badge>
                </TableCell>
                <TableCell className="text-xs">{adapter.host}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(adapter.updatedAt).toLocaleString()}>
                  {ago(adapter.updatedAt)}
                </TableCell>
                <TableCell>
                  <Switch
                    aria-label={`${adapter.name} on`}
                    checked={adapter.enabled}
                    disabled={!available || toggle.isPending}
                    onCheckedChange={(enabled) => toggle.mutate({ handle: adapter.handle, enabled })}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Edit ${adapter.name}`}
                      onClick={() => {
                        setExpanded(false);
                        setForm({ handle: adapter.handle });
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Delete ${adapter.name}`}
                      disabled={!available}
                      onClick={() => setRemoving(adapter)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {list.isSuccess && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No custom adapter yet. Create one to read a site no ready-made adapter covers.
          </p>
        )}
        {list.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the custom adapters.</p>}
      </div>
      <Dialog open={form !== undefined} onOpenChange={(next) => !next && setForm(undefined)}>
        <DialogContent
          data-expanded={expanded}
          className={cn(
            'flex max-w-none flex-col',
            // the window leaves a margin all round when it is expanded, so it still reads as a window
            expanded ? 'h-[calc(100vh-2rem)] w-[calc(100vw-2rem)]' : 'h-[min(46rem,92vh)] w-[min(72rem,94vw)]',
          )}
        >
          {form !== undefined && (
            <AdapterForm
              handle={form.handle}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((value) => !value)}
              onClose={() => setForm(undefined)}
              onReauth={() => setReauth(true)}
              onNotice={setNotice}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== undefined} onOpenChange={(next) => !next && setRemoving(undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>Its script is removed and its tool goes. The jobs it stored are kept until they expire.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing !== undefined && remove.mutate(removing.handle)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
