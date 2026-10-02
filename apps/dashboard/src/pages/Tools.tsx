import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ToolState } from '@jobwatch/dashboard-api';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
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
  const warnsAboutBudget = adapter.id === 'linkedin';
  return (
    <Card aria-label={adapter.displayName} className={cn(!adapter.enabled && 'opacity-80')}>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-sm normal-case tracking-normal text-foreground">{adapter.displayName}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{adapter.kind === 'browser' ? 'browser' : 'HTTP'}</Badge>
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
        </div>
        <Switch
          aria-label={`${adapter.enabled ? 'Disable' : 'Enable'} ${adapter.displayName}`}
          checked={adapter.enabled}
          disabled={adapter.pinned || toggle.isPending}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {adapter.pinned && (
          <p className="text-xs text-muted-foreground">The list of adapters is set by JW_ADAPTERS: unset it to change it here.</p>
        )}
        {warnsAboutBudget && !adapter.enabled && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> LinkedIn has a strict usage budget that needs your approval before it is
            switched on (docs/plans/09-security.md).
          </p>
        )}
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
  const on = adapters.filter((adapter) => adapter.enabled);
  const off = adapters.filter((adapter) => !adapter.enabled);
  const runtime = tools.data?.runtime;

  return (
    <div className="w-full space-y-5 overflow-auto p-5">
      {reauth && (
        <div role="alert" className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <span>Changes need a recent sign-in. Sign in again to continue.</span>
          <Button size="sm" onClick={() => navigation.toReauth()}>
            Sign in again
          </Button>
        </div>
      )}
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
        <h2 className="text-sm font-semibold">Enabled ({on.length})</h2>
        {on.length === 0 && <p className="text-sm text-muted-foreground">No adapter is enabled. Turn one on below.</p>}
        <div className="grid gap-4 xl:grid-cols-2">
          {on.map((adapter) => (
            <AdapterCard key={adapter.id} adapter={adapter} onChanged={setNotice} onReauth={() => setReauth(true)} />
          ))}
        </div>
      </section>
      <section aria-label="Disabled adapters" className="space-y-3">
        <h2 className="text-sm font-semibold">Disabled ({off.length})</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {off.map((adapter) => (
            <AdapterCard key={adapter.id} adapter={adapter} onChanged={setNotice} onReauth={() => setReauth(true)} />
          ))}
        </div>
      </section>
      {tools.isError && <p className="text-sm text-destructive">Could not load the tools.</p>}
    </div>
  );
}
