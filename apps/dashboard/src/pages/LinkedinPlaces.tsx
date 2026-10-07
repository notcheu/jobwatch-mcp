import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlaceLookups } from '@jobwatch/dashboard-api';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { DiscoveryBanners, PAGE_SIZE, Pager, useChangeError } from '@/components/Discovery';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

type Lookup = PlaceLookups['items'][number];

/** What LinkedIn suggested for each place name looked up, newest first, with a button to remember a name for a place. */
function Log({ onReauth, onNotice }: { onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const lookups = useQuery({ queryKey: ['place-lookups', page], queryFn: () => api.placeLookups({ page, pageSize: PAGE_SIZE }) });
  const { error, clear, fail } = useChangeError(onReauth);
  const assign = useMutation({
    mutationFn: (entry: { alias: string; id: string; label: string }) => api.savePlace(entry),
    onSuccess: (place) => {
      clear();
      onNotice(`"${place.alias}" now means ${place.label} (geoId ${place.id}).`);
      void client.invalidateQueries({ queryKey: ['place-lookups'] });
      void client.invalidateQueries({ queryKey: ['places'] });
    },
    onError: (failure) => fail(failure, 'The place could not be saved.'),
  });
  const items = lookups.data?.items ?? [];

  const row = (lookup: Lookup) => (
    <TableRow key={lookup.id}>
      <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(lookup.at).toLocaleString()}>
        {ago(lookup.at)}
      </TableCell>
      <TableCell className="max-w-48 font-medium break-words">{lookup.query}</TableCell>
      <TableCell>
        <Badge variant="outline">{lookup.source === 'search' ? 'A search' : 'The tool'}</Badge>
      </TableCell>
      <TableCell>
        {lookup.hits.length === 0 ? (
          <span className="text-muted-foreground">LinkedIn suggested nothing</span>
        ) : (
          <ul className="space-y-1">
            {lookup.hits.map((hit) => (
              <li key={hit.id} className="flex flex-wrap items-center gap-2">
                <span>{hit.label}</span>
                <code className="text-xs text-muted-foreground">{hit.id}</code>
                {hit.saved === 'same' ? (
                  <Badge variant="outline">Saved</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={assign.isPending}
                    aria-label={`${hit.saved === 'other' ? 'Use' : 'Assign'} ${hit.label} for ${lookup.query}`}
                    onClick={() => assign.mutate({ alias: lookup.query, id: hit.id, label: hit.label })}
                  >
                    {hit.saved === 'other' ? 'Use instead' : 'Assign'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
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
              <TableHead>Place</TableHead>
              <TableHead>Asked by</TableHead>
              <TableHead>What LinkedIn suggested</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{items.map(row)}</TableBody>
        </Table>
        {lookups.isSuccess && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No place was looked up yet. A LinkedIn search with a place name, or the <code>linkedin_locations</code> tool, logs it here.
          </p>
        )}
        {lookups.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the lookups.</p>}
      </div>
      <Pager page={page} total={lookups.data?.total ?? 0} onPage={setPage} />
    </div>
  );
}

function AddForm({ onClose, onReauth, onNotice }: { onClose: () => void; onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [alias, setAlias] = useState('');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const { error, fail } = useChangeError(() => {
    onClose();
    onReauth();
  });
  const add = useMutation({
    mutationFn: () => api.savePlace({ alias: alias.trim(), id: id.trim(), ...(label.trim() === '' ? {} : { label: label.trim() }) }),
    onSuccess: (place) => {
      onNotice(`"${place.alias}" now means ${place.label} (geoId ${place.id}).`);
      void client.invalidateQueries({ queryKey: ['places'] });
      void client.invalidateQueries({ queryKey: ['place-lookups'] });
      onClose();
    },
    onError: (failure) => fail(failure, 'The place could not be saved.'),
  });
  const valid = alias.trim().length >= 2 && /^\d{3,12}$/.test(id.trim());
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !add.isPending) add.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Remember a place</DialogTitle>
        <DialogDescription>
          A LinkedIn search that is given this name as <code>geo</code> uses this geoId, and replaces what the name meant before.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <label htmlFor="place-alias" className="text-sm font-medium">
          Name
        </label>
        <Input id="place-alias" value={alias} maxLength={60} placeholder="home" onChange={(e) => setAlias(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="place-id" className="text-sm font-medium">
            LinkedIn geoId
          </label>
          <Input
            id="place-id"
            value={id}
            inputMode="numeric"
            maxLength={12}
            placeholder="103035651"
            onChange={(e) => setId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="place-label" className="text-sm font-medium">
            Label (optional)
          </label>
          <Input id="place-label" value={label} maxLength={200} placeholder="Berlin, Germany" onChange={(e) => setLabel(e.target.value)} />
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
          Save place
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Every name remembered for a LinkedIn place, searchable, with a form to add one by hand. */
function Places({ onReauth, onNotice }: { onReauth: () => void; onNotice: (message: string) => void }) {
  const client = useQueryClient();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const places = useQuery({ queryKey: ['places', q, page], queryFn: () => api.places({ q, page, pageSize: PAGE_SIZE }) });
  const { error, clear, fail } = useChangeError(onReauth);
  const forget = useMutation({
    mutationFn: (alias: string) => api.forgetPlace(alias),
    onSuccess: () => {
      clear();
      void client.invalidateQueries({ queryKey: ['places'] });
      void client.invalidateQueries({ queryKey: ['place-lookups'] });
    },
    onError: (failure) => fail(failure, 'The name could not be forgotten.'),
  });
  const items = places.data?.items ?? [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
        <Input
          aria-label="Search places"
          placeholder="Search by name, label or geoId"
          className="w-64"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPage(1);
          }}
        />
        <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add place
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
              <TableHead>Name</TableHead>
              <TableHead>LinkedIn place</TableHead>
              <TableHead>geoId</TableHead>
              <TableHead>Saved by</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((place) => (
              <TableRow key={place.alias}>
                <TableCell className="max-w-48 font-medium break-words">{place.alias}</TableCell>
                <TableCell>{place.label}</TableCell>
                <TableCell>
                  <code className="text-xs">{place.id}</code>
                </TableCell>
                <TableCell>
                  <Badge variant={place.savedBy === 'operator' ? 'secondary' : 'outline'}>
                    {place.savedBy === 'operator' ? 'You' : 'A search'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Forget ${place.alias}`}
                    disabled={forget.isPending}
                    onClick={() => forget.mutate(place.alias)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {places.isSuccess && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {q === '' ? 'No place is remembered yet. Assign one from the log, or add one here.' : 'No place matches.'}
          </p>
        )}
        {places.isError && <p className="p-8 text-center text-sm text-destructive">Could not load the places.</p>}
      </div>
      <Pager page={page} total={places.data?.total ?? 0} onPage={setPage} />
      <Dialog open={adding} onOpenChange={(next) => !next && setAdding(false)}>
        <DialogContent className="max-w-md">
          {adding && <AddForm onClose={() => setAdding(false)} onReauth={onReauth} onNotice={onNotice} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The places LinkedIn searches use: the log of the lookups, and the names remembered for a geoId (looked up by a search, or set by you). */
export function LinkedinPlaces() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'places' ? 'places' : 'log';
  const [notice, setNotice] = useState<string>();
  const [reauth, setReauth] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b px-5 py-2">
        <Tabs
          value={view}
          onValueChange={(value) => {
            const next = new URLSearchParams(params);
            if (value === 'places') next.set('view', 'places');
            else next.delete('view');
            setParams(next);
            setNotice(undefined);
          }}
        >
          <TabsList aria-label="LinkedIn places">
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="places">Saved places</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <DiscoveryBanners utility="linkedin-geo" reauth={reauth} notice={notice} />
      {view === 'log' ? (
        <Log onReauth={() => setReauth(true)} onNotice={setNotice} />
      ) : (
        <Places onReauth={() => setReauth(true)} onNotice={setNotice} />
      )}
    </div>
  );
}
