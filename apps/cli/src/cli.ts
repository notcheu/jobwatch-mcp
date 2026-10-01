import { parseArgs } from 'node:util';
import {
  ConfigError,
  loadStorageSettings,
  readEnabledFile,
  resolveEnabledAdapters,
  setAdaptersEnabled,
  adaptersFilePath,
} from '@jobwatch/core';
import { describeInstalled, type InstalledEntry } from '@jobwatch/adapters';
import type { InstalledAdapters } from '@jobwatch/core';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Deps {
  io: Io;
  env: Readonly<Record<string, string | undefined>>;
  installed: InstalledAdapters;
  version: string;
}

const USAGE = `jobwatch: manage which adapters the router plugs in

Usage:
  jobwatch adapters list [--json]      every installed adapter and whether it is enabled
  jobwatch adapters enable <id...>     enable adapters (written to adapters.json)
  jobwatch adapters disable <id...>    disable adapters
  jobwatch --help | --version

Settings (environment): JW_DATA_DIR (default /data) holds adapters.json;
JW_ADAPTERS (comma list) overrides the file and makes it read-only.

Changes take effect after the router restarts: docker compose restart router
`;

/** Exit codes: 0 ok, 1 usage or configuration error, 2 at least one installed adapter is broken. */
export const EXIT = { ok: 0, usage: 1, broken: 2 } as const;

const RESTART_HINT = 'Restart the router to apply: docker compose -f deploy/compose.yml --env-file deploy/.env restart router';

function pad(rows: string[][]): string {
  const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  '))
    .join('\n');
}

async function list(deps: Deps, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  if (positionals.length > 0) {
    deps.io.err(`adapters list takes no arguments, got: ${positionals.join(' ')}\n`);
    return EXIT.usage;
  }
  const settings = loadStorageSettings(deps.env);
  const enabled = await resolveEnabledAdapters(settings);
  const entries = await describeInstalled(deps.installed);
  const strays = enabled.ids.filter((id) => !(id in deps.installed));
  const broken = entries.filter((entry) => entry.error !== undefined);

  if (values.json) {
    const adapters = entries.map((entry: InstalledEntry) =>
      entry.summary
        ? { ...entry.summary, enabled: enabled.ids.includes(entry.id) }
        : { id: entry.id, enabled: enabled.ids.includes(entry.id), error: entry.error },
    );
    deps.io.out(
      `${JSON.stringify({ source: enabled.source, file: adaptersFilePath(settings.dataDir), adapters, enabledButNotInstalled: strays }, null, 2)}\n`,
    );
    return broken.length > 0 ? EXIT.broken : EXIT.ok;
  }

  if (entries.length === 0) {
    deps.io.out('No adapters are installed.\n');
  } else {
    const rows = [['ID', 'STATUS', 'KIND', 'TOOLS', 'HOSTS']];
    for (const entry of entries) {
      const status = enabled.ids.includes(entry.id) ? 'enabled' : 'disabled';
      if (entry.summary) {
        rows.push([
          entry.id,
          status,
          entry.summary.kind,
          entry.summary.tools.map((tool) => tool.name).join(', '),
          entry.summary.allowedHosts.join(', '),
        ]);
      } else {
        rows.push([entry.id, status, '-', '-', `BROKEN: ${entry.error ?? 'unknown error'}`]);
      }
    }
    deps.io.out(`${pad(rows)}\n`);
  }
  const where =
    enabled.source === 'env'
      ? 'JW_ADAPTERS (environment, overrides the file)'
      : enabled.source === 'file'
        ? adaptersFilePath(settings.dataDir)
        : `${adaptersFilePath(settings.dataDir)} (not created: nothing enabled yet)`;
  deps.io.out(`\nEnabled list: ${where}\n`);
  for (const id of strays)
    deps.io.out(`Warning: "${id}" is enabled but not installed; the router will refuse to start. Run: jobwatch adapters disable ${id}\n`);
  return broken.length > 0 ? EXIT.broken : EXIT.ok;
}

async function toggle(deps: Deps, args: string[], enable: boolean): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const verb = enable ? 'enable' : 'disable';
  if (positionals.length === 0) {
    deps.io.err(`adapters ${verb} needs at least one adapter id. Installed: ${Object.keys(deps.installed).sort().join(', ') || 'none'}\n`);
    return EXIT.usage;
  }
  const settings = loadStorageSettings(deps.env);
  const before = (await readEnabledFile(settings.dataDir)) ?? [];
  const { ids, changed } = await setAdaptersEnabled(settings, Object.keys(deps.installed).sort(), positionals, enable);
  const unchanged = [...new Set(positionals)].filter((id) => !changed.includes(id));
  if (changed.length > 0) deps.io.out(`${enable ? 'Enabled' : 'Disabled'}: ${changed.join(', ')}\n`);
  if (unchanged.length > 0) deps.io.out(`Already ${enable ? 'enabled' : 'disabled'}: ${unchanged.join(', ')}\n`);
  deps.io.out(`Enabled now: ${ids.length === 0 ? 'none' : ids.join(', ')}\n`);
  if (changed.length > 0 && before.join() !== ids.join()) deps.io.out(`${RESTART_HINT}\n`);
  return EXIT.ok;
}

/** Run the CLI. Pure with respect to the process: all input and output goes through `deps`, so tests need no spawning. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const [command, subcommand, ...rest] = argv;
  try {
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      deps.io.out(USAGE);
      return command === undefined ? EXIT.usage : EXIT.ok;
    }
    if (command === '--version' || command === '-v') {
      deps.io.out(`${deps.version}\n`);
      return EXIT.ok;
    }
    if (command === 'adapters') {
      if (subcommand === 'list') return await list(deps, rest);
      if (subcommand === 'enable') return await toggle(deps, rest, true);
      if (subcommand === 'disable') return await toggle(deps, rest, false);
      deps.io.err(`Unknown adapters command: ${subcommand ?? '(none)'}\n\n${USAGE}`);
      return EXIT.usage;
    }
    deps.io.err(`Unknown command: ${command}\n\n${USAGE}`);
    return EXIT.usage;
  } catch (error) {
    if (error instanceof ConfigError) {
      // A mistake by the operator (unknown id, unreadable file), not a server configuration problem: plain error lines.
      deps.io.err(`${error.problems.map((problem) => `error: ${problem}`).join('\n')}\n`);
      return EXIT.usage;
    }
    if (error instanceof TypeError && (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      deps.io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
}
