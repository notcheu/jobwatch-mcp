import { parseArgs } from 'node:util';
import { controlSocketPath, loadStorageSettings, sendControl, type ControlResponse } from '@jobwatch/core';
import type { Deps } from './cli';

const USAGE = `Usage:
  jobwatch linkedin-geo <text>                     look a place up on LinkedIn: its candidates and their geoIds
  jobwatch linkedin-geo <text> --save <name> [--pick <n>]
                                          remember <name> for the n-th candidate (default 1); searches can then use it as geo
  jobwatch linkedin-geo --list                     the remembered names
  jobwatch linkedin-geo --forget <name>            forget one

The lookup uses the linkedin-geo adapter (jobwatch adapters enable linkedin-geo). A name you save is also kept by the router, so
no restart is needed.
`;

interface Place {
  id: string;
  label: string;
}
interface Remembered {
  alias: string;
  id: string;
  label: string;
  saved_by: string;
}

const NO_ROUTER =
  'No router is running (nothing answers on its control socket). Start it first: docker compose -f deploy/compose.yml --env-file deploy/.env up -d';

/** `jobwatch linkedin-geo` (also `linked-geo`): finds the LinkedIn geoId of a place and manages remembered names, through the running router. */
export async function linkedinGeo(deps: Deps, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        save: { type: 'string' },
        pick: { type: 'string' },
        list: { type: 'boolean', default: false },
        forget: { type: 'string' },
      },
    });
  } catch {
    deps.io.err(USAGE);
    return 1;
  }
  const { values, positionals } = parsed;
  const text = positionals.join(' ').trim();
  const modes = [text !== '', values.list, values.forget !== undefined].filter(Boolean).length;
  if (modes !== 1 || (values.save !== undefined && text === '') || (values.pick !== undefined && values.save === undefined)) {
    deps.io.err(USAGE);
    return 1;
  }
  const path = controlSocketPath(loadStorageSettings(deps.env).dataDir);
  const ask = async (command: string, request: Record<string, unknown>): Promise<Extract<ControlResponse, { ok: true }> | undefined> => {
    let answer: ControlResponse | undefined;
    try {
      answer = await sendControl(path, { command, ...request });
    } catch (error) {
      deps.io.err(`The router did not answer: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      return undefined;
    }
    if (answer === undefined) {
      deps.io.err(`${NO_ROUTER}\n`);
      return undefined;
    }
    if (!answer.ok) {
      deps.io.err(`${answer.error}\n`);
      return undefined;
    }
    return answer;
  };
  const showSaved = (rows: Remembered[]): void => {
    if (rows.length === 0) deps.io.out('Nothing is remembered yet.\n');
    for (const row of rows)
      deps.io.out(
        `${row.alias.padEnd(24)} ${row.id.padEnd(12)} ${row.label}${row.saved_by === 'auto' ? '   (looked up by a search)' : ''}\n`,
      );
  };

  if (values.list) {
    const answer = await ask('linkedin-geo.list', {});
    if (answer === undefined) return 2;
    showSaved(answer['remembered'] as Remembered[]);
    return 0;
  }
  if (values.forget !== undefined) {
    const answer = await ask('linkedin-geo.forget', { alias: values.forget });
    if (answer === undefined) return 2;
    deps.io.out(`Forgot "${values.forget}".\n`);
    return 0;
  }

  const found = await ask('linkedin-geo.lookup', { query: text });
  if (found === undefined) return 2;
  const places = found['places'] as Place[];
  if (places.length === 0) {
    deps.io.out('LinkedIn suggested nothing for this text. Try another spelling.\n');
    return 2;
  }
  places.slice(0, 10).forEach((place, index) => deps.io.out(`${String(index + 1).padStart(2)}. ${place.id.padEnd(12)} ${place.label}\n`));

  if (values.save === undefined) {
    deps.io.out(
      '\nTo remember one:  jobwatch linkedin-geo "' +
        text +
        '" --save <name> --pick <number>\nA search can then pass the geoId, or the name you saved, as geo.\n',
    );
    return 0;
  }
  const pick = values.pick === undefined ? 1 : Number(values.pick);
  const chosen = Number.isInteger(pick) ? places[pick - 1] : undefined;
  if (chosen === undefined) {
    deps.io.err(`--pick is a number between 1 and ${Math.min(places.length, 10)}.\n`);
    return 1;
  }
  const saved = await ask('linkedin-geo.save', { alias: values.save, id: chosen.id, label: chosen.label });
  if (saved === undefined) return 2;
  deps.io.out(`\nRemembered "${values.save}" = ${chosen.id} (${chosen.label}).\n`);
  return 0;
}
