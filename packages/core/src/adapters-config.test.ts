import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptersFilePath, readEnabledFile, resolveEnabledAdapters, setAdaptersEnabled, writeEnabledFile } from './adapters-config';
import { ConfigError } from './errors';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jw-adapters-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const installed = ['apec', 'linkedin'];
const fromFile = {
  adaptersFromEnv: undefined,
  get dataDir() {
    return dataDir;
  },
};

describe('fresh install', () => {
  it('has nothing enabled and says where that came from', async () => {
    expect(await readEnabledFile(dataDir)).toBeUndefined();
    expect(await resolveEnabledAdapters(fromFile)).toEqual({ ids: [], source: 'default' });
  });
});

describe('writeEnabledFile / readEnabledFile', () => {
  it('writes sorted, de-duplicated JSON atomically (no temp file left behind)', async () => {
    await writeEnabledFile(dataDir, ['linkedin', 'apec', 'linkedin']);
    expect(await readFile(adaptersFilePath(dataDir), 'utf8')).toBe('{\n  "enabled": [\n    "apec",\n    "linkedin"\n  ]\n}\n');
    expect(await readdir(dataDir)).toEqual(['adapters.json']);
    expect(await readEnabledFile(dataDir)).toEqual(['apec', 'linkedin']);
  });

  it('creates the data directory when missing', async () => {
    const nested = join(dataDir, 'a', 'b');
    await writeEnabledFile(nested, ['apec']);
    expect(await readEnabledFile(nested)).toEqual(['apec']);
  });
});

describe('a broken file is an error, never "nothing enabled"', () => {
  it.each([
    ['not json', '{oops'],
    ['wrong shape', '{"enabled":"linkedin"}'],
    ['extra keys', '{"enabled":[],"debug":true}'],
    ['bad id', '{"enabled":["../etc"]}'],
    ['duplicate', '{"enabled":["apec","apec"]}'],
    ['array root', '[]'],
  ])('%s', async (_name, content) => {
    await writeFile(adaptersFilePath(dataDir), content);
    await expect(readEnabledFile(dataDir)).rejects.toBeInstanceOf(ConfigError);
    await expect(resolveEnabledAdapters(fromFile)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('resolveEnabledAdapters precedence', () => {
  it('lets JW_ADAPTERS win over the file, even when it is empty', async () => {
    await writeEnabledFile(dataDir, ['linkedin']);
    expect(await resolveEnabledAdapters({ adaptersFromEnv: ['apec'], dataDir })).toEqual({ ids: ['apec'], source: 'env' });
    expect(await resolveEnabledAdapters({ adaptersFromEnv: [], dataDir })).toEqual({ ids: [], source: 'env' });
  });

  it('uses the file when the environment says nothing', async () => {
    await writeEnabledFile(dataDir, ['linkedin']);
    expect(await resolveEnabledAdapters(fromFile)).toEqual({ ids: ['linkedin'], source: 'file' });
  });
});

describe('setAdaptersEnabled', () => {
  it('enables, reports what changed, and is idempotent', async () => {
    expect(await setAdaptersEnabled(fromFile, installed, ['linkedin'], true)).toEqual({ ids: ['linkedin'], changed: ['linkedin'] });
    expect(await setAdaptersEnabled(fromFile, installed, ['linkedin', 'apec'], true)).toEqual({
      ids: ['apec', 'linkedin'],
      changed: ['apec'],
    });
    expect(await setAdaptersEnabled(fromFile, installed, ['apec'], true)).toEqual({ ids: ['apec', 'linkedin'], changed: [] });
  });

  it('disables and reports what changed', async () => {
    await writeEnabledFile(dataDir, ['apec', 'linkedin']);
    expect(await setAdaptersEnabled(fromFile, installed, ['linkedin'], false)).toEqual({ ids: ['apec'], changed: ['linkedin'] });
    expect(await setAdaptersEnabled(fromFile, installed, ['linkedin'], false)).toEqual({ ids: ['apec'], changed: [] });
  });

  it('does not touch the file when nothing changes', async () => {
    await setAdaptersEnabled(fromFile, installed, ['apec'], false);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('refuses ids that are not installed and says which', async () => {
    await expect(setAdaptersEnabled(fromFile, installed, ['linkedin', 'wttj'], true)).rejects.toThrow(
      /not installed: wttj \(installed: apec, linkedin\)/,
    );
    expect(await readEnabledFile(dataDir)).toBeUndefined();
  });

  it('refuses to edit while JW_ADAPTERS overrides the file', async () => {
    await expect(setAdaptersEnabled({ adaptersFromEnv: ['apec'], dataDir }, installed, ['linkedin'], true)).rejects.toThrow(
      /JW_ADAPTERS is set/,
    );
    expect(await readEnabledFile(dataDir)).toBeUndefined();
  });

  it('can always disable a stale entry whose adapter was deleted from the code', async () => {
    await writeEnabledFile(dataDir, ['apec', 'ghost']);
    expect(await setAdaptersEnabled(fromFile, installed, ['ghost'], false)).toEqual({ ids: ['apec'], changed: ['ghost'] });
    expect(await readEnabledFile(dataDir)).toEqual(['apec']);
  });

  it('treats disabling something that was never enabled as a no-op, not an error', async () => {
    expect(await setAdaptersEnabled(fromFile, installed, ['nonexistent'], false)).toEqual({ ids: [], changed: [] });
  });
});
