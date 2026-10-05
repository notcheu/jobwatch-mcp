#!/usr/bin/env node
// Smoke test of the BUILT router and dashboard (docs/plans/17-dashboard.md, section 9). Run by hand after `npm run build`; it is not in
// CI. It starts dist/apps/mcp/main.js on free ports with AUTH=none, makes MCP calls, opens the dashboard with the real CLI, checks
// the pages, the API, the security headers and the Host/Origin/CSRF refusals, then closes everything.
//   npm run build && node tests/dashboard/smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
};
const send = (port, path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

const dir = await mkdtemp(join(tmpdir(), 'jw-smoke-'));
await writeFile(join(dir, 'adapters.json'), '{"enabled":["teamtailor"]}');
const mcpPort = await freePort();
const dashPort = await freePort();
const env = {
  ...process.env,
  BASE_URL: `http://127.0.0.1:${mcpPort}`,
  AUTH: 'none',
  LISTEN_HOST: '127.0.0.1',
  PORT: String(mcpPort),
  DATA_DIR: dir,
  DASHBOARD_PORT: String(dashPort),
  DASHBOARD_STATIC_DIR: join(root, 'dist/apps/dashboard'),
  DASHBOARD_URL: `http://127.0.0.1:${dashPort}/dashboard/`,
};
const router = spawn('node', [join(root, 'dist/apps/mcp/main.js')], { env, stdio: 'ignore' });
const cli = (...args) => spawnSync('node', [join(root, 'dist/apps/cli/main.js'), ...args], { env, encoding: 'utf8' });
const mcp = async (id, name, args) => {
  const res = await send(mcpPort, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.status;
};

try {
  for (let i = 0; i < 50; i++) {
    const up = await send(mcpPort, '/healthz').then(
      (r) => r.status === 200,
      () => false,
    );
    if (up) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check('the router answers /healthz', (await send(mcpPort, '/healthz')).status === 200);
  check(
    'the dashboard is closed at startup',
    await send(dashPort, '/dashboard/api/v1/me').then(
      () => false,
      () => true,
    ),
  );

  const started = cli('dashboard', 'start');
  check('jobwatch dashboard start opens it', started.status === 0 && started.stdout.includes('Dashboard is open'), started.stderr);
  check('jobwatch dashboard status says it is open', cli('dashboard', 'status').stdout.includes('Dashboard is open'));

  check('an MCP call works', (await mcp(1, 'stored_jobs', { terms: ['react'] })) === 200);
  check(
    'an MCP call with a long keyword works',
    (await mcp(2, 'teamtailor_jobs', { boards: ['not a board'], title_any: ['smoke-keyword'] })) === 200,
  );

  const page = await send(dashPort, '/dashboard/runs');
  check('the interface is served at /dashboard/runs', page.status === 200 && page.text.includes('<div id="root">'));
  const asset = /src="(\/dashboard\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
  check('its script is served', asset !== undefined && (await send(dashPort, asset)).status === 200);
  check(
    'the security headers are on the page',
    /default-src 'self'/.test(page.headers['content-security-policy'] ?? '') &&
      page.headers['x-content-type-options'] === 'nosniff' &&
      page.headers['referrer-policy'] === 'no-referrer' &&
      page.headers['cache-control'] === 'no-store',
  );

  for (const endpoint of ['me', 'overview', 'calls', 'jobs', 'searches', 'tools', 'usage', 'usage?scope=lifetime', 'settings']) {
    const res = await send(dashPort, `/dashboard/api/v1/${endpoint}`);
    check(`GET /api/v1/${endpoint} answers 200 with JSON`, res.status === 200 && /json/.test(res.headers['content-type'] ?? ''));
  }
  const calls = JSON.parse((await send(dashPort, '/dashboard/api/v1/calls')).text);
  check(
    'the call made above is in the history',
    calls.calls.some((c) => c.tool === 'teamtailor_jobs' && c.keywords === 'smoke-keyword'),
  );
  check('the list carries no parameters', !JSON.stringify(calls).includes('"params"'));
  const detail = JSON.parse(
    (await send(dashPort, `/dashboard/api/v1/calls/${calls.calls.find((c) => c.tool === 'teamtailor_jobs').id}`)).text,
  );
  check('the detail carries them', detail.params?.title_any?.[0] === 'smoke-keyword');

  check(
    'a wrong Host is refused (421)',
    (await send(dashPort, '/dashboard/api/v1/me', { headers: { host: 'evil.example.com' } })).status === 421,
  );
  check(
    'a change without the CSRF header is refused (403)',
    (
      await send(dashPort, '/dashboard/api/v1/adapters/lever', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"enabled":true}',
      })
    ).status === 403,
  );
  check(
    'a change from another origin is refused (403)',
    (
      await send(dashPort, '/dashboard/api/v1/adapters/lever', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-jw-csrf': '1', origin: 'http://evil.example' },
        body: '{"enabled":true}',
      })
    ).status === 403,
  );
  check('an unknown API path is a JSON 404', JSON.parse((await send(dashPort, '/dashboard/api/v1/nothing')).text).error === 'not_found');

  const stopped = cli('dashboard', 'stop');
  check('jobwatch dashboard stop closes it', stopped.status === 0 && stopped.stdout.includes('closed'));
  check(
    'nothing listens on the dashboard port any more',
    await send(dashPort, '/dashboard/api/v1/me').then(
      () => false,
      () => true,
    ),
  );
  check('the MCP endpoint is unaffected', (await send(mcpPort, '/healthz')).status === 200);
} finally {
  router.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks FAILED.`);
process.exit(failed === 0 ? 0 : 1);
