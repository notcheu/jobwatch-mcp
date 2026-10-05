import { parseArgs } from 'node:util';
import {
  ConfigError,
  controlSocketPath,
  sendControl,
  loadStorageSettings,
  readEnabledFile,
  resolveEnabledModules,
  setModulesEnabled,
  adaptersFilePath,
  pinVariable,
  type ModuleGroup,
} from '@jobwatch/core';
import { describeInstalledAdapters, describeInstalledUtilities, type ModuleEntry } from '@jobwatch/mcp-modules';
import { buildCatalog, type CatalogEntry, type ModuleRole } from '@jobwatch/sdk';
import type { DockerRunner, InstalledAdapters, InstalledModules, InstalledUtilities } from '@jobwatch/core';
import { dashboard } from './dashboard';
import { doctor } from './doctor';
import { linkedinGeo } from './linkedinGeo';
import { login } from './login';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Deps {
  io: Io;
  env: Readonly<Record<string, string | undefined>>;
  /** The installed adapters (modules that fetch jobs) and utilities (helper modules), listed apart. */
  adapters: InstalledAdapters;
  utilities: InstalledUtilities;
  version: string;
  /** Runs `docker <args>`; commands that need the daemon (login, doctor) fail cleanly without it. */
  docker?: DockerRunner;
  /** Test seam for the one-time VNC password of `login`. */
  randomPassword?: () => string;
}

const USAGE = `jobwatch: manage which adapters and utilities the router plugs in

Usage:
  jobwatch adapters list [--tools] [--json] [<id...>]
                                       every installed adapter and whether it is enabled; --tools adds each tool with its
                                       parameters (what Claude will see), --json prints it as JSON; ids narrow the list
  jobwatch adapters enable <id...>     enable adapters (written to adapters.json)
  jobwatch adapters disable <id...>    disable adapters
  jobwatch utilities list|enable|disable ...
                                       the same for utilities: helper tools that fetch no jobs (LinkedIn geoIds, ATS discovery)
  jobwatch login start <platform>      start a visible browser to sign in by hand (noVNC on loopback)
  jobwatch login stop <platform>       stop it again
  jobwatch linkedin-geo <text> [--save <name> [--pick <n>]] | --list | --forget <name>
                                       find the LinkedIn geoId of a place and remember names for places
  jobwatch dashboard start [--ttl <minutes>] | stop | status
                                       open or close the operator dashboard on the running router (closed by default)
  jobwatch doctor                      check configuration, data directory, Docker, image, network, profiles
  jobwatch --help | --version

Settings (environment): DATA_DIR (default /data) holds adapters.json;
ADAPTERS and UTILITIES (comma lists) override their part of the file and make it read-only.

Changes take effect after the router restarts: docker compose restart router
`;

/** Exit codes: 0 ok, 1 usage or configuration error, 2 at least one installed adapter is broken. */
export const EXIT = { ok: 0, usage: 1, broken: 2 } as const;

const RESTART_HINT = 'Restart the router to apply: docker compose restart router';

function pad(rows: string[][]): string {
  const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  '))
    .join('\n');
}

interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
}

/** `string`, `integer`, `a|b|c`, `string[]`: the shape of one parameter in a few words. */
function typeOf(node: SchemaNode): string {
  if (node.enum) return node.enum.map(String).join('|');
  const type = Array.isArray(node.type) ? node.type.filter((t) => t !== 'null').join('|') : (node.type ?? 'any');
  return type === 'array' ? `${node.items ? typeOf(node.items) : 'any'}[]` : type;
}

/** One tool for the human listing: its title, what a call can cost, then one line per parameter. */
function describeTool(tool: CatalogEntry): string {
  const schema = tool.inputSchema as SchemaNode;
  const required = new Set(schema.required ?? []);
  const lines = [`  ${tool.name}  ${tool.title}  (reserves up to ${tool.limits.rate.cost} unit(s))`];
  const params = Object.entries(schema.properties ?? {});
  if (params.length === 0) lines.push('      no parameters');
  for (const [name, node] of params) {
    const fallback = node.default === undefined ? '' : ` = ${JSON.stringify(node.default)}`;
    lines.push(`      ${name}${required.has(name) ? '*' : ''}: ${typeOf(node)}${fallback}`);
  }
  return `${lines.join('\n')}\n`;
}

