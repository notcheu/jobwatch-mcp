import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_ADAPTER_FILE_BYTES,
  NEW_CUSTOM_HANDLE_LENGTH,
  SUGGESTED_HANDLE_SUFFIX,
  adapterFileName,
  adapterFileText,
  customFilterSchema,
  filterDocItems,
  customToolName,
  filterProblems,
  isNewCustomHandle,
  parseAdapterFile,
  type CustomAdapter,
  type CustomAdapterFile,
  type CustomFilter,
} from '@jobwatch/dashboard-api';
import { AlertTriangle, BookOpen, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CodeEditor } from '@/components/CodeEditor';
import { CustomFilters } from '@/components/CustomFilters';
import { ScriptDocs } from '@/components/ScriptDocs';
import { useChangeError } from '@/components/Discovery';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, navigation } from '@/lib/api';
import { downloadText, readTextFile } from '@/lib/download';
import { ago } from '@/lib/format';

type Kind = 'http' | 'browser';

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'http', label: 'HTTP', hint: 'The script gets http (get, postJson) and the helpers. No browser: light and fast.' },
  {
    value: 'browser',
    label: 'Browser',
    hint: 'The script also gets session: the page of its own Chrome (goto, text, evaluate...). It shares the one-browser-at-a-time budget with the other browser adapters.',
  },
];

