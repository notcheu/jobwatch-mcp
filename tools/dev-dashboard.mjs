// `npm run dev:dashboard`: the dashboard interface with hot reload (Vite) on top of the router that `npm run dev` runs.
// It opens the router's dashboard listener (what `jobwatch dashboard start` does, through the control socket), points the Vite proxy at it,
// and closes the listener again when you stop it. Start `npm run dev` first, in another terminal. Variables: ./.env.local, then the shell.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localEnv } from './lib/localEnv.mjs';

const env = localEnv(['.env.local']);
// as the router and the CLI build it (controlSocketPath), relative to this folder when DATA_DIR is
const socket = join(env.DATA_DIR, 'control.sock');
const target = `http://127.0.0.1:${env.DASHBOARD_PORT || 8090}`;
const VITE_URL = 'http://localhost:5173/dashboard/';

/** One command to the running router (a JSON line on its control socket). Resolves `undefined` when nothing listens. */
function control(request) {
  return new Promise((done, fail) => {
    const connection = createConnection(socket);
    let text = '';
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk) => (text += chunk));
    connection.on('error', (error) => (['ENOENT', 'ECONNREFUSED'].includes(error.code) ? done(undefined) : fail(error)));
    connection.on('close', () => {
      try {
        done(JSON.parse(text.trim()));
      } catch {
        fail(new Error('the router sent an unreadable answer'));
      }
    });
  });
}

const opened = await control({ command: 'dashboard.start', ttlMinutes: 1440 }).catch((error) => {
  console.error(`[dev:dashboard] cannot reach the router on ${socket}: ${error.message}`);
  process.exit(1);
});
if (opened === undefined) {
  console.error(`[dev:dashboard] no router answers on ${socket}.\nStart it first, in another terminal: npm run dev`);
  process.exit(1);
}
if (!opened.ok) {
  console.error(`[dev:dashboard] the router refused to open the dashboard: ${opened.error}`);
  process.exit(1);
}
console.error(`[dev:dashboard] the router's dashboard API is on ${target} (proxied by Vite)\n[dev:dashboard] open ${VITE_URL}`);

const vite = spawn('npm', ['run', 'dev', '-w', '@jobwatch/dashboard'], {
  stdio: 'inherit',
  cwd: fileURLToPath(new URL('..', import.meta.url)), // the repo root: the workspace is found from there
  env: { ...process.env, DASHBOARD_PROXY_TARGET: target },
});

let closing = false;
const stop = async (code) => {
  if (closing) return;
  closing = true;
  vite.kill('SIGTERM');
  await control({ command: 'dashboard.stop' }).catch(() => undefined); // leave the router as it was found
  process.exit(code);
};
vite.on('exit', (code) => void stop(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0));
