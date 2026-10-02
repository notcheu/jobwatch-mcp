// Pure functions that build a new adapter package. No file system access here: index.mjs applies the result.

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const BEGIN = '// <installed:begin>';
const END = '// <installed:end>';

/** @param {string} id */
export function validateId(id) {
  if (!ID_PATTERN.test(id))
    throw new Error(`Invalid adapter id "${id}": use 2-32 characters, lowercase letters, digits and hyphens, starting with a letter.`);
}

/** @param {string} id */
const snake = (id) => id.replaceAll('-', '_');
/** @param {string} id */
const title = (id) =>
  id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/**
 * @typedef {{ id: string, kind: 'http' | 'browser', displayName?: string }} AdapterSpec
 * @typedef {{ path: string, content: string }} GeneratedFile
 */

/**
 * Files of the new package, relative to the repository root.
 * @param {AdapterSpec} spec
 * @returns {GeneratedFile[]}
 */
export function adapterFiles(spec) {
  const { id, kind } = spec;
  validateId(id);
  if (kind !== 'http' && kind !== 'browser') throw new Error(`Invalid kind "${String(kind)}": use http or browser.`);
  const dir = `packages/adapter-${id}`;
  const name = spec.displayName ?? title(id);
  const tool = `${snake(id)}_example`;
  const browser = kind === 'browser';

  const packageJson = {
    name: `@jobwatch/adapter-${id}`,
    version: '0.0.0',
    private: true,
    description: `${name} adapter (read-only).`,
    type: 'module',
    exports: { '.': './src/index.ts' },
    dependencies: { '@jobwatch/sdk': '*' },
    scripts: { lint: 'eslint .', typecheck: 'tsc -p tsconfig.json', test: 'vitest run' },
    nx: { tags: ['type:adapter'] },
  };

  const index = browser
    ? `import { SDK_API_VERSION, defineAdapter, defineBrowserTool, z } from '@jobwatch/sdk';

// TODO: replace this example with the real tools of the ${name} adapter (see docs/plans/03-router-spec.md, "Adapter SDK").
const exampleTool = defineBrowserTool({
  name: '${tool}',
  title: '${name} example (read-only)',
  description: 'Example tool of the ${name} adapter. Read-only, no side effects.',
  input: z.object({}).strict(),
  output: z.object({ title: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  limits: { timeoutS: 60, cost: 1, outputMaxBytes: 60_000 },
  handler: async (_args, { session }) => {
    await session.goto('https://www.example.com/', { timeoutMs: 15_000 });
    return { data: { title: (await session.text('h1')) ?? '' }, warnings: [] };
  },
});

export default defineAdapter({
  id: '${id}',
  displayName: '${name}',
  description: '${name} adapter (read-only).',
  sdkApi: SDK_API_VERSION,
  platform: '${id}',
  kind: 'browser',
  allowedHosts: ['www.example.com'],
  sessionCheck: async (session) => {
    await session.goto('https://www.example.com/', { timeoutMs: 15_000 });
    return { state: 'unknown', note: 'TODO: detect the logged-in state of the platform' };
  },
  tools: [exampleTool],
});
`
    : `import { SDK_API_VERSION, defineAdapter, defineHttpTool, z } from '@jobwatch/sdk';

// TODO: replace this example with the real tools of the ${name} adapter (see docs/plans/03-router-spec.md, "Adapter SDK").
const exampleTool = defineHttpTool({
  name: '${tool}',
  title: '${name} example (read-only)',
  description: 'Example tool of the ${name} adapter. Read-only, no side effects.',
  input: z.object({ query: z.string().max(200) }).strict(),
  output: z.object({ ok: z.boolean() }),
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  limits: { timeoutS: 30, cost: 1, outputMaxBytes: 60_000 },
  handler: async (_args, { http }) => {
    const response = await http.get('https://api.example.com/health');
    return { data: { ok: response.ok }, warnings: [] };
  },
});

export default defineAdapter({
  id: '${id}',
  displayName: '${name}',
  description: '${name} adapter (read-only).',
  sdkApi: SDK_API_VERSION,
  platform: '${id}',
  kind: 'http',
  allowedHosts: ['api.example.com'],
  tools: [exampleTool],
});
`;

  const testContext = browser ? 'createBrowserTestContext' : 'createHttpTestContext';
  const contextOptions = browser
    ? "{ allowedHosts: adapter.allowedHosts, pages: { 'https://www.example.com/': { texts: { h1: 'Example' } } } }"
    : "{ allowedHosts: adapter.allowedHosts, routes: [{ url: 'https://api.example.com/health', body: { status: 'ok' } }] }";
  const sampleArgs = browser ? '{}' : "{ query: 'test' }";
  const test = `import { ${testContext}, describeAdapterContract } from '@jobwatch/sdk/testkit';
import adapter from './index';

// The contract: startup rules, catalog snapshot in sync (run \`npm run catalog:gen\` after changing a tool), sample outputs.
describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    ${tool}: {
      args: ${sampleArgs},
      run: (args) => {
        const { ctx } = ${testContext}(${contextOptions});
        const [tool] = adapter.tools;
        if (tool === undefined) throw new Error('the adapter has no tools');
        return tool.handler(args, ctx);
      },
    },
  },
});
`;

  return [
    { path: `${dir}/package.json`, content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: `${dir}/tsconfig.json`, content: '{\n  "extends": "../../tsconfig.base.json",\n  "include": ["src", "vitest.config.ts"]\n}\n' },
    {
      path: `${dir}/vitest.config.ts`,
      content:
        "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 10_000, hookTimeout: 10_000 },\n});\n",
    },
    { path: `${dir}/src/index.ts`, content: index },
    { path: `${dir}/src/index.test.ts`, content: test },
  ];
}

/**
 * Add `id` to the installed table of @jobwatch/adapters, between the markers, keeping the lines sorted by id.
 * @param {string} source content of packages/adapters/src/index.ts
 * @param {string} id
 */
export function addInstalledLine(source, id) {
  validateId(id);
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin)
    throw new Error(`packages/adapters/src/index.ts is missing the ${BEGIN} / ${END} markers.`);
  const beginLineEnd = source.indexOf('\n', begin) + 1;
  const endLineStart = source.lastIndexOf('\n', end) + 1;
  const lines = source
    .slice(beginLineEnd, endLineStart)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const keyOf = (/** @type {string} */ line) => /^\s*'?([a-z0-9-]+)'?\s*:/.exec(line)?.[1];
  if (lines.some((line) => keyOf(line) === id)) throw new Error(`Adapter "${id}" is already in the installed table.`);
  const key = id.includes('-') ? `'${id}'` : id;
  lines.push(`  ${key}: () => import('@jobwatch/adapter-${id}').then((m) => m.default),`);
  lines.sort((a, b) => (keyOf(a) ?? '').localeCompare(keyOf(b) ?? ''));
  return `${source.slice(0, beginLineEnd)}${lines.join('\n')}\n${source.slice(endLineStart)}`;
}

/**
 * Add the dependency on the new package to packages/adapters/package.json, keeping keys sorted.
 * @param {string} packageJsonText
 * @param {string} id
 */
export function addAdaptersDependency(packageJsonText, id) {
  validateId(id);
  const json = JSON.parse(packageJsonText);
  const name = `@jobwatch/adapter-${id}`;
  if (json.dependencies?.[name] !== undefined) throw new Error(`${name} is already a dependency of @jobwatch/adapters.`);
  json.dependencies = Object.fromEntries(Object.entries({ ...json.dependencies, [name]: '*' }).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(json, null, 2)}\n`;
}
