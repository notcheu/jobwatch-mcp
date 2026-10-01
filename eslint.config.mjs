// Flat ESLint config. Besides style, this file ENFORCES the architecture (see 03-router-spec.md, "Repo layout: Nx monorepo"):
//   - Nx module boundaries: which package type may depend on which.
//   - Adapters import only @jobwatch/sdk: no engine, no browser library, no Node network/file/process APIs.
//   - playwright-core is imported in exactly one file.
import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_IO = [
  'fs',
  'fs/promises',
  'net',
  'tls',
  'dgram',
  'dns',
  'http',
  'http2',
  'https',
  'child_process',
  'worker_threads',
  'cluster',
  'vm',
  'module',
  'sqlite',
];
const nodeIoPatterns = NODE_IO.flatMap((m) => [m, `node:${m}`]);

const PLAYWRIGHT = {
  name: 'playwright-core',
  message: 'Only packages/core/src/browser/session.ts may import playwright-core (BrowserSession is the abstraction).',
};
const ENGINE = [
  { name: '@jobwatch/core', message: 'Adapters depend on @jobwatch/sdk only.' },
  { name: '@jobwatch/adapters', message: 'Adapters depend on @jobwatch/sdk only.' },
];

export default [
  { ignores: ['**/dist', '**/node_modules', '**/.nx', '**/coverage', '**/tmp', 'docs/**', 'images/**', 'deploy/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...nx.configs['flat/base'],
  prettier,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { paths: [PLAYWRIGHT] }],
    },
  },
  {
    // Module boundaries between package types (tags are set in each package.json under "nx.tags").
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: [
            { sourceTag: 'type:sdk', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'type:core', onlyDependOnLibsWithTags: ['type:sdk'] },
            { sourceTag: 'type:adapter', onlyDependOnLibsWithTags: ['type:sdk'] },
            { sourceTag: 'type:adapters', onlyDependOnLibsWithTags: ['type:sdk', 'type:adapter'] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:sdk', 'type:core', 'type:adapters'] },
            { sourceTag: 'type:tool', onlyDependOnLibsWithTags: [] },
          ],
        },
      ],
    },
  },
  {
    // Adapters are trusted in-process code, but they only get what AdapterContext hands them.
    files: ['packages/adapter-*/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [PLAYWRIGHT, ...ENGINE],
          patterns: [
            { group: nodeIoPatterns, message: 'Adapters use AdapterContext.http / .session, never Node network, file or process APIs.' },
          ],
        },
      ],
    },
  },
  {
    // Tests may read fixtures from disk, but still never reach the engine or the browser library.
    files: ['packages/adapter-*/**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [PLAYWRIGHT, ...ENGINE] }] },
  },
  {
    // The single file allowed to import playwright-core.
    files: ['packages/core/src/browser/session.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
