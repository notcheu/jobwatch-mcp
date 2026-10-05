import {
  summarizeAdapter,
  summarizeModule,
  summarizeUtility,
  type AdapterSummary,
  type McpModule,
  type ModuleSummary,
  type UtilitySummary,
} from '@jobwatch/sdk';
import type { InstalledAdapterMap, InstalledModuleMap, InstalledUtilityMap } from './index';

type Entry<S> = { id: string; summary: S; error?: undefined } | { id: string; summary?: undefined; error: string };
export type AdapterEntry = Entry<AdapterSummary>;
export type UtilityEntry = Entry<UtilitySummary>;
export type ModuleEntry = Entry<ModuleSummary>;

/**
 * Load every installed module just far enough to describe it (what `jobwatch adapters list` shows). A broken one is reported with
 * its error instead of hiding the others; so is one whose id differs from its key, or whose role is not the map's.
 */
async function describe<M extends McpModule, S>(
  map: Readonly<Record<string, () => Promise<M>>>,
  summarize: (module: M) => S,
  role: string | null,
): Promise<Entry<S>[]> {
  const entries: Entry<S>[] = [];
  for (const id of Object.keys(map).sort()) {
    const load = map[id];
    if (load === undefined) continue;
    try {
      const module = await load();
      if (module.id !== id) entries.push({ id, error: `module declares id "${module.id}", expected "${id}"` });
      else if (role !== null && (module.role ?? 'adapter') !== role)
        entries.push({ id, error: `is not ${role === 'adapter' ? 'an' : 'a'} ${role}` });
      else entries.push({ id, summary: summarize(module) });
    } catch (error) {
      entries.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return entries;
}

export const describeInstalledAdapters = (map: InstalledAdapterMap): Promise<AdapterEntry[]> => describe(map, summarizeAdapter, 'adapter');
export const describeInstalledUtilities = (map: InstalledUtilityMap): Promise<UtilityEntry[]> => describe(map, summarizeUtility, 'utility');
export const describeInstalledModules = (map: InstalledModuleMap): Promise<ModuleEntry[]> => describe(map, summarizeModule, null);
