import { parseArgs } from 'node:util';
import { controlSocketPath, loadStorageSettings, sendControl, type ControlResponse } from '@jobwatch/core';
import type { Deps } from './cli';

const USAGE = `Usage:
  jobwatch ats-find <company...> [--ats <id,id>] [--handles <n>] [--refresh]

Each company is a name ("Société Générale"), a website or careers URL, or the address of a board on a known ATS. Up to 8.
  --ats <list>   only these ATS: greenhouse, lever, ashby, teamtailor (default: all)
  --handles <n>  spellings of the name to try on each ATS, 1 to 3 (default 2)
  --refresh      a company already mapped to a board is answered from the mapping, with no request; check the ATS again for it

It runs the ats_find tool through the running router (jobwatch utilities enable ats-discovery), so the lookup uses its budget and is
logged on the dashboard's ATS discovery page, where a board can be assigned to the company.
`;

interface Match {
  ats: string;
  handle: string;
  reading_tool: string;
  board_url: string;
  jobs: number | null;
  sample_titles: string[];
}
interface Lookup {
  input: string;
  source: 'mapping' | 'probe';
  tried: string[];
  matches: Match[];
}

const ATS = ['greenhouse', 'lever', 'ashby', 'teamtailor'];
const NO_ROUTER = 'No router is running (nothing answers on its control socket). Start it first: docker compose up -d';

/** `jobwatch ats-find`: which ATS hosts each company's careers board, through the running router. */
export async function atsFind(deps: Deps, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { ats: { type: 'string' }, handles: { type: 'string' }, refresh: { type: 'boolean', default: false } },
    });
  } catch {
    deps.io.err(USAGE);
    return 1;
  }
  const companies = parsed.positionals.map((company) => company.trim()).filter((company) => company !== '');
  const ats = parsed.values.ats?.split(',').map((id) => id.trim());
  const handles = parsed.values.handles === undefined ? undefined : Number(parsed.values.handles);
  if (
    companies.length < 1 ||
    companies.length > 8 ||
    (ats !== undefined && (ats.length === 0 || ats.some((id) => !ATS.includes(id)))) ||
    (handles !== undefined && (!Number.isInteger(handles) || handles < 1 || handles > 3))
  ) {
    deps.io.err(USAGE);
    return 1;
  }

  let answer: ControlResponse | undefined;
  try {
    answer = await sendControl(controlSocketPath(loadStorageSettings(deps.env).dataDir), {
      command: 'ats.find',
      companies,
      ...(ats === undefined ? {} : { ats }),
      ...(handles === undefined ? {} : { handles }),
      ...(parsed.values.refresh ? { refresh: true } : {}),
    });
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
  for (const lookup of answer['companies'] as Lookup[]) {
    deps.io.out(
      `${lookup.input}   ${lookup.source === 'mapping' ? '(from the mapping, nothing requested)' : `(tried: ${lookup.tried.join(', ') || 'nothing'})`}\n`,
    );
    if (lookup.matches.length === 0) deps.io.out('  no board found on the ATS checked\n');
    for (const match of lookup.matches)
      deps.io.out(
        `  ${match.ats.padEnd(11)} ${match.handle.padEnd(24)} ${match.jobs === null ? '   -' : String(match.jobs).padStart(4)} jobs  ${match.board_url}\n` +
          (match.sample_titles.length === 0 ? '' : `              e.g. ${match.sample_titles.slice(0, 2).join(' | ')}\n`),
      );
  }
  for (const warning of (answer['warnings'] as string[] | undefined) ?? []) deps.io.out(`\nnote: ${warning}\n`);
  deps.io.out('\nAssign a board to a company on the dashboard (jobwatch dashboard start), ATS discovery page.\n');
  return 0;
}
