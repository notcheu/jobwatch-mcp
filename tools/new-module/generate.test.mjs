import { describe, expect, it } from 'vitest';
import { addInstalledLine, addModulesDependency, moduleFiles, validateId } from './generate.mjs';

const source = `export const installedAdapters = {
  // <adapters:begin>
  apec: () => import('@jobwatch/adapter-apec').then((m) => m.default),
  linkedin: () => import('@jobwatch/adapter-linkedin').then((m) => m.default),
  // <adapters:end>
} satisfies InstalledAdapterMap;
export const installedUtilities = {
  // <utilities:begin>
  'linkedin-geo': () => import('@jobwatch/utility-linkedin-geo').then((m) => m.default),
  // <utilities:end>
} satisfies InstalledUtilityMap;
`;
const emptySource = `export const installedAdapters = {\n  // <adapters:begin>\n  // <adapters:end>\n} satisfies InstalledAdapterMap;\n`;

describe('validateId', () => {
  it.each(['apec', 'wttj', 'my-ats', 'a1'])('accepts %s', (id) => {
    expect(() => validateId(id)).not.toThrow();
  });
  it.each(['', 'a', 'A', 'Apec', '1abc', 'ap_ec', '../etc', 'a b', 'x'.repeat(40), 'apec/../x'])('rejects %j', (id) => {
    expect(() => validateId(id)).toThrow(/Invalid id/);
  });
});

