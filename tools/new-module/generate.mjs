// Pure functions that build a new adapter or utility package. No file system access here: index.mjs applies the result.

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
/** The two kinds of module the scaffolder creates; each has its own installed map between its own markers. */
export const ROLES = ['adapter', 'utility'];
const markers = (/** @type {string} */ role) => {
  const map = role === 'utility' ? 'utilities' : 'adapters';
  return { begin: `// <${map}:begin>`, end: `// <${map}:end>` };
};

/** @param {string} id */
export function validateId(id) {
  if (!ID_PATTERN.test(id))
    throw new Error(`Invalid id "${id}": use 2-32 characters, lowercase letters, digits and hyphens, starting with a letter.`);
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
 * @typedef {{ id: string, role?: 'adapter' | 'utility', kind?: 'http' | 'browser', displayName?: string }} ModuleSpec
 * @typedef {{ path: string, content: string }} GeneratedFile
 */

/**
 * Files of the new package, relative to the repository root.
 * @param {ModuleSpec} spec
 * @returns {GeneratedFile[]}
 */
export function moduleFiles(spec) {
  const { id } = spec;
  const role = spec.role ?? 'adapter';
  const kind = spec.kind ?? 'http';
  validateId(id);
  if (!ROLES.includes(role)) throw new Error(`Invalid role "${String(role)}": use adapter or utility.`);
  if (kind !== 'http' && kind !== 'browser') throw new Error(`Invalid kind "${String(kind)}": use http or browser.`);
  if (role === 'utility' && kind !== 'http') throw new Error('A utility is always http: it has no browser.');
  const dir = `packages/${role}-${id}`;
  const name = spec.displayName ?? title(id);
  const tool = `${snake(id)}_example`;
  const browser = kind === 'browser';

  const packageJson = {
    name: `@jobwatch/${role}-${id}`,
    version: '0.0.0',
    private: true,
    description: `${name} ${role} (read-only).`,
    type: 'module',
    exports: { '.': './src/index.ts' },
    dependencies: { '@jobwatch/sdk': '*' },
    scripts: { lint: 'eslint .', typecheck: 'tsc -p tsconfig.json', test: 'vitest run' },
    nx: { tags: [`type:${role}`] },
  };

  const adapterIndex = browser
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

  // A utility is the http template declared with `defineUtility` (which fixes the kind) and described as a helper.
  const index =
    role === 'utility'
      ? adapterIndex
          .replace('defineAdapter, defineHttpTool', 'defineHttpTool, defineUtility')
          .replace('export default defineAdapter({', 'export default defineUtility({')
          .replace("  kind: 'http',\n", '')
          .replaceAll(`${name} adapter`, `${name} utility`)
          .replace('"Adapter SDK"', '"Adapters and utilities"')
      : adapterIndex;

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
 * Add `id` to the installed map of its role in @jobwatch/mcp-modules (adapters or utilities), between that map's markers,
 * keeping the lines sorted by id.
 * @param {string} source content of packages/mcp-modules/src/index.ts
 * @param {string} id
 * @param {'adapter' | 'utility'} [role]
 */
export function addInstalledLine(source, id, role = 'adapter') {
  validateId(id);
  const { begin: BEGIN, end: END } = markers(role);
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin)
    throw new Error(`packages/mcp-modules/src/index.ts is missing the ${BEGIN} / ${END} markers.`);
  const beginLineEnd = source.indexOf('\n', begin) + 1;
  const endLineStart = source.lastIndexOf('\n', end) + 1;
  const lines = source
    .slice(beginLineEnd, endLineStart)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const keyOf = (/** @type {string} */ line) => /^\s*'?([a-z0-9-]+)'?\s*:/.exec(line)?.[1];
  if (lines.some((line) => keyOf(line) === id))
    throw new Error(`${role === 'adapter' ? 'Adapter' : 'Utility'} "${id}" is already in the installed table.`);
  const key = id.includes('-') ? `'${id}'` : id;
  lines.push(`  ${key}: () => import('@jobwatch/${role}-${id}').then((m) => m.default),`);
  lines.sort((a, b) => (keyOf(a) ?? '').localeCompare(keyOf(b) ?? ''));
  return `${source.slice(0, beginLineEnd)}${lines.join('\n')}\n${source.slice(endLineStart)}`;
}

/** The budget a new module starts with (the engine default of its kind, `DEFAULT_RATE` in @jobwatch/core): edit it in budgets.json. */
const STARTING_BUDGET = { browser: { hourly: 120, daily: 300 }, http: { hourly: 600, daily: 3000 } };

/**
 * Add an entry for the new module to packages/mcp-modules/src/budgets.json (its default hourly and daily budget), keeping keys sorted.
 * @param {string} budgetsText content of that file
 * @param {string} id
 * @param {'http' | 'browser'} kind
 */
export function addBudgetEntry(budgetsText, id, kind) {
  validateId(id);
  const json = JSON.parse(budgetsText);
  if (json[id] !== undefined) throw new Error(`"${id}" already has a budget in packages/mcp-modules/src/budgets.json.`);
  const entries = Object.entries({ ...json, [id]: STARTING_BUDGET[kind] }).sort(([a], [b]) => a.localeCompare(b));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/**
 * Add the dependency on the new package to packages/mcp-modules/package.json, keeping keys sorted.
 * @param {string} packageJsonText
 * @param {string} id
 * @param {'adapter' | 'utility'} [role]
 */
export function addModulesDependency(packageJsonText, id, role = 'adapter') {
  validateId(id);
  const json = JSON.parse(packageJsonText);
  const name = `@jobwatch/${role}-${id}`;
  if (json.dependencies?.[name] !== undefined) throw new Error(`${name} is already a dependency of @jobwatch/mcp-modules.`);
  json.dependencies = Object.fromEntries(Object.entries({ ...json.dependencies, [name]: '*' }).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(json, null, 2)}\n`;
}
