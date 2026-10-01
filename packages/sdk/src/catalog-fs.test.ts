import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpAdapter } from './__fixtures__/adapters';
import { stableStringify, buildCatalog } from './catalog';
import { diffCatalogSnapshot, writeCatalogSnapshot } from './catalog-fs';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-catalog-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('catalog snapshots on disk', () => {
  it('reports every file missing before the first write', async () => {
    expect(await diffCatalogSnapshot(httpAdapter, join(dir, 'does-not-exist'))).toEqual({
      missing: ['echo_greeting.json'],
      stale: [],
      changed: [],
    });
  });

  it('writes one deterministic file per tool and then reports no difference', async () => {
    expect(await writeCatalogSnapshot(httpAdapter, dir)).toEqual(['echo_greeting.json']);
    expect(await readFile(join(dir, 'echo_greeting.json'), 'utf8')).toBe(stableStringify(buildCatalog(httpAdapter)[0]));
    expect(await diffCatalogSnapshot(httpAdapter, dir)).toEqual({ missing: [], stale: [], changed: [] });
  });

  it('detects a hand-edited snapshot', async () => {
    await writeCatalogSnapshot(httpAdapter, dir);
    await writeFile(join(dir, 'echo_greeting.json'), '{"tampered":true}\n');
    expect((await diffCatalogSnapshot(httpAdapter, dir)).changed).toEqual(['echo_greeting.json']);
  });

  it('detects stale files of removed tools and removes them on write', async () => {
    await writeFile(join(dir, 'removed_tool.json'), '{}\n');
    expect((await diffCatalogSnapshot(httpAdapter, dir)).stale).toEqual(['removed_tool.json']);
    await writeCatalogSnapshot(httpAdapter, dir);
    expect(await readdir(dir)).toEqual(['echo_greeting.json']);
  });

  it('leaves non-JSON files alone', async () => {
    await writeFile(join(dir, 'README.md'), '# notes\n');
    await writeCatalogSnapshot(httpAdapter, dir);
    expect((await readdir(dir)).sort()).toEqual(['README.md', 'echo_greeting.json']);
  });
});