const GROUP: Record<ModuleRole, ModuleGroup> = { adapter: 'adapters', utility: 'utilities' };
const COMMAND: Record<ModuleRole, string> = { adapter: 'adapters', utility: 'utilities' };
const OTHER: Record<ModuleRole, ModuleRole> = { adapter: 'utility', utility: 'adapter' };

/** What the commands of one role work on: its installed map, and how to describe it. */
interface Kit {
  map: InstalledModules;
  describe: () => Promise<ModuleEntry[]>;
}
const kitOf = (deps: Deps, role: ModuleRole): Kit =>
  role === 'adapter'
    ? { map: deps.adapters, describe: () => describeInstalledAdapters(deps.adapters) }
    : { map: deps.utilities, describe: () => describeInstalledUtilities(deps.utilities) };

/** The ids installed for a role, and an error line for ids that belong to the other role or to none. */
function checkIds(deps: Deps, role: ModuleRole, asked: readonly string[]): { ids: string[]; problem?: string } {
  const ids = Object.keys(kitOf(deps, role).map).sort();
  const other = kitOf(deps, OTHER[role]).map;
  const elsewhere = asked.filter((id) => !ids.includes(id) && id in other);
  const unknown = asked.filter((id) => !ids.includes(id) && !(id in other));
  if (unknown.length > 0)
    return { ids, problem: `Unknown ${role}: ${unknown.join(', ')}. Installed ${role}s: ${ids.join(', ') || 'none'}\n` };
  if (elsewhere.length > 0) {
    const many = elsewhere.length > 1;
    const be = many ? 'are' : OTHER[role] === 'adapter' ? 'is an' : 'is a';
    return { ids, problem: `${elsewhere.join(', ')} ${be} ${OTHER[role]}${many ? 's' : ''}: use \`jobwatch ${COMMAND[OTHER[role]]}\`\n` };
  }
  return { ids };
}

async function list(deps: Deps, args: string[], role: ModuleRole): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, tools: { type: 'boolean', default: false } },
  });
  const checked = checkIds(deps, role, positionals);
  if (checked.problem !== undefined) {
    deps.io.err(checked.problem);
    return EXIT.usage;
  }
  const kit = kitOf(deps, role);
  const settings = loadStorageSettings(deps.env);
  const enabled = await resolveEnabledModules(settings);
  const all = await kit.describe();
  const entries = positionals.length === 0 ? all : all.filter((entry) => positionals.includes(entry.id));
  const strays = enabled[GROUP[role]].filter((id) => !(id in kit.map));
  const broken = entries.filter((entry) => entry.error !== undefined);

  // the tools as the router lists them to Claude (static: nothing is started), only when asked
  const catalogs = new Map<string, CatalogEntry[]>();
  if (values.tools)
    for (const entry of entries) {
      const load = kit.map[entry.id];
      if (entry.summary && load) catalogs.set(entry.id, buildCatalog(await load()));
    }

  if (values.json) {
    const modules = entries.map((entry: ModuleEntry) =>
      entry.summary
        ? {
            ...entry.summary,
            ...(catalogs.has(entry.id) ? { tools: catalogs.get(entry.id) } : {}),
            enabled: enabled.ids.includes(entry.id),
          }
        : { id: entry.id, enabled: enabled.ids.includes(entry.id), error: entry.error },
    );
    deps.io.out(
      `${JSON.stringify({ source: enabled.source, file: adaptersFilePath(settings.dataDir), [GROUP[role]]: modules, enabledButNotInstalled: strays }, null, 2)}\n`,
    );
    return broken.length > 0 ? EXIT.broken : EXIT.ok;
  }

  if (entries.length === 0) {
    deps.io.out(`No ${GROUP[role]} are installed.\n`);
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
  if (values.tools)
    for (const entry of entries) {
      const tools = catalogs.get(entry.id);
      if (tools === undefined) continue;
      deps.io.out(`\n${entry.id} (${enabled.ids.includes(entry.id) ? 'enabled' : 'disabled'})\n`);
      for (const tool of tools) deps.io.out(describeTool(tool));
    }
  const where =
    enabled.source === 'env'
      ? `${pinVariable(GROUP[role])} (environment, overrides the file)`
      : enabled.source === 'file'
        ? adaptersFilePath(settings.dataDir)
        : `${adaptersFilePath(settings.dataDir)} (not created: nothing enabled yet)`;
  deps.io.out(`\nEnabled list: ${where}\n`);
  for (const id of strays)
    deps.io.out(
      `Warning: "${id}" is enabled but not installed; the router will refuse to start. Run: jobwatch ${COMMAND[role]} disable ${id}\n`,
    );
  return broken.length > 0 ? EXIT.broken : EXIT.ok;
}

