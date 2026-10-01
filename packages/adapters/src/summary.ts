import { summarizeAdapter, type AdapterSummary } from '@jobwatch/sdk';
import type { InstalledMap } from './index';

export type InstalledEntry =
  { id: string; summary: AdapterSummary; error?: undefined } | { id: string; summary?: undefined; error: string };

/**
 * Load every installed adapter just far enough to describe it (what `jobwatch adapters list` shows).
 * A broken adapter is reported with its error instead of hiding the others.
 */
export async function describeInstalled(map: InstalledMap): Promise<InstalledEntry[]> {
  const entries: InstalledEntry[] = [];
  for (const id of Object.keys(map).sort()) {
    const load = map[id];
    if (load === undefined) continue;
    try {
      const adapter = await load();
      entries.push(
        adapter.id === id
          ? { id, summary: summarizeAdapter(adapter) }
          : { id, error: `module declares id "${adapter.id}", expected "${id}"` },
      );
    } catch (error) {
      entries.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return entries;
}
