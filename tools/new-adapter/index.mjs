// npm run new:adapter -- <id> [--kind http|browser] [--name "Display Name"] [--no-install]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { addAdaptersDependency, addInstalledLine, adapterFiles, validateId } from './generate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { positionals, values } = parseArgs({
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

const id = positionals[0];
if (positionals.length !== 1 || id === undefined) fail('usage: npm run new:adapter -- <id> [--kind http|browser] [--name "Display Name"]');
try {
  validateId(id);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const kind = values.kind;
if (kind !== 'http' && kind !== 'browser') fail(`--kind must be http or browser, got "${String(kind)}"`);
if (existsSync(join(root, 'packages', `adapter-${id}`))) fail(`packages/adapter-${id} already exists`);

const installedPath = join(root, 'packages/adapters/src/index.ts');
const adaptersPackagePath = join(root, 'packages/adapters/package.json');
/** @type {string} */
let installedSource;
/** @type {string} */
let adaptersPackage;
/** @type {import('./generate.mjs').GeneratedFile[]} */
let files;
try {
  installedSource = addInstalledLine(await readFile(installedPath, 'utf8'), id);
  adaptersPackage = addAdaptersDependency(await readFile(adaptersPackagePath, 'utf8'), id);
  files = adapterFiles({ id, kind, ...(values.name ? { displayName: values.name } : {}) });
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
console.log(`created packages/adapter-${id} (${kind}) and registered it in packages/adapters`);

// Generated sources are formatted like hand-written ones, so `npm run format:check` stays green.
{
  const result = spawnSync('npx', ['prettier', '--write', join('packages', `adapter-${id}`), join('packages', 'adapters')], {
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
  run('write the first catalog snapshot', ['npx', 'vitest', 'run', '--root', join('packages', `adapter-${id}`)], {
    JW_UPDATE_CATALOG: '1',
  });
}
console.log(`
Next steps
  1. Edit packages/adapter-${id}/src/index.ts: real tools, hosts and limits (docs/plans/03-router-spec.md, "Adapter SDK")
  2. npm run catalog:gen        (after every change to a tool definition; commit packages/adapter-${id}/catalog)
  3. npm run ci
  4. Add its pacing and budget to docs/07 or docs/08, then on the host: jobwatch adapters enable ${id}
`);
