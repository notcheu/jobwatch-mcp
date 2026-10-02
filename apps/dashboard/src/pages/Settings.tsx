import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useTheme } from '@/lib/theme';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <div>
        <div className="text-sm">{label}</div>
        {hint !== undefined && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0 text-sm tabular-nums">{children}</div>
    </div>
  );
}

/** The theme is the only thing to set here; the rest are the limits in force, read from the router and shown as they are. */
export function Settings() {
  const [dark, toggle] = useTheme();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const s = settings.data;
  return (
    <div className="w-full max-w-3xl space-y-4 overflow-auto p-5">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Theme" hint="Kept in this browser only">
            <Button variant="outline" size="sm" onClick={toggle}>
              {dark ? 'Dark: switch to light' : 'Light: switch to dark'}
            </Button>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limits in force (read only)</CardTitle>
        </CardHeader>
        <CardContent>
          {settings.isError && <p className="text-sm text-destructive">Could not load the settings.</p>}
          {s === undefined ? (
            !settings.isError && <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <Row
                label="Sign-in"
                hint={
                  s.signIn === 'google'
                    ? 'With Google; the Google app decides who may sign in'
                    : 'The router runs for local development: no sign-in'
                }
              >
                <Badge variant={s.signIn === 'google' ? 'success' : 'warning'}>{s.signIn === 'google' ? 'Google' : 'none'}</Badge>
              </Row>
              <Row label="The dashboard closes after" hint="Without a request. Start it again with jobwatch dashboard start">
                {s.idleStopMinutes} min
              </Row>
              <Row label="A session lasts at most">{s.sessionMaxHours} h</Row>
              <Row label="A change needs a sign-in within" hint="Enabling or disabling an adapter, restarting the router">
                {s.writeWindowMinutes} min
              </Row>
              <Row label="Calls kept in memory" hint="With their parameters; cleared when the router restarts">
                {s.callBuffer}
              </Row>
              <Row label="Characters per token" hint="How the token figures are estimated">
                {s.charsPerToken}
              </Row>
              <Row label="Stored jobs are kept" hint="After they were last seen">
                {s.jobRetentionDays} days
              </Row>
              <Row label="Browser tabs at most">{s.maxTabs}</Row>
              <Row label="The browser stops after" hint="Without a call">
                {s.browser.idleStopSeconds} s
              </Row>
              <Row label="Browser memory" hint="Warning mark and hard cap of the container">
                {s.browser.memoryHighMb} / {s.browser.memoryMaxMb} MB
              </Row>
              <Row
                label="List of adapters"
                hint={s.adaptersPinned ? 'Set by JW_ADAPTERS: it cannot be changed from here' : 'Changed from Tools & status'}
              >
                <Badge variant={s.adaptersPinned ? 'warning' : 'outline'}>{s.adaptersPinned ? 'pinned' : 'editable'}</Badge>
              </Row>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
