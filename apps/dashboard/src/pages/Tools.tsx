import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ToolState } from '@jobwatch/dashboard-api';
import { AlertTriangle, Gauge, Power, RotateCcw, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BudgetDialog } from '@/components/BudgetDialog';
import { ActionsMenu } from '@/components/ui/actions-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, api, navigation } from '@/lib/api';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';

const SESSION_BADGE = {
  ok: { label: 'signed in', variant: 'success' },
  needs_login: { label: 'needs login', variant: 'destructive' },
  checkpoint: { label: 'checkpoint', variant: 'destructive' },
  unknown: { label: 'unknown', variant: 'warning' },
} as const;

function Usage({ label, used, limit }: { label: string; used: number; limit: number }) {
  const share = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div title={`${used} of ${limit} units used in the last ${label}`}>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          role="presentation"
          className={cn('h-full', share >= 90 ? 'bg-destructive' : share >= 70 ? 'bg-warning' : 'bg-primary')}
          ref={(node) => {
            if (node) node.style.width = `${share}%`;
          }}
        />
      </div>
    </div>
  );
}

function AdapterCard({ adapter, onChanged, onReauth }: { adapter: ToolState; onChanged: (message: string) => void; onReauth: () => void }) {
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setAdapter(adapter.id, enabled),
    onSuccess: (result) => {
      setError(undefined);
      onChanged(
        `${adapter.displayName} ${result.enabled ? 'enabled' : 'disabled'}. ${
          result.addedTools.length > 0 ? `Tools added: ${result.addedTools.join(', ')}. ` : ''
        }${result.removedTools.length > 0 ? `Tools removed: ${result.removedTools.join(', ')}. ` : ''}Reconnect the Claude connector to see the new tool list.`,
      );
      void client.invalidateQueries({ queryKey: ['tools'] });
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === 'reauth_required') return onReauth();
      setError(failure instanceof Error ? failure.message : 'The change failed.');
    },
  });
  const [confirmClear, setConfirmClear] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const clear = useMutation({
    mutationFn: () => api.clearData(adapter.id),
    onSuccess: (result) => {
      setError(undefined);
      setConfirmClear(false);
      onChanged(
        `${adapter.displayName}: ${result.jobs} stored job${result.jobs === 1 ? '' : 's'} and ${result.searches} search${result.searches === 1 ? '' : 'es'} removed. Its budget and history are kept.`,
      );
      void client.invalidateQueries();
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === 'reauth_required') return onReauth();
      setConfirmClear(false);
      setError(failure instanceof Error ? failure.message : 'The change failed.');
    },
  });
  return (
    <Card aria-label={adapter.displayName} className={cn(!adapter.enabled && 'opacity-80')}>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <CardTitle className="mr-1 text-sm normal-case tracking-normal text-foreground">{adapter.displayName}</CardTitle>
          <Badge variant="secondary">{adapter.role === 'utility' ? 'utility' : adapter.kind === 'browser' ? 'browser' : 'HTTP'}</Badge>
          <Badge variant={adapter.enabled ? 'success' : 'outline'}>{adapter.enabled ? 'enabled' : 'disabled'}</Badge>
          {adapter.session !== null && (
            <Badge variant={SESSION_BADGE[adapter.session.state].variant} title={adapter.session.note ?? undefined}>
              {SESSION_BADGE[adapter.session.state].label} · {ago(adapter.session.checkedAt)}
            </Badge>
          )}
          {adapter.enabled && adapter.kind === 'browser' && adapter.session === null && (
            <Badge variant="outline">session not checked</Badge>
          )}
          {adapter.breaker !== null && <Badge variant="destructive">breaker open: {adapter.breaker.reason}</Badge>}
        </div>
        <ActionsMenu
          label={`Settings of ${adapter.displayName}`}
          icon={<SettingsIcon className="size-4" />}
          actions={[
            {
              id: 'toggle',
              label: adapter.enabled ? 'Disable' : 'Enable',
              icon: <Power className="size-4" />,
              // ADAPTERS or UTILITIES sets the list: the page already says so at the top
              disabled: adapter.pinned || adapter.managed || toggle.isPending,
              hint: adapter.managed
                ? 'On while an ATS adapter is enabled'
                : adapter.pinned
                  ? `Set by ${adapter.role === 'adapter' ? 'ADAPTERS' : 'UTILITIES'}`
                  : undefined,
              onSelect: () => toggle.mutate(!adapter.enabled),
            },
            { id: 'budget', label: 'Budget…', icon: <Gauge className="size-4" />, onSelect: () => setBudgetOpen(true) },
            ...(adapter.role === 'adapter'
              ? [
                  {
                    id: 'clear',
                    label: 'Clear stored data…',
                    icon: <Trash2 className="size-4" />,
                    destructive: true,
                    onSelect: () => setConfirmClear(true),
                  },
                ]
              : []),
          ]}
        />
        <BudgetDialog
          open={budgetOpen}
          id={adapter.id}
          name={adapter.displayName}
          budget={adapter.budget}
          onClose={() => setBudgetOpen(false)}
          onSaved={onChanged}
          onReauth={onReauth}
        />
        <Dialog open={confirmClear} onOpenChange={(open) => !clear.isPending && setConfirmClear(open)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear the stored data of {adapter.displayName}?</DialogTitle>
              <DialogDescription>
                This deletes every job and search {adapter.displayName} stored, so its next call starts fresh. It cannot be undone. The
                usage budget and the call history are kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmClear(false)} disabled={clear.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => clear.mutate()} disabled={clear.isPending}>
                Clear data
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== undefined && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {adapter.rateHour !== null && adapter.rateDay !== null && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Usage label="hour" used={adapter.rateHour.used} limit={adapter.rateHour.limit} />
            <Usage label="day" used={adapter.rateDay.used} limit={adapter.rateDay.limit} />
          </div>
        )}
        {adapter.breaker?.until != null && (
          <p className="text-xs text-muted-foreground">Closed again at {new Date(adapter.breaker.until).toLocaleString()}.</p>
        )}
        {adapter.boards.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Company boards used in the last day ({adapter.boards.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {adapter.boards.map((board) => (
                <li key={board.board}>
                  <div className="mb-1 text-xs font-medium">{board.board}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Usage label="hour" used={board.rateHour.used} limit={board.rateHour.limit} />
                    <Usage label="day" used={board.rateDay.used} limit={board.rateDay.limit} />
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Tools ({adapter.tools.length}) and hosts</summary>
          <ul className="mt-2 space-y-2 text-sm">
            {adapter.tools.map((tool) => (
              <li key={tool.name}>
                <div className="font-medium">
                  {tool.name}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    · reserves up to {tool.costMax} unit{tool.costMax === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground break-words">{tool.params.join(', ')}</div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground break-words">Reaches: {adapter.hosts.join(', ')}</p>
        </details>
      </CardContent>
    </Card>
  );
}

export function Tools() {
  const client = useQueryClient();
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, refetchInterval: 10_000 });
  const [notice, setNotice] = useState<string>();
  const [reauth, setReauth] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartError, setRestartError] = useState<{ message: string; busy: boolean }>();
  const restart = useMutation({
    mutationFn: (force: boolean) => api.restart(force),
    onSuccess: () => {
      setNotice('The router is restarting. This page reconnects by itself in a few seconds.');
      setConfirmRestart(false);
      setRestartError(undefined);
      setTimeout(() => void client.invalidateQueries(), 6000);
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === 'reauth_required') return setReauth(true);
      setRestartError({
        message: failure instanceof Error ? failure.message : 'The restart failed.',
        busy: failure instanceof ApiError && failure.code === 'busy',
      });
    },
  });

  const adapters = tools.data?.adapters ?? [];
  const on = adapters.filter((adapter) => adapter.role === 'adapter' && adapter.enabled);
  const off = adapters.filter((adapter) => adapter.role === 'adapter' && !adapter.enabled);
  const utilities = adapters.filter((adapter) => adapter.role === 'utility');
  const runtime = tools.data?.runtime;
  // ADAPTERS and UTILITIES each pin one list: say which, once, at the top, instead of on every card
  const pinned = (['adapter', 'utility'] as const)
    .filter((role) => adapters.some((module) => module.role === role && module.pinned))
    .map((role) => ({ plural: role === 'adapter' ? 'adapters' : 'utilities', variable: role === 'adapter' ? 'ADAPTERS' : 'UTILITIES' }));

  return (
    <div className="min-h-0 w-full flex-1 space-y-5 overflow-auto p-5">
      {reauth && (
        <div role="alert" className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <span>Changes need a recent sign-in. Sign in again to continue.</span>
          <Button size="sm" onClick={() => navigation.toReauth()}>
            Sign in again
          </Button>
        </div>
      )}
      {pinned.map(({ plural, variable }) => (
        <div
          key={variable}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <code>{variable}</code> is set in the environment, so the {plural} cannot be enabled or disabled here. Unset{' '}
            <code>{variable}</code> to change them.
          </span>
        </div>
      ))}
      {notice !== undefined && (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Browser</CardTitle>
          <div className="flex items-center gap-2">
            {!confirmRestart ? (
              <Button variant="outline" size="sm" onClick={() => setConfirmRestart(true)}>
                <RotateCcw className="size-3.5" /> Restart router
              </Button>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">Calls that are running are cut. Restart?</span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={restart.isPending}
                  onClick={() => restart.mutate(restartError?.busy === true)}
                >
                  {restartError?.busy ? 'Restart anyway' : 'Yes, restart'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmRestart(false);
                    setRestartError(undefined);
                  }}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="text-sm">
          {runtime === undefined ? (
            'Loading…'
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span>
                State: <strong>{runtime.enabled ? runtime.state : 'not needed (no browser adapter enabled)'}</strong>
              </span>
              {runtime.platform !== null && <span>On: {runtime.platform}</span>}
              {runtime.peakMb !== null && <span>Peak: {runtime.peakMb} MB</span>}
              <span>Waiting: {runtime.waiting}</span>
            </div>
          )}
          {restartError !== undefined && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {restartError.message}
            </p>
          )}
        </CardContent>
      </Card>

      <section aria-label="Enabled adapters" className="space-y-3">
        <h2 className="text-sm font-semibold">Adapters enabled ({on.length})</h2>
        {on.length === 0 && <p className="text-sm text-muted-foreground">No adapter is enabled. Turn one on below.</p>}
        <div className="grid gap-4 xl:grid-cols-2">
          {on.map((adapter) => (
            <AdapterCard key={adapter.id} adapter={adapter} onChanged={setNotice} onReauth={() => setReauth(true)} />
          ))}
        </div>
      </section>
      <section aria-label="Disabled adapters" className="space-y-3">
        <h2 className="text-sm font-semibold">Adapters disabled ({off.length})</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {off.map((adapter) => (
            <AdapterCard key={adapter.id} adapter={adapter} onChanged={setNotice} onReauth={() => setReauth(true)} />
          ))}
        </div>
      </section>
      <section aria-label="Utilities" className="space-y-3">
        <h2 className="text-sm font-semibold">Utilities ({utilities.length})</h2>
        <p className="text-xs text-muted-foreground">Helper tools that fetch no jobs. Each has its own budget.</p>
        <div className="grid gap-4 xl:grid-cols-2">
          {utilities.map((adapter) => (
            <AdapterCard key={adapter.id} adapter={adapter} onChanged={setNotice} onReauth={() => setReauth(true)} />
          ))}
        </div>
      </section>
      {tools.isError && <p className="text-sm text-destructive">Could not load the tools.</p>}
    </div>
  );
}
