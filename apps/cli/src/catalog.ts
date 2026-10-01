import { parseArgs } from 'node:util';
import { loadStorageSettings, resolveEnabledAdapters } from '@jobwatch/core';
import { buildCatalog, stableStringify } from '@jobwatch/sdk';
import type { Deps } from './cli';

/** The static tool catalog (what `tools/list` returns), straight from the installed adapters. Starts nothing. */
export async function catalog(deps: Deps, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean', default: false } } });
  const enabled = values.all ? undefined : (await resolveEnabledAdapters(loadStorageSettings(deps.env))).ids;
  const entries = [];
  for (const [id, load] of Object.entries(deps.installed).sort(([a], [b]) => a.localeCompare(b))) {
    if (enabled !== undefined && !enabled.includes(id)) continue;
    entries.push(...buildCatalog(await load()));
  }
  deps.io.out(
    `${entries.map((entry) => JSON.stringify(JSON.parse(stableStringify(entry)) as unknown)).join('\n')}${entries.length > 0 ? '\n' : ''}`,
  );
  if (entries.length === 0) deps.io.err('No tools: nothing is enabled (use --all to include disabled adapters).\n');
  return 0;
}
