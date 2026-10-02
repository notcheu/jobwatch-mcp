import { parseArgs } from 'node:util';
import { controlSocketPath, loadStorageSettings, sendControl, type ControlResponse } from '@jobwatch/core';
import type { Deps } from './cli';

const USAGE = `Usage:
  jobwatch dashboard start [--ttl <minutes>]   open the dashboard (it closes after 30 minutes without use, or --ttl)
  jobwatch dashboard stop                      close it and end every session
  jobwatch dashboard status                    is it open, where, and when it closes
`;

const NO_ROUTER =
  'No router is running (nothing answers on its control socket). Start it first: docker compose -f deploy/compose.yml --env-file deploy/.env up -d';

function describe(deps: Deps, answer: Extract<ControlResponse, { ok: true }>): void {
  const stops = typeof answer['stopsAt'] === 'string' ? new Date(answer['stopsAt']) : undefined;
  if (answer['running'] === true) {
    deps.io.out(`Dashboard is open: ${String(answer['url'])}\n`);
    deps.io.out(
      `Sign-in: ${answer['signIn'] === 'google' ? 'Google' : 'none (local development)'}. Sessions open: ${String(answer['sessions'])}.\n`,
    );
    if (stops !== undefined) deps.io.out(`It closes at ${stops.toISOString()} unless it is used; each request pushes that back.\n`);
  } else {
    deps.io.out('Dashboard is closed.\n');
  }
}

/** `jobwatch dashboard start|stop|status`: asks the running router, through its control socket, to open or close the listener. */
export async function dashboard(deps: Deps, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { ttl: { type: 'string' } } });
  } catch {
    deps.io.err(USAGE);
    return 1;
  }
  const { values, positionals } = parsed;
  const [action, ...extra] = positionals;
  if ((action !== 'start' && action !== 'stop' && action !== 'status') || extra.length > 0) {
    deps.io.err(USAGE);
    return 1;
  }
  let ttlMinutes: number | undefined;
  if (values.ttl !== undefined) {
    ttlMinutes = Number(values.ttl);
    if (action !== 'start' || !Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      deps.io.err('--ttl is a number of minutes between 1 and 1440, and only for start.\n');
      return 1;
    }
  }
  const path = controlSocketPath(loadStorageSettings(deps.env).dataDir);
  let answer: ControlResponse | undefined;
  try {
    answer = await sendControl(path, { command: `dashboard.${action}`, ...(ttlMinutes === undefined ? {} : { ttlMinutes }) });
  } catch (error) {
    deps.io.err(`The router did not answer: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 2;
  }
  if (answer === undefined) {
    deps.io.err(`${NO_ROUTER}\n`);
    return 2;
  }
  if (!answer.ok) {
    deps.io.err(`${answer.error}\n`);
    return 2;
  }
  describe(deps, answer);
  return 0;
}
