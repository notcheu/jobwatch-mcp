// npm run new:adapter -- <id> [--kind http|browser] [--name "Display Name"] [--no-install]
// npm run new:utility -- <id> [--name "Display Name"] [--no-install]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROLES, addBudgetEntry, addInstalledLine, addModulesDependency, moduleFiles, validateId } from './generate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The first argument is the role, given by the npm script: `new:adapter` or `new:utility`.
const role = process.argv[2];
const { positionals, values } = parseArgs({
  args: process.argv.slice(3),
  allowPositionals: true,
  options: { kind: { type: 'string', default: 'http' }, name: { type: 'string' }, 'no-install': { type: 'boolean', default: false } },
});

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (role !== 'adapter' && role !== 'utility')
  fail(`the role must be one of ${ROLES.join(', ')}; use npm run new:adapter or npm run new:utility`);
const id = positionals[0];
if (positionals.length !== 1 || id === undefined)
  fail(`usage: npm run new:${role} -- <id> ${role === 'adapter' ? '[--kind http|browser] ' : ''}[--name "Display Name"]`);
try {
  validateId(id);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const kind = values.kind;
if (kind !== 'http' && kind !== 'browser') fail(`--kind must be http or browser, got "${String(kind)}"`);
if (role === 'utility' && kind !== 'http') fail('a utility is always http: it has no browser');
const dirName = `${role}-${id}`;
if (existsSync(join(root, 'packages', dirName))) fail(`packages/${dirName} already exists`);

const installedPath = join(root, 'packages/mcp-modules/src/index.ts');
const adaptersPackagePath = join(root, 'packages/mcp-modules/package.json');
const budgetsPath = join(root, 'packages/mcp-modules/src/budgets.json');
/** @type {string} */
let installedSource;
/** @type {string} */
let adaptersPackage;
/** @type {string} */
let budgets;
/** @type {import('./generate.mjs').GeneratedFile[]} */
let files;
try {
  installedSource = addInstalledLine(await readFile(installedPath, 'utf8'), id, role);
  adaptersPackage = addModulesDependency(await readFile(adaptersPackagePath, 'utf8'), id, role);
  budgets = addBudgetEntry(await readFile(budgetsPath, 'utf8'), id, kind);
  files = moduleFiles({ id, role, kind, ...(values.name ? { displayName: values.name } : {}) });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Everything was computed without touching the disk; only now write.
for (const file of files) {
  await mkdir(dirname(join(root, file.path)), { recursive: true });
  await writeFile(join(root, file.path), file.content);
}
await writeFile(installedPath, installedSource);
await writeFile(adaptersPackagePath, adaptersPackage);
await writeFile(budgetsPath, budgets);
console.log(
  `created packages/${dirName} (${role}, ${kind}) and registered it in packages/mcp-modules (with a starting budget in budgets.json)`,
);

// Generated sources are formatted like hand-written ones, so `npm run format:check` stays green.
{
  const result = spawnSync('npx', ['prettier', '--write', join('packages', dirName), join('packages', 'mcp-modules')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('prettier failed; run `npx prettier --write packages` by hand');
}

if (!values['no-install']) {
  /** @param {string} label @param {string[]} args @param {Record<string,string>=} env */
  const run = (label, args, env = {}) => {
    console.log(`> ${label}`);
    const result = spawnSync(args[0] ?? '', args.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    if (result.status !== 0) fail(`${label} failed; fix it and run it again by hand`);
  };
  run('npm install --no-audit --no-fund (links the new workspace package)', ['npm', 'install', '--no-audit', '--no-fund']);
  run('write the first catalog snapshot', ['npx', 'vitest', 'run', '--root', join('packages', dirName)], {
    UPDATE_CATALOG: '1',
  });
}
console.log(`
Next steps
  1. Edit packages/${dirName}/src/index.ts: real tools, hosts and limits (docs/plans/03-router-spec.md, "Adapters and utilities")
  2. npm run catalog:gen        (after every change to a tool definition; commit packages/${dirName}/catalog)
  3. npm run ci
  4. Add its pacing and budget to docs/07 or docs/08, then on the host: jobwatch ${role === 'utility' ? 'utilities' : 'adapters'} enable ${id}
`);
