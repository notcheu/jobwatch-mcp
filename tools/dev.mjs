// `npm run dev`: bundles apps/mcp with esbuild in watch mode and (re)starts it on every rebuild, with the variables of ./.env.local (the shell wins).
// Data lives in ./.data unless DATA_DIR says otherwise. The database schema is migrated by the server at every boot.
// No Docker and no OAuth front: see .env.local. Same bundle options as the `build` script of apps/mcp.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { context } from 'esbuild';
import { localEnv } from './lib/localEnv.mjs';

const ENV_FILE = '.env.local';
const outfile = 'dist/apps/mcp/dev.js';
let child;

function restart() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
  }
  child = spawn(process.execPath, ['--enable-source-maps', outfile], { stdio: 'inherit', env: localEnv([ENV_FILE]) });
  child.on('exit', (code) => console.error(`[dev] server exited (${code}); waiting for the next change`));
}

const ctx = await context({
  entryPoints: ['apps/mcp/src/main.ts'],
  bundle: true,
  external: ['playwright-core'],
  platform: 'node',
  format: 'esm',
  target: 'node26',
  sourcemap: true,
  outfile,
  logLevel: 'warning',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  plugins: [{ name: 'restart', setup: (build) => build.onEnd((result) => result.errors.length === 0 && restart()) }],
});

if (!existsSync(ENV_FILE)) console.error('[dev] no .env.local found: the server starts with its defaults');
await ctx.watch();
const stop = () => {
  child?.kill('SIGTERM');
  ctx.dispose().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
