/**
 * Node-only entry point (`@jobwatch/sdk/catalog-fs`): read and write the committed catalog snapshots of an adapter.
 * Kept out of the main entry so adapter code never gets file-system helpers through the SDK.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpModule } from './adapter';
import { buildCatalog, catalogFileName, stableStringify } from './catalog';

/** Write one JSON file per tool into `dir` and delete stale `*.json` files of removed tools. */
export async function writeCatalogSnapshot(adapter: McpModule, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const entries = buildCatalog(adapter);
  const wanted = new Set(entries.map((entry) => catalogFileName(entry.name)));
  for (const file of await readdir(dir)) {
    if (file.endsWith('.json') && !wanted.has(file)) await rm(join(dir, file));
  }
  for (const entry of entries) await writeFile(join(dir, catalogFileName(entry.name)), stableStringify(entry));
  return [...wanted];
}

export interface SnapshotDiff {
  missing: string[];
  stale: string[];
  changed: string[];
}

/** Compare the committed snapshot in `dir` with what the adapter defines now. Empty arrays everywhere = in sync. */
export async function diffCatalogSnapshot(adapter: McpModule, dir: string): Promise<SnapshotDiff> {
  const entries = buildCatalog(adapter);
  const wanted = new Map(entries.map((entry) => [catalogFileName(entry.name), stableStringify(entry)]));
  const existing = await readdir(dir).then(
    (files) => files.filter((file) => file.endsWith('.json')),
    () => [] as string[],
  );
  const diff: SnapshotDiff = { missing: [], stale: [], changed: [] };
  for (const [file, content] of wanted) {
    if (!existing.includes(file)) diff.missing.push(file);
    else if ((await readFile(join(dir, file), 'utf8')) !== content) diff.changed.push(file);
  }
  for (const file of existing) if (!wanted.has(file)) diff.stale.push(file);
  return diff;
}
