import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from '@jobwatch/sdk';
import { ADAPTER_ID_PATTERN, type Config } from './config';
import { ConfigError } from './errors';

/**
 * Which installed modules the router plugs in. Stored in `<dataDir>/adapters.json`:
 * `{ "enabled": ["linkedin"], "utilities": ["linkedin-geo"] }`: `enabled` lists the adapters (they fetch jobs), `utilities` the
 * utilities (helper tools). A fresh install has no file, which means NOTHING is enabled
 * (the LinkedIn usage budget must be approved before it is switched on, see docs/plans/09-security.md).
 */
export const ADAPTERS_FILE = 'adapters.json';

/** The two kinds of module that can be enabled, as the CLI groups them. */
export type ModuleGroup = 'adapters' | 'utilities';

export interface EnabledLists {
  adapters: string[];
  utilities: string[];
}

const idList = z.array(z.string().regex(ADAPTER_ID_PATTERN)).max(64);
const fileSchema = z
  .object({ enabled: idList, utilities: idList.default([]) })
  .strict()
  .refine((value) => new Set(value.enabled).size === value.enabled.length, { message: 'enabled lists an adapter twice' })
  .refine((value) => new Set(value.utilities).size === value.utilities.length, { message: 'utilities lists a utility twice' });

export type EnabledSource = 'env' | 'file' | 'default';

export interface EnabledModules {
  /** Every enabled module, adapters and utilities: what the registry loads. */
  ids: string[];
  adapters: string[];
  utilities: string[];
  /** Where the list came from. `env` means a list is set by the environment (JW_ADAPTERS or JW_UTILITIES) and the CLI must refuse to edit it. */
  source: EnabledSource;
}

export function adaptersFilePath(dataDir: string): string {
  return join(dataDir, ADAPTERS_FILE);
}

/** Read the file. Missing file = nothing enabled. A present but unreadable or invalid file is an error, never "nothing". */
export async function readEnabledFile(dataDir: string): Promise<EnabledLists | undefined> {
  const path = adaptersFilePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError([`${path}: cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError([`${path}: is not valid JSON`]);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success)
    throw new ConfigError(parsed.error.issues.map((issue) => `${path}: ${issue.path.join('.') || 'file'}: ${issue.message}`));
  return { adapters: parsed.data.enabled, utilities: parsed.data.utilities };
}

type EnvLists = Pick<Config, 'adaptersFromEnv' | 'dataDir'> & Partial<Pick<Config, 'utilitiesFromEnv'>>;

/** Resolve the effective lists: JW_ADAPTERS and JW_UTILITIES win over the file, the file over the empty default. */
export async function resolveEnabledModules(config: EnvLists): Promise<EnabledModules> {
  const fromFile =
    config.adaptersFromEnv !== undefined && config.utilitiesFromEnv !== undefined ? undefined : await readEnabledFile(config.dataDir);
  const adapters = config.adaptersFromEnv !== undefined ? [...config.adaptersFromEnv] : (fromFile?.adapters ?? []);
  const utilities = config.utilitiesFromEnv !== undefined ? [...config.utilitiesFromEnv] : (fromFile?.utilities ?? []);
  const source: EnabledSource =
    config.adaptersFromEnv !== undefined || config.utilitiesFromEnv !== undefined ? 'env' : fromFile === undefined ? 'default' : 'file';
  return { ids: [...new Set([...adapters, ...utilities])], adapters, utilities, source };
}

/** Write atomically (temp file in the same directory, then rename), sorted and de-duplicated. */
export async function writeEnabledFile(dataDir: string, lists: EnabledLists): Promise<void> {
  const path = adaptersFilePath(dataDir);
  const sorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort();
  const content = `${JSON.stringify({ enabled: sorted(lists.adapters), utilities: sorted(lists.utilities) }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o644 });
  await rename(temp, path);
}

export interface ToggleResult {
  /** The list of that group after the change. */
  ids: string[];
  /** Ids that were actually added or removed (unchanged ones are not listed). */
  changed: string[];
}

/** The variable that pins a group, for messages. */
export const pinVariable = (group: ModuleGroup): string => (group === 'adapters' ? 'JW_ADAPTERS' : 'JW_UTILITIES');

/** True when the environment pins this group, so the file is not edited. */
export const isPinned = (config: Pick<EnvLists, 'adaptersFromEnv' | 'utilitiesFromEnv'>, group: ModuleGroup): boolean =>
  (group === 'adapters' ? config.adaptersFromEnv : config.utilitiesFromEnv) !== undefined;

/**
 * Enable or disable modules of one group in the file. Enabling refuses ids that are not installed (`installedIds` is the ids of
 * that group). Disabling accepts any id, so an operator can always remove a stale entry (a module deleted from the code but still
 * listed would stop the router from starting). Refuses to edit while the group's variable is set, because the environment would
 * silently override the result.
 */
export async function setModulesEnabled(
  config: EnvLists,
  installedIds: readonly string[],
  requested: readonly string[],
  enable: boolean,
  group: ModuleGroup = 'adapters',
): Promise<ToggleResult> {
  if (isPinned(config, group)) {
    throw new ConfigError([
      `${pinVariable(group)} is set in the environment and overrides ${ADAPTERS_FILE}: unset it, or edit ${pinVariable(group)} instead`,
    ]);
  }
  const unknown = enable ? requested.filter((id) => !installedIds.includes(id)) : [];
  if (unknown.length > 0) {
    throw new ConfigError([
      `not installed: ${unknown.join(', ')} (installed: ${installedIds.length === 0 ? 'none' : installedIds.join(', ')})`,
    ]);
  }
  const lists = (await readEnabledFile(config.dataDir)) ?? { adapters: [], utilities: [] };
  const next = new Set(lists[group]);
  const changed: string[] = [];
  for (const id of requested) {
    if (enable && !next.has(id)) {
      next.add(id);
      changed.push(id);
    } else if (!enable && next.delete(id)) {
      changed.push(id);
    }
  }
  const ids = [...next].sort();
  // a utility enabled before the groups existed sits in `enabled`: disabling it removes it from there too
  const other: ModuleGroup = group === 'adapters' ? 'utilities' : 'adapters';
  const stray = enable ? [] : requested.filter((id) => lists[other].includes(id));
  if (changed.length > 0 || stray.length > 0)
    await writeEnabledFile(config.dataDir, { ...lists, [group]: ids, [other]: lists[other].filter((id) => !stray.includes(id)) });
  if (stray.length > 0) changed.push(...stray.filter((id) => !changed.includes(id)));
  return { ids, changed };
}
