import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptersFilePath, readEnabledFile, resolveEnabledModules, setModulesEnabled, writeEnabledFile } from './adapters-config';
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
    expect(await resolveEnabledModules(fromFile)).toEqual({ ids: [], adapters: [], utilities: [], source: 'default' });
  });
});

describe('writeEnabledFile / readEnabledFile', () => {
  it('writes sorted, de-duplicated JSON atomically (no temp file left behind)', async () => {
    await writeEnabledFile(dataDir, { adapters: ['linkedin', 'apec', 'linkedin'], utilities: ['linkedin-geo'] });
    expect(await readFile(adaptersFilePath(dataDir), 'utf8')).toBe(
      '{\n  "enabled": [\n    "apec",\n    "linkedin"\n  ],\n  "utilities": [\n    "linkedin-geo"\n  ]\n}\n',
    );
    expect(await readdir(dataDir)).toEqual(['adapters.json']);
    expect(await readEnabledFile(dataDir)).toEqual({ adapters: ['apec', 'linkedin'], utilities: ['linkedin-geo'] });
  });

  it('creates the data directory when missing', async () => {
    const nested = join(dataDir, 'a', 'b');
    await writeEnabledFile(nested, { adapters: ['apec'], utilities: [] });
    expect(await readEnabledFile(nested)).toEqual({ adapters: ['apec'], utilities: [] });
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
    await expect(resolveEnabledModules(fromFile)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('resolveEnabledModules precedence', () => {
  it('lets ADAPTERS win over the file, even when it is empty', async () => {
    await writeEnabledFile(dataDir, { adapters: ['linkedin'], utilities: [] });
    expect(await resolveEnabledModules({ adaptersFromEnv: ['apec'], dataDir })).toEqual({
      ids: ['apec'],
      adapters: ['apec'],
      utilities: [],
      source: 'env',
    });
    expect(await resolveEnabledModules({ adaptersFromEnv: [], dataDir })).toEqual({ ids: [], adapters: [], utilities: [], source: 'env' });
  });

  it('uses the file when the environment says nothing', async () => {
    await writeEnabledFile(dataDir, { adapters: ['linkedin'], utilities: [] });
    expect(await resolveEnabledModules(fromFile)).toEqual({ ids: ['linkedin'], adapters: ['linkedin'], utilities: [], source: 'file' });
  });
});

describe('setModulesEnabled', () => {
  it('enables, reports what changed, and is idempotent', async () => {
    expect(await setModulesEnabled(fromFile, installed, ['linkedin'], true)).toEqual({ ids: ['linkedin'], changed: ['linkedin'] });
    expect(await setModulesEnabled(fromFile, installed, ['linkedin', 'apec'], true)).toEqual({
      ids: ['apec', 'linkedin'],
      changed: ['apec'],
    });
    expect(await setModulesEnabled(fromFile, installed, ['apec'], true)).toEqual({ ids: ['apec', 'linkedin'], changed: [] });
  });

  it('disables and reports what changed', async () => {
    await writeEnabledFile(dataDir, { adapters: ['apec', 'linkedin'], utilities: [] });
    expect(await setModulesEnabled(fromFile, installed, ['linkedin'], false)).toEqual({ ids: ['apec'], changed: ['linkedin'] });
    expect(await setModulesEnabled(fromFile, installed, ['linkedin'], false)).toEqual({ ids: ['apec'], changed: [] });
  });

  it('does not touch the file when nothing changes', async () => {
    await setModulesEnabled(fromFile, installed, ['apec'], false);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('refuses ids that are not installed and says which', async () => {
    await expect(setModulesEnabled(fromFile, installed, ['linkedin', 'wttj'], true)).rejects.toThrow(
      /not installed: wttj \(installed: apec, linkedin\)/,
    );
    expect(await readEnabledFile(dataDir)).toBeUndefined();
  });

  it('refuses to edit while ADAPTERS overrides the file', async () => {
    await expect(setModulesEnabled({ adaptersFromEnv: ['apec'], dataDir }, installed, ['linkedin'], true)).rejects.toThrow(
      /ADAPTERS is set/,
    );
    expect(await readEnabledFile(dataDir)).toBeUndefined();
  });

  it('can always disable a stale entry whose adapter was deleted from the code', async () => {
    await writeEnabledFile(dataDir, { adapters: ['apec', 'ghost'], utilities: [] });
    expect(await setModulesEnabled(fromFile, installed, ['ghost'], false)).toEqual({ ids: ['apec'], changed: ['ghost'] });
    expect(await readEnabledFile(dataDir)).toEqual({ adapters: ['apec'], utilities: [] });
  });

  it('treats disabling something that was never enabled as a no-op, not an error', async () => {
    expect(await setModulesEnabled(fromFile, installed, ['nonexistent'], false)).toEqual({ ids: [], changed: [] });
  });
});

describe('utilities are a group of their own', () => {
  const utilities = ['linkedin-geo', 'ats-discovery'];

  it('enables them in their own list, leaving the adapters alone', async () => {
    await setModulesEnabled(fromFile, installed, ['apec'], true);
    expect(await setModulesEnabled(fromFile, utilities, ['linkedin-geo'], true, 'utilities')).toEqual({
      ids: ['linkedin-geo'],
      changed: ['linkedin-geo'],
    });
    expect(await readEnabledFile(dataDir)).toEqual({ adapters: ['apec'], utilities: ['linkedin-geo'] });
    expect(await resolveEnabledModules(fromFile)).toEqual({
      ids: ['apec', 'linkedin-geo'],
      adapters: ['apec'],
      utilities: ['linkedin-geo'],
      source: 'file',
    });
  });

  it('is pinned by UTILITIES alone, and the adapters then still come from the file', async () => {
    await writeEnabledFile(dataDir, { adapters: ['apec'], utilities: [] });
    const env = { adaptersFromEnv: undefined, utilitiesFromEnv: ['ats-discovery'], dataDir };
    expect(await resolveEnabledModules(env)).toEqual({
      ids: ['apec', 'ats-discovery'],
      adapters: ['apec'],
      utilities: ['ats-discovery'],
      source: 'env',
    });
    await expect(setModulesEnabled(env, utilities, ['linkedin-geo'], true, 'utilities')).rejects.toThrow(/UTILITIES is set/);
    expect((await setModulesEnabled(env, installed, ['linkedin'], true)).ids).toEqual(['apec', 'linkedin']);
  });

  it('reads a file written before utilities existed, and disabling clears a utility left among the adapters', async () => {
    await writeFile(adaptersFilePath(dataDir), '{"enabled":["apec","linkedin-geo"]}');
    expect((await resolveEnabledModules(fromFile)).ids).toEqual(['apec', 'linkedin-geo']);
    expect(await setModulesEnabled(fromFile, utilities, ['linkedin-geo'], false, 'utilities')).toEqual({
      ids: [],
      changed: ['linkedin-geo'],
    });
    expect(await readEnabledFile(dataDir)).toEqual({ adapters: ['apec'], utilities: [] });
  });
});