describe('moduleFiles', () => {
  it('creates the package under packages/adapter-<id>', () => {
    const files = moduleFiles({ id: 'apec', kind: 'http' });
    expect(files.map((file) => file.path)).toEqual([
      'packages/adapter-apec/package.json',
      'packages/adapter-apec/tsconfig.json',
      'packages/adapter-apec/vitest.config.ts',
      'packages/adapter-apec/src/index.ts',
      'packages/adapter-apec/src/index.test.ts',
    ]);
  });

  it('tags the package as an adapter that depends on the sdk only', () => {
    const pkg = JSON.parse(moduleFiles({ id: 'apec', kind: 'http' })[0]?.content ?? '{}');
    expect(pkg).toMatchObject({
      name: '@jobwatch/adapter-apec',
      private: true,
      type: 'module',
      dependencies: { '@jobwatch/sdk': '*' },
      nx: { tags: ['type:adapter'] },
    });
    expect(Object.keys(pkg.dependencies)).toEqual(['@jobwatch/sdk']);
  });

  it('generates an http adapter with a read-only example tool', () => {
    const index = moduleFiles({ id: 'my-ats', kind: 'http' }).find((file) => file.path.endsWith('src/index.ts'))?.content ?? '';
    expect(index).toContain('defineHttpTool');
    expect(index).toContain("kind: 'http'");
    expect(index).toContain("name: 'my_ats_example'");
    expect(index).toContain('readOnlyHint: true');
    expect(index).toContain("id: 'my-ats'");
    expect(index).not.toContain('defineBrowserTool');
  });

  it('generates a browser adapter with a session check', () => {
    const index = moduleFiles({ id: 'wttj', kind: 'browser' }).find((file) => file.path.endsWith('src/index.ts'))?.content ?? '';
    expect(index).toContain('defineBrowserTool');
    expect(index).toContain("kind: 'browser'");
    expect(index).toContain('sessionCheck');
  });

  it('imports only the sdk (the lint rules would reject anything else)', () => {
    for (const kind of /** @type {const} */ (['http', 'browser'])) {
      for (const file of moduleFiles({ id: 'demo', kind }).filter((f) => f.path.endsWith('src/index.ts'))) {
        const imports = [...file.content.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        expect(imports).toEqual(['@jobwatch/sdk']);
      }
    }
  });

  it('generates code that satisfies the strict lint rules (no non-null assertions)', () => {
    for (const kind of /** @type {const} */ (['http', 'browser'])) {
      for (const file of moduleFiles({ id: 'demo', kind }).filter((f) => f.path.endsWith('.ts'))) {
        expect(file.content, file.path).not.toMatch(/\w!\.|\w!\)|\w!\[/);
      }
    }
  });

  it('uses a display name when given and derives one otherwise', () => {
    expect(moduleFiles({ id: 'my-ats', kind: 'http' })[3]?.content).toContain("displayName: 'My Ats'");
    expect(moduleFiles({ id: 'wttj', kind: 'http', displayName: 'Welcome to the Jungle' })[3]?.content).toContain(
      "displayName: 'Welcome to the Jungle'",
    );
  });

  it('refuses a bad id or kind', () => {
    expect(() => moduleFiles({ id: 'Bad', kind: 'http' })).toThrow(/Invalid id/);
    // @ts-expect-error testing an invalid kind on purpose
    expect(() => moduleFiles({ id: 'ok-id', kind: 'ftp' })).toThrow(/Invalid kind/);
  });
});

describe('addInstalledLine', () => {
  it('inserts between the markers in sorted order', () => {
    const out = addInstalledLine(source, 'ats');
    const keys = [...out.slice(0, out.indexOf('<adapters:end>')).matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    expect(keys).toEqual(['apec', 'ats', 'linkedin']);
    expect(out).toContain("ats: () => import('@jobwatch/adapter-ats').then((m) => m.default),");
  });

  it('works on an empty table and keeps the markers and the closing', () => {
    const out = addInstalledLine(emptySource, 'apec');
    expect(out).toBe(
      `export const installedAdapters = {\n  // <adapters:begin>\n  apec: () => import('@jobwatch/adapter-apec').then((m) => m.default),\n  // <adapters:end>\n} satisfies InstalledAdapterMap;\n`,
    );
  });

  it('quotes keys that contain a hyphen and sorts them correctly', () => {
    const out = addInstalledLine(addInstalledLine(emptySource, 'my-ats'), 'apec');
    expect(out).toContain("'my-ats': () => import('@jobwatch/adapter-my-ats')");
    expect(out.indexOf('apec:')).toBeLessThan(out.indexOf("'my-ats':"));
  });

  it('refuses a duplicate and missing markers', () => {
    expect(() => addInstalledLine(source, 'apec')).toThrow(/already in the installed table/);
    expect(() => addInstalledLine('export const installedAdapters = {};', 'apec')).toThrow(/missing the/);
  });

  it('never touches anything outside the markers', () => {
    const out = addInstalledLine(source, 'ats');
    expect(out.startsWith('export const installedAdapters = {\n  // <adapters:begin>\n')).toBe(true);
    expect(out.endsWith('  // <utilities:end>\n} satisfies InstalledUtilityMap;\n')).toBe(true);
  });
});

describe('addModulesDependency', () => {
  const pkg = JSON.stringify(
    { name: '@jobwatch/mcp-modules', dependencies: { '@jobwatch/sdk': '*', '@jobwatch/adapter-linkedin': '*' } },
    null,
    2,
  );

  it('adds a sorted dependency', () => {
    const json = JSON.parse(addModulesDependency(pkg, 'apec'));
    expect(Object.keys(json.dependencies)).toEqual(['@jobwatch/adapter-apec', '@jobwatch/adapter-linkedin', '@jobwatch/sdk']);
  });

  it('creates the dependencies object when absent and refuses duplicates', () => {
    expect(JSON.parse(addModulesDependency('{"name":"x"}', 'apec')).dependencies).toEqual({ '@jobwatch/adapter-apec': '*' });
    expect(() => addModulesDependency(pkg, 'linkedin')).toThrow(/already a dependency/);
  });
});

describe('utilities', () => {
  it('creates the package under packages/utility-<id>, tagged type:utility, with the sdk as its only dependency', () => {
    const files = moduleFiles({ id: 'geo-lookup', role: 'utility' });
    expect(files.map((file) => file.path)[0]).toBe('packages/utility-geo-lookup/package.json');
    const pkg = JSON.parse(files[0]?.content ?? '{}');
    expect(pkg).toMatchObject({
      name: '@jobwatch/utility-geo-lookup',
      nx: { tags: ['type:utility'] },
      dependencies: { '@jobwatch/sdk': '*' },
    });
  });

  it('declares it with defineUtility, without a kind, and imports only the sdk', () => {
    const index = moduleFiles({ id: 'geo-lookup', role: 'utility' }).find((file) => file.path.endsWith('src/index.ts'))?.content ?? '';
    expect(index).toContain('defineUtility');
    expect(index).not.toContain('defineAdapter');
    expect(index).not.toContain("kind: 'http'");
    expect(index).toContain('Geo Lookup utility');
    expect([...index.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['@jobwatch/sdk']);
  });

  it('is always http', () => {
    expect(() => moduleFiles({ id: 'geo-lookup', role: 'utility', kind: 'browser' })).toThrow(/always http/);
  });

  it('is added to the utilities map only, and its dependency is the utility package', () => {
    const out = addInstalledLine(source, 'ats-discovery', 'utility');
    expect(out).toContain("'ats-discovery': () => import('@jobwatch/utility-ats-discovery')");
    expect(out.indexOf('utility-ats-discovery')).toBeGreaterThan(out.indexOf('<utilities:begin>'));
    expect(out.slice(0, out.indexOf('<adapters:end>'))).not.toContain('ats-discovery');
    expect(() => addInstalledLine(source, 'linkedin-geo', 'utility')).toThrow(/Utility "linkedin-geo" is already/);
    expect(Object.keys(JSON.parse(addModulesDependency('{"dependencies":{}}', 'geo', 'utility')).dependencies)).toEqual([
      '@jobwatch/utility-geo',
    ]);
  });
});