/** Dialog content, mounted only while it is open, so every opening starts from what the router says now. */
function AdapterForm({
  handle,
  initial,
  onClose,
  onReauth,
  onNotice,
}: {
  handle: string | undefined;
  /** An adapter read from a file on the page: it fills the form of a new adapter when it opens. */
  initial?: { file: CustomAdapterFile; fileName: string };
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
  const [filters, setFilters] = useState<CustomFilter[]>([]);
  const untouched = useRef(initial === undefined); // the script is still a sample: changing the context may swap it for the other sample
  const fileInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<string | undefined>(initial?.fileName);
  const [importError, setImportError] = useState<string>();
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
    setFilters(found.filters);
  }, [existing.data]);
  useEffect(() => {
    if (!editing && untouched.current && sample.data !== undefined) setScript(sample.data.script);
  }, [editing, sample.data]);

  /** Puts an adapter read from a file into the form. Nothing is saved: the person reads it and presses Create or Save. */
  const apply = (file: CustomAdapterFile, fileName: string): void => {
    untouched.current = false;
    if (!editing) setNewHandle(file.handle); // an adapter that is edited keeps its own handle, which cannot change
    setName(file.name);
    setKind(file.kind);
    setUrl(file.url);
    setScript(file.script);
    setFilters(file.filters);
    setImported(fileName);
    setImportError(undefined);
  };
  useEffect(() => {
    if (initial !== undefined) apply(initial.file, initial.fileName);
    // once, when the form opens on a file
  }, []);
  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const read = await readTextFile(file, MAX_ADAPTER_FILE_BYTES);
    if ('error' in read) return setImportError(read.error);
    const parsed = parseAdapterFile(read.text);
    if ('error' in parsed) return setImportError(parsed.error);
    apply(parsed.file, file.name);
  };

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.updateCustomAdapter(handle, { name: name.trim(), kind, url: url.trim(), script, filters })
        : api.createCustomAdapter({ handle: newHandle.trim(), name: name.trim(), kind, url: url.trim(), script, filters }),
    onSuccess: (saved) => {
      onNotice(
        editing
          ? `${saved.name} saved.${saved.enabled ? ' The new script applies to the next call.' : ''}${
              // the filters are part of the tool's schema, which the connector lists once: a change of them needs a reconnect
              saved.enabled && JSON.stringify(saved.filters) !== JSON.stringify(existing.data?.filters ?? [])
                ? ' Reconnect the Claude connector to see the new tool list.'
                : ''
            }`
          : `${saved.name} created. Turn it on to list its tool.`,
      );
      void client.invalidateQueries({ queryKey: ['custom-adapters'] });
      void client.invalidateQueries({ queryKey: ['custom-adapter', saved.handle] });
      void client.invalidateQueries({ queryKey: ['tools'] });
      onClose();
    },
    onError: (failure) => fail(failure, 'The adapter could not be saved.'),
  });
  // the built-in filters are what the router's reference lists for the Filters table: they are locked here, and their names are taken
  const builtin = useMemo(() => sample.data?.docs.find((block) => block.id === 'filters')?.items ?? [], [sample.data]);
  const problems = useMemo(() => filterProblems(filters, ['boards', ...builtin.map((item) => item.name)]), [filters, builtin]);
  // the reference follows the filters as they are typed: a filter shows in the Filters table as soon as it is complete
  const docs = useMemo(() => {
    if (sample.data === undefined) return undefined;
    const complete = filters.flatMap((filter) => {
      const parsed = customFilterSchema.safeParse(filter);
      return parsed.success && !builtin.some((item) => item.name === parsed.data.name) ? [parsed.data] : [];
    });
    return sample.data.docs.map((block) =>
      block.id === 'filters' ? { ...block, items: [...block.items, ...filterDocItems(complete)] } : block,
    );
  }, [sample.data, filters, builtin]);
  const valid =
    name.trim() !== '' &&
    (editing || isNewCustomHandle(newHandle.trim())) &&
    /^https:\/\/[^\s/]+/.test(url.trim()) &&
    script.trim() !== '' &&
    problems.size === 0;
  const kindHint = KINDS.find((entry) => entry.value === kind)?.hint;
  // the file for what is in the form now (saved or not), only when it would be read back as a valid adapter
  const exportHandle = editing ? handle : newHandle.trim();
  const exportText = useMemo(() => {
    const text = adapterFileText({ handle: exportHandle, name: name.trim(), kind, url: url.trim(), script, filters });
    return 'file' in parseAdapterFile(text) ? text : undefined;
  }, [exportHandle, name, kind, url, script, filters]);

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
          <div className="-mt-1 flex shrink-0 items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              aria-label="Adapter file to import"
              className="hidden"
              onChange={(event) => {
                void importFile(event.target.files?.[0]);
                event.target.value = ''; // the same file can be chosen again
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={editing && existing.data === undefined}
              title="Fill the form from an exported adapter file. Nothing is created until you press Create."
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="size-4" /> Import
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exportText === undefined}
              title={
                exportText === undefined
                  ? 'Fill in the name, the handle, the address and the script first.'
                  : `Save ${adapterFileName(exportHandle)}, to share this adapter. It holds what is in the form now.`
              }
              onClick={() => exportText !== undefined && downloadText(adapterFileName(exportHandle), exportText)}
            >
              <Download className="size-4" /> Export
            </Button>
          </div>
        </div>
        <DialogDescription>
          Its script runs in a sandbox with no network of its own and reads one site: what it finds goes through the same filters and
          storage as the other company-board tools. It never changes anything on a site.
        </DialogDescription>
      </DialogHeader>
      {importError !== undefined && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {importError}
        </p>
      )}
      {imported !== undefined && importError === undefined && (
        <p role="status" className="shrink-0 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          Filled in from <code>{imported}</code>. Nothing is saved yet. Read the script before you {editing ? 'save' : 'create'} it: it will
          run on this router, in the sandbox
          {editing ? ', and it replaces the script of this adapter' : ''}.
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)_minmax(20rem,28rem)] md:overflow-hidden">
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
                maxLength={NEW_CUSTOM_HANDLE_LENGTH.max}
                placeholder={`acme${SUGGESTED_HANDLE_SUFFIX}`}
                aria-invalid={!editing && newHandle !== '' && !isNewCustomHandle(newHandle) ? true : undefined}
                onChange={(event) => setNewHandle(event.target.value.toLowerCase())}
              />
              <p className="text-xs text-muted-foreground">
                {editing
                  ? 'It cannot change.'
                  : `The whole name of the adapter, with nothing added to it: ${NEW_CUSTOM_HANDLE_LENGTH.min} to ${NEW_CUSTOM_HANDLE_LENGTH.max} lower-case letters, digits and hyphens. We suggest ending it with ${SUGGESTED_HANDLE_SUFFIX}, as in acme${SUGGESTED_HANDLE_SUFFIX}.`}{' '}
                The tool is <code>{editing ? (existing.data?.tool ?? '…') : customToolName(newHandle) || 'name'}</code>.
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
          {docsOpen && docs !== undefined && <ScriptDocs id={docsId} blocks={docs} className="max-h-80 shrink-0 md:max-h-[45%]" />}
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
        <CustomFilters builtin={builtin} filters={filters} problems={problems} onChange={setFilters} />
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
  // The edit form is driven by the address, `?edit=<id of the adapter>`, so that a link opens it (the "See adapter" item of Tools & status),
  // a reload keeps it, and Back closes it. A new adapter, or one read from a file, is a form the address does not carry.
  const [params, setParams] = useSearchParams();
  const editId = params.get('edit');
  const [created, setCreated] = useState<{ initial?: { file: CustomAdapterFile; fileName: string } } | undefined>();
  const items = list.data?.items ?? [];
  const editTarget =
    editId === null ? undefined : (items.find((entry) => entry.id === editId) ?? items.find((entry) => entry.handle === editId));
  const form: { handle?: string; initial?: { file: CustomAdapterFile; fileName: string } } | undefined =
    editTarget !== undefined ? { handle: editTarget.handle } : created;
  const openEdit = (entry: CustomAdapter): void => {
    setCreated(undefined);
    setParams({ edit: entry.id });
  };
  const closeForm = (): void => {
    setCreated(undefined);
    if (editId !== null) setParams({}, { replace: true });
  };
  // a link to an adapter that is not there (deleted, or mistyped): say so once the list is known, and drop the parameter
  const unknownEdit = editId !== null && list.isSuccess && editTarget === undefined;
  useEffect(() => {
    if (unknownEdit) setParams({}, { replace: true });
  }, [unknownEdit, setParams]);
  const [unknownNote, setUnknownNote] = useState<string>();
  useEffect(() => {
    if (unknownEdit) setUnknownNote(`No custom adapter is called "${editId}".`);
  }, [unknownEdit, editId]);
  const pageFile = useRef<HTMLInputElement>(null);
  const [pageImportError, setPageImportError] = useState<string>();
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
      {unknownNote !== undefined && (
        <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
          {unknownNote}
        </p>
      )}
      {pageImportError !== undefined && (
        <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
          {pageImportError}
        </p>
      )}
      <div className="flex items-center gap-2 border-b px-5 py-2">
        <span className="text-xs text-muted-foreground">
          An adapter is code you write: it runs only in the sandbox, reads one site and changes nothing on it.
        </span>
        <input
          ref={pageFile}
          type="file"
          accept=".json,application/json"
          aria-label="Adapter file to open"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file === undefined) return;
            void readTextFile(file, MAX_ADAPTER_FILE_BYTES).then((read) => {
              const parsed = 'error' in read ? read : parseAdapterFile(read.text);
              if ('error' in parsed) return setPageImportError(parsed.error);
              setPageImportError(undefined);
              setCreated({ initial: { file: parsed.file, fileName: file.name } });
            });
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={!available}
          title="Open the form filled in from an exported adapter file"
          onClick={() => pageFile.current?.click()}
        >
          <Upload className="size-4" /> Import adapter
        </Button>
        <Button size="sm" disabled={!available} onClick={() => setCreated({})}>
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
                      onClick={() => openEdit(adapter)}
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
      <Dialog open={form !== undefined} onOpenChange={(next) => !next && closeForm()}>
        {/* always the whole window, with a margin all round so it still reads as a window: the settings, the script and the filters side by side */}
        <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col">
          {form !== undefined && (
            <AdapterForm
              handle={form.handle}
              {...(form.initial ? { initial: form.initial } : {})}
              onClose={closeForm}
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
