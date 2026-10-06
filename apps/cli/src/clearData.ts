import { parseArgs } from 'node:util';
import { controlSocketPath, loadStorageSettings, sendControl, type ControlResponse } from '@jobwatch/core';
import type { Deps } from './cli';

const USAGE = `Usage:
  jobwatch adapters clear-data <id> --yes   forget the jobs and searches an adapter stored, so its next call starts fresh
`;

const NO_ROUTER = 'No router is running (nothing answers on its control socket). Start it first: docker compose up -d';

/**
 * `jobwatch adapters clear-data <id> --yes`: asks the running router (which owns the database) to delete one adapter's stored jobs and
 * searches. Usage, budgets, the breaker and the call history are kept: this never resets a request budget. `--yes` is required, as
 * the command often runs without a terminal to ask on.
 */
export async function clearData(deps: Deps, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { yes: { type: 'boolean', default: false } } });
  } catch {
    deps.io.err(USAGE);
    return 1;
  }
  const [id, ...extra] = parsed.positionals;
  if (id === undefined || extra.length > 0) {
    deps.io.err(USAGE);
    return 1;
  }
  if (!(id in deps.adapters)) {
    const utility = id in deps.utilities;
    deps.io.err(
      utility
        ? `${id} is a utility: it stores no jobs, so there is nothing to clear.\n`
        : `Unknown adapter: ${id}. Installed adapters: ${Object.keys(deps.adapters).sort().join(', ') || 'none'}\n`,
    );
    return 1;
  }
  if (!parsed.values.yes) {
    deps.io.err(`This deletes every job and search ${id} stored, and cannot be undone. Run it again with --yes to confirm.\n`);
    return 1;
  }
  let answer: ControlResponse | undefined;
  try {
    answer = await sendControl(controlSocketPath(loadStorageSettings(deps.env).dataDir), { command: 'data.clear', adapter: id });
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
    return 1;
  }
  deps.io.out(`Cleared ${id}: ${String(answer['jobs'])} job(s) and ${String(answer['searches'])} search(es) removed.\n`);
  return 0;
}
