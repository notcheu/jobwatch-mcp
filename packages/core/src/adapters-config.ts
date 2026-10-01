import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from '@jobwatch/sdk';
import { ADAPTER_ID_PATTERN, type Config } from './config';
import { ConfigError } from './errors';

/**
 * Which installed adapters the router plugs in. Stored in `<dataDir>/adapters.json`:
 * `{ "enabled": ["linkedin"] }`. A fresh install has no file, which means NOTHING is enabled
 * (the LinkedIn usage budget must be approved before it is switched on, see 09-security.md).
 */
export const ADAPTERS_FILE = 'adapters.json';

const fileSchema = z
  .object({ enabled: z.array(z.string().regex(ADAPTER_ID_PATTERN)).max(64) })
  .strict()
  .refine((value) => new Set(value.enabled).size === value.enabled.length, { message: 'enabled lists an adapter twice' });

export type EnabledSource = 'env' | 'file' | 'default';

export interface EnabledAdapters {
  ids: string[];
  /** Where the list came from. `env` means the CLI must refuse to edit the file (JW_ADAPTERS wins). */
  source: EnabledSource;
}

export function adaptersFilePath(dataDir: string): string {
  return join(dataDir, ADAPTERS_FILE);
}

/** Read the file. Missing file = nothing enabled. A present but unreadable or invalid file is an error, never "nothing". */
export async function readEnabledFile(dataDir: string): Promise<string[] | undefined> {
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
  return parsed.data.enabled;
}

/** Resolve the effective list: JW_ADAPTERS wins over the file, the file over the empty default. */
export async function resolveEnabledAdapters(config: Pick<Config, 'adaptersFromEnv' | 'dataDir'>): Promise<EnabledAdapters> {
  if (config.adaptersFromEnv !== undefined) return { ids: [...config.adaptersFromEnv], source: 'env' };
  const fromFile = await readEnabledFile(config.dataDir);
  return fromFile === undefined ? { ids: [], source: 'default' } : { ids: fromFile, source: 'file' };
}

/** Write atomically (temp file in the same directory, then rename), sorted and de-duplicated. */
export async function writeEnabledFile(dataDir: string, ids: readonly string[]): Promise<void> {
  const path = adaptersFilePath(dataDir);
  const content = `${JSON.stringify({ enabled: [...new Set(ids)].sort() }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o644 });
  await rename(temp, path);
}

export interface ToggleResult {
  /** The list after the change. */
  ids: string[];
  /** Ids that were actually added or removed (unchanged ones are not listed). */
  changed: string[];
}

/**
 * Enable or disable adapters in the file. Enabling refuses ids that are not installed. Disabling accepts any id, so an
 * operator can always remove a stale entry (an adapter deleted from the code but still listed would stop the router
 * from starting). Refuses to edit while JW_ADAPTERS is set, because the environment would silently override the result.
 */
export async function setAdaptersEnabled(
  config: Pick<Config, 'adaptersFromEnv' | 'dataDir'>,
  installedIds: readonly string[],
  requested: readonly string[],
  enable: boolean,
): Promise<ToggleResult> {
  if (config.adaptersFromEnv !== undefined) {
    throw new ConfigError(['JW_ADAPTERS is set in the environment and overrides adapters.json: unset it, or edit JW_ADAPTERS instead']);
  }
  const unknown = enable ? requested.filter((id) => !installedIds.includes(id)) : [];
  if (unknown.length > 0) {
    throw new ConfigError([
      `not installed: ${unknown.join(', ')} (installed: ${installedIds.length === 0 ? 'none' : installedIds.join(', ')})`,
    ]);
  }
  const current = (await readEnabledFile(config.dataDir)) ?? [];
  const next = new Set(current);
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
  if (changed.length > 0) await writeEnabledFile(config.dataDir, ids);
  return { ids, changed };
}
