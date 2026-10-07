import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATS_IDS, type AtsLookup } from '@jobwatch/dashboard-api';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DiscoveryBanners, PAGE_SIZE, Pager, useChangeError } from '@/components/Discovery';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { safeHttpsUrl, useDebounced } from '@/lib/hooks';

function BoardLink({ url, children }: { url: string; children: string }) {
  const href = safeHttpsUrl(url);
  if (href === undefined) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      {children} <ExternalLink className="size-3" />
    </a>
  );
}

/** What the company lookups (`ats_find`) found, newest first, with a button to keep a board for a company that has none yet. */
function Log({ onReauth, onNotice }: { onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const lookups = useQuery({ queryKey: ['ats-lookups', page], queryFn: () => api.atsLookups({ page, pageSize: PAGE_SIZE }) });
  const { error, clear, fail } = useChangeError(onReauth);
  const assign = useMutation({
    mutationFn: (entry: { company: string; ats: string; handle: string }) => api.addCompanyBoard(entry),
    onSuccess: (board) => {
      clear();
      onNotice(`${board.company} is now mapped to ${board.ats}/${board.handle}.`);
      void client.invalidateQueries({ queryKey: ['ats-lookups'] });
      void client.invalidateQueries({ queryKey: ['company-boards'] });
    },
    onError: (failure) => {
      fail(failure, 'The mapping failed.');
      void client.invalidateQueries({ queryKey: ['ats-lookups'] });
    },
  });
  const items = lookups.data?.items ?? [];
  const total = lookups.data?.total ?? 0;

  const row = (lookup: AtsLookup) => (
    <TableRow key={lookup.id}>
      <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(lookup.at).toLocaleString()}>
        {ago(lookup.at)}
      </TableCell>
      <TableCell className="max-w-64 break-words font-medium">{lookup.company}</TableCell>
      <TableCell>
        {lookup.matches.length === 0 ? (
          <span className="text-muted-foreground">No board found</span>
        ) : (
          <ul className="space-y-1">
            {lookup.matches.map((match) => (
              <li key={`${match.ats}/${match.handle}`} className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{match.ats}</Badge>
                <BoardLink url={match.boardUrl}>{match.handle}</BoardLink>
                <span className="text-xs text-muted-foreground">
                  {match.jobs} job{match.jobs === 1 ? '' : 's'}
                </span>
                {match.mapped ? (
                  <Badge variant="outline">Mapped</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={assign.isPending}
                    aria-label={`Assign ${match.ats} ${match.handle} to ${lookup.company}`}
                    onClick={() => assign.mutate({ company: lookup.company, ats: match.ats, handle: match.handle })}
                  >
                    Assign
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{lookup.tried.join(', ')}</TableCell>
    </TableRow>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto">
        {error !== undefined && (
          <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Boards found</TableHead>
              <TableHead>Handles tried</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{items.map(row)}</TableBody>
        </Table>
        {lookups.isSuccess && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No company was looked up yet. The <code>ats_find</code> tool logs each lookup here.
          </p>
        )}
        {lookups.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the lookups.</p>}
      </div>
      <Pager page={page} total={total} onPage={setPage} />
    </div>
  );
}

function AddDialog({
  open,
  onClose,
  onReauth,
  onNotice,
}: {
  open: boolean;
  onClose: () => void;
  onReauth: () => void;
  onNotice: (message: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">{open && <AddForm onClose={onClose} onReauth={onReauth} onNotice={onNotice} />}</DialogContent>
    </Dialog>
  );
}

function AddForm({ onClose, onReauth, onNotice }: { onClose: () => void; onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [company, setCompany] = useState('');
  const [ats, setAts] = useState<string>(ATS_IDS[0]);
  const [handle, setHandle] = useState('');
  const { error, fail } = useChangeError(() => {
    onClose();
    onReauth();
  });
  const add = useMutation({
    mutationFn: () => api.addCompanyBoard({ company: company.trim(), ats, handle: handle.trim() }),
    onSuccess: (board) => {
      onNotice(`${board.company} is now mapped to ${board.ats}/${board.handle}.`);
      void client.invalidateQueries({ queryKey: ['company-boards'] });
      void client.invalidateQueries({ queryKey: ['ats-lookups'] });
      onClose();
    },
    onError: (failure) => fail(failure, 'The mapping failed.'),
  });
  const valid = company.trim() !== '' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(handle.trim());
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !add.isPending) add.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Map a company to a board</DialogTitle>
        <DialogDescription>
          The ATS tools read this first: a company given by name is read from this board, which they still check as usual.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <label htmlFor="mapping-company" className="text-sm font-medium">
          Company
        </label>
        <Input
          id="mapping-company"
          value={company}
          maxLength={120}
          placeholder="Société Générale"
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="mapping-ats" className="text-sm font-medium">
            ATS
          </label>
          <select
            id="mapping-ats"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={ats}
            onChange={(e) => setAts(e.target.value)}
          >
            {ATS_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="mapping-handle" className="text-sm font-medium">
            Board handle
          </label>
          <Input
            id="mapping-handle"
            value={handle}
            maxLength={60}
            placeholder="societe-generale"
            onChange={(e) => setHandle(e.target.value)}
          />
        </div>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={add.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || add.isPending}>
          Add mapping
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Every company mapped to a board, searchable by company or board name, with a form to add one by hand. */
function Mappings({ onReauth, onNotice }: { onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const [ats, setAts] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const boards = useQuery({
    queryKey: ['company-boards', q, ats, page],
    queryFn: () => api.companyBoards({ q, ats, page, pageSize: PAGE_SIZE }),
  });
  const { error, clear, fail } = useChangeError(onReauth);
  const remove = useMutation({
    mutationFn: (id: number) => api.removeCompanyBoard(id),
    onSuccess: () => {
      clear();
      void client.invalidateQueries({ queryKey: ['company-boards'] });
      void client.invalidateQueries({ queryKey: ['ats-lookups'] });
    },
    onError: (failure) => fail(failure, 'The mapping could not be removed.'),
  });
  const items = boards.data?.items ?? [];
  const total = boards.data?.total ?? 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
        <Input
          aria-label="Search companies"
          placeholder="Search by company or board"
          className="w-64"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="ATS"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={ats}
          onChange={(event) => {
            setAts(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All ATS</option>
          {ATS_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add mapping
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {error !== undefined && (
          <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Company</TableHead>
              <TableHead>ATS</TableHead>
              <TableHead>Board</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((board) => (
              <TableRow key={board.id}>
                <TableCell className="max-w-64 break-words font-medium">{board.company}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{board.ats}</Badge>
                </TableCell>
                <TableCell>
                  <code className="text-xs">{board.handle}</code>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(board.createdAt).toLocaleString()}>
                  {ago(board.createdAt)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Remove ${board.company} on ${board.ats}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(board.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {boards.isSuccess && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {q === '' && ats === '' ? 'No company is mapped yet. Assign a board from the log, or add one here.' : 'No mapping matches.'}
          </p>
        )}
        {boards.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the mappings.</p>}
      </div>
      <Pager page={page} total={total} onPage={setPage} />
      <AddDialog open={adding} onClose={() => setAdding(false)} onReauth={onReauth} onNotice={onNotice} />
    </div>
  );
}

/** Which ATS board belongs to which company: the log of the company lookups, and the map the ATS tools read first. */
export function AtsDiscovery() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'mapping' ? 'mapping' : 'log';
  const [notice, setNotice] = useState<string>();
  const [reauth, setReauth] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b px-5 py-2">
        <Tabs
          value={view}
          onValueChange={(value) => {
            const next = new URLSearchParams(params);
            if (value === 'mapping') next.set('view', 'mapping');
            else next.delete('view');
            setParams(next);
            setNotice(undefined);
          }}
        >
          <TabsList aria-label="ATS discovery">
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="mapping">Company mapping</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <DiscoveryBanners utility="ats-discovery" reauth={reauth} notice={notice} />
      {view === 'log' ? (
        <Log onReauth={() => setReauth(true)} onNotice={setNotice} />
      ) : (
        <Mappings onReauth={() => setReauth(true)} onNotice={setNotice} />
      )}
    </div>
  );
}