/**
 * Tell a running router to re-read the list (hot reload, docs/plans/17-dashboard.md, section 6.4). With no router listening the file
 * is all there is to change, so say that a start or restart applies it.
 */
async function applyToRunningRouter(deps: Deps, dataDir: string): Promise<void> {
  let answer;
  try {
    answer = await sendControl(controlSocketPath(dataDir), { command: 'adapters.reload' });
  } catch {
    answer = undefined;
  }
  if (answer === undefined) {
    deps.io.out(`${RESTART_HINT}\n`);
  } else if (answer.ok) {
    const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none');
    deps.io.out(
      `Applied to the running router (no restart). Tools added: ${list(answer['addedTools'])}; removed: ${list(answer['removedTools'])}.\n`,
    );
    deps.io.out('Reconnect the Claude connector to see the new tool list.\n');
  } else {
    deps.io.out(`The running router did not apply it: ${answer.error}\n${RESTART_HINT}\n`);
  }
}

async function toggle(deps: Deps, args: string[], enable: boolean, role: ModuleRole): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const verb = enable ? 'enable' : 'disable';
  if (positionals.length === 0) {
    deps.io.err(
      `${COMMAND[role]} ${verb} needs at least one ${role} id. Installed: ${checkIds(deps, role, []).ids.join(', ') || 'none'}\n`,
    );
    return EXIT.usage;
  }
  // an id that is not installed is for `setModulesEnabled` to judge: enabling refuses it, disabling cleans it up
  const checked = checkIds(
    deps,
    role,
    positionals.filter((id) => id in kitOf(deps, OTHER[role]).map),
  );
  if (checked.problem !== undefined) {
    deps.io.err(checked.problem);
    return EXIT.usage;
  }
  const settings = loadStorageSettings(deps.env);
  const before = (await readEnabledFile(settings.dataDir)) ?? { adapters: [], utilities: [] };
  const group = GROUP[role];
  const { ids, changed } = await setModulesEnabled(settings, checked.ids.sort(), positionals, enable, group);
  const unchanged = [...new Set(positionals)].filter((id) => !changed.includes(id));
  if (changed.length > 0) deps.io.out(`${enable ? 'Enabled' : 'Disabled'}: ${changed.join(', ')}\n`);
  if (unchanged.length > 0) deps.io.out(`Already ${enable ? 'enabled' : 'disabled'}: ${unchanged.join(', ')}\n`);
  deps.io.out(`Enabled now: ${ids.length === 0 ? 'none' : ids.join(', ')}\n`);
  if (changed.length > 0 && before[group].join() !== ids.join()) await applyToRunningRouter(deps, settings.dataDir);
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
    if (command === 'adapters' || command === 'utilities') {
      const role: ModuleRole = command === 'adapters' ? 'adapter' : 'utility';
      if (subcommand === 'list') return await list(deps, rest, role);
      if (subcommand === 'enable') return await toggle(deps, rest, true, role);
      if (subcommand === 'disable') return await toggle(deps, rest, false, role);
      deps.io.err(`Unknown ${command} command: ${subcommand ?? '(none)'}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (command === 'login')
      return await login(
        deps,
        [subcommand, ...rest].filter((part): part is string => part !== undefined),
      );
    if (command === 'dashboard')
      return await dashboard(
        deps,
        [subcommand, ...rest].filter((part): part is string => part !== undefined),
      );
    if (command === 'linkedin-geo' || command === 'linked-geo')
      return await linkedinGeo(
        deps,
        [subcommand, ...rest].filter((part): part is string => part !== undefined),
      );
    if (command === 'doctor') return await doctor(deps);
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
