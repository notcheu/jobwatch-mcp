// `npm run jobwatch -- <args>`: runs the built CLI (`dist/apps/cli/main.js`) with the same environment as `npm run dev` and `npm run start`
// (./.env.local, then ./.env, then the shell), so DATA_DIR is the folder the local server uses (./.data by default) and the CLI finds its
// control socket. Without this the CLI would look in /data, the container's folder, and report that no router is running.
import { spawn } from 'node:child_process';
import { localEnv } from './lib/localEnv.mjs';

const child = spawn(process.execPath, ['dist/apps/cli/main.js', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: localEnv(['.env.local', '.env']),
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
