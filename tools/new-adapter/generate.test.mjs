import { describe, expect, it } from 'vitest';
import { addAdaptersDependency, addInstalledLine, adapterFiles, validateId } from './generate.mjs';

const source = `export const installed = {
  // <installed:begin>
  apec: () => import('@jobwatch/adapter-apec').then((m) => m.default),
  linkedin: () => import('@jobwatch/adapter-linkedin').then((m) => m.default),
  // <installed:end>
} satisfies InstalledMap;
`;
const emptySource = `export const installed = {\n  // <installed:begin>\n  // <installed:end>\n} satisfies InstalledMap;\n`;

describe('validateId', () => {
  it.each(['apec', 'wttj', 'my-ats', 'a1'])('accepts %s', (id) => {
    expect(() => validateId(id)).not.toThrow();
  });
  it.each(['', 'a', 'A', 'Apec', '1abc', 'ap_ec', '../etc', 'a b', 'x'.repeat(40), 'apec/../x'])('rejects %j', (id) => {
    expect(() => validateId(id)).toThrow(/Invalid adapter id/);
  });
});

describe('adapterFiles', () => {
  it('creates the package under packages/adapter-<id>', () => {
    const files = adapterFiles({ id: 'apec', kind: 'http' });
    expect(files.map((file) => file.path)).toEqual([
      'packages/adapter-apec/package.json',
      'packages/adapter-apec/tsconfig.json',
      'packages/adapter-apec/vitest.config.ts',
      'packages/adapter-apec/src/index.ts',
      'packages/adapter-apec/src/index.test.ts',
    ]);
  });

  it('tags the package as an adapter that depends on the sdk only', () => {
    const pkg = JSON.parse(adapterFiles({ id: 'apec', kind: 'http' })[0]?.content ?? '{}');
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
    const index = adapterFiles({ id: 'my-ats', kind: 'http' }).find((file) => file.path.endsWith('src/index.ts'))?.content ?? '';
    expect(index).toContain('defineHttpTool');
    expect(index).toContain("kind: 'http'");
    expect(index).toContain("name: 'my_ats_example'");
    expect(index).toContain('readOnlyHint: true');
    expect(index).toContain("id: 'my-ats'");
    expect(index).not.toContain('defineBrowserTool');
  });

  it('generates a browser adapter with a session check', () => {
    const index = adapterFiles({ id: 'wttj', kind: 'browser' }).find((file) => file.path.endsWith('src/index.ts'))?.content ?? '';
    expect(index).toContain('defineBrowserTool');
    expect(index).toContain("kind: 'browser'");
    expect(index).toContain('sessionCheck');
  });

  it('imports only the sdk (the lint rules would reject anything else)', () => {
    for (const kind of /** @type {const} */ (['http', 'browser'])) {
      for (const file of adapterFiles({ id: 'demo', kind }).filter((f) => f.path.endsWith('src/index.ts'))) {
        const imports = [...file.content.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        expect(imports).toEqual(['@jobwatch/sdk']);
      }
    }
  });

  it('generates code that satisfies the strict lint rules (no non-null assertions)', () => {
    for (const kind of /** @type {const} */ (['http', 'browser'])) {
      for (const file of adapterFiles({ id: 'demo', kind }).filter((f) => f.path.endsWith('.ts'))) {
        expect(file.content, file.path).not.toMatch(/\w!\.|\w!\)|\w!\[/);
      }
    }
  });

  it('uses a display name when given and derives one otherwise', () => {
    expect(adapterFiles({ id: 'my-ats', kind: 'http' })[3]?.content).toContain("displayName: 'My Ats'");
    expect(adapterFiles({ id: 'wttj', kind: 'http', displayName: 'Welcome to the Jungle' })[3]?.content).toContain(
      "displayName: 'Welcome to the Jungle'",
    );
  });

  it('refuses a bad id or kind', () => {
    expect(() => adapterFiles({ id: 'Bad', kind: 'http' })).toThrow(/Invalid adapter id/);
    // @ts-expect-error testing an invalid kind on purpose
    expect(() => adapterFiles({ id: 'ok-id', kind: 'ftp' })).toThrow(/Invalid kind/);
  });
});

describe('addInstalledLine', () => {
  it('inserts between the markers in sorted order', () => {
    const out = addInstalledLine(source, 'ats');
    const keys = [...out.matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    expect(keys).toEqual(['apec', 'ats', 'linkedin']);
    expect(out).toContain("ats: () => import('@jobwatch/adapter-ats').then((m) => m.default),");
  });

  it('works on an empty table and keeps the markers and the closing', () => {
    const out = addInstalledLine(emptySource, 'apec');
    expect(out).toBe(
      `export const installed = {\n  // <installed:begin>\n  apec: () => import('@jobwatch/adapter-apec').then((m) => m.default),\n  // <installed:end>\n} satisfies InstalledMap;\n`,
    );
  });

  it('quotes keys that contain a hyphen and sorts them correctly', () => {
    const out = addInstalledLine(addInstalledLine(emptySource, 'my-ats'), 'apec');
    expect(out).toContain("'my-ats': () => import('@jobwatch/adapter-my-ats')");
    expect(out.indexOf('apec:')).toBeLessThan(out.indexOf("'my-ats':"));
  });

  it('refuses a duplicate and missing markers', () => {
    expect(() => addInstalledLine(source, 'apec')).toThrow(/already in the installed table/);
    expect(() => addInstalledLine('export const installed = {};', 'apec')).toThrow(/missing the/);
  });

  it('never touches anything outside the markers', () => {
    const out = addInstalledLine(source, 'ats');
    expect(out.startsWith('export const installed = {\n  // <installed:begin>\n')).toBe(true);
    expect(out.endsWith('  // <installed:end>\n} satisfies InstalledMap;\n')).toBe(true);
  });
});

describe('addAdaptersDependency', () => {
  const pkg = JSON.stringify(
    { name: '@jobwatch/adapters', dependencies: { '@jobwatch/sdk': '*', '@jobwatch/adapter-linkedin': '*' } },
    null,
    2,
  );

  it('adds a sorted dependency', () => {
    const json = JSON.parse(addAdaptersDependency(pkg, 'apec'));
    expect(Object.keys(json.dependencies)).toEqual(['@jobwatch/adapter-apec', '@jobwatch/adapter-linkedin', '@jobwatch/sdk']);
  });

  it('creates the dependencies object when absent and refuses duplicates', () => {
    expect(JSON.parse(addAdaptersDependency('{"name":"x"}', 'apec')).dependencies).toEqual({ '@jobwatch/adapter-apec': '*' });
    expect(() => addAdaptersDependency(pkg, 'linkedin')).toThrow(/already a dependency/);
  });
});
