// `npm run start`: runs the built server (`npm run build` first) with the variables of ./.env.local, overridden by ./.env, then by the shell.
// Data lives in ./.data unless JW_DATA_DIR says otherwise. The database schema is migrated by the server at boot.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { localEnv } from './lib/localEnv.mjs';

const bundle = 'dist/apps/mcp/main.js';
if (!existsSync(bundle)) {
  console.error(`[start] ${bundle} not found: run \`npm run build\` first`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--enable-source-maps', bundle], { stdio: 'inherit', env: localEnv(['.env.local', '.env']) });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
