import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_API_VERSION, defineAdapter, defineBrowserTool, z } from '@jobwatch/sdk';
import type { CliResult, DockerRunner, InstalledAdapters } from '@jobwatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type Deps } from './cli';

const linkedin = defineAdapter({
  id: 'linkedin',
  displayName: 'LinkedIn',
  description: 'LinkedIn.',
  sdkApi: SDK_API_VERSION,
  platform: 'linkedin',
  kind: 'browser',
  allowedHosts: ['www.linkedin.com'],
  tools: [
    defineBrowserTool({
      name: 'linkedin_search',
      title: 'Search (read-only)',
      description: 'Searches. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      limits: { timeoutS: 10, cost: 1, outputMaxBytes: 2048 },
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
  ],
});
const table: InstalledAdapters = { linkedin: async () => linkedin };

let dataDir: string;
let out: string;
let err: string;
let calls: string[][];
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jw-cli2-'));
  out = '';
  err = '';
  calls = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const ok: CliResult = { code: 0, stdout: '', stderr: '' };
/** A docker that answers from a table keyed by the first two words; everything else succeeds. */
const fakeDocker =
  (answers: Record<string, Partial<CliResult>> = {}): DockerRunner =>
  async (args) => {
    calls.push([...args]);
    return { ...ok, ...answers[args.slice(0, 2).join(' ')], ...answers[args[0] ?? ''] };
  };

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  JW_DATA_DIR: dataDir,
  JW_BASE_URL: 'https://mcp.example.test',
  JW_FRONT_SHARED_SECRET: 'x'.repeat(32),
  ...extra,
});

const cli = (argv: string[], over: Partial<Deps> = {}): Promise<number> =>
  run(argv, {
    io: { out: (t) => (out += t), err: (t) => (err += t) },
    env: env(),
    installed: table,
    version: '1.0.0',
    docker: fakeDocker(),
    randomPassword: () => 'pw123456',
    ...over,
  });

describe('login', () => {
  it('starts the login browser on loopback, with a password and the start page, and prints the tunnel', async () => {
    expect(await cli(['login', 'start', 'linkedin'])).toBe(0);
    const start = calls.find((args) => args[0] === 'run');
    expect(start).toBeDefined();
    expect(start).toContain('127.0.0.1:6080:6080');
    expect(start).toContain('MODE=login');
    expect(start).toContain('VNC_PASSWORD=pw123456');
    expect(start).toContain('START_URL=https://www.linkedin.com/');
    expect(start).toContain('jw-profile-linkedin:/profile');
    expect(start?.[start.indexOf('--network') + 1]).toBe('bridge');
    expect(out).toContain('ssh -L 6080:localhost:6080');
    expect(out).toContain('pw123456');
    expect(out).toContain('jobwatch login stop linkedin');
  });

  it('refuses while the router browser runs on the same profile', async () => {
    const docker = fakeDocker({ 'inspect -f': { stdout: 'true\n' } });
    expect(await cli(['login', 'start', 'linkedin'], { docker })).toBe(2);
    expect(err).toContain('running on the profile');
    expect(calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('rejects unknown platforms, extra arguments and bad ports', async () => {
    expect(await cli(['login', 'start', 'nope'])).toBe(1);
    expect(err).toContain('Browser platforms: linkedin');
    expect(await cli(['login'])).toBe(1);
    expect(await cli(['login', 'linkedin'])).toBe(1); // the old form: no start or stop
    expect(await cli(['login', 'start'])).toBe(1);
    expect(await cli(['login', 'start', 'linkedin', '--port', '80'])).toBe(1);
    expect(calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('reports a docker failure without echoing the password', async () => {
    const docker = fakeDocker({ run: { code: 125, stderr: 'port is already allocated' } });
    expect(await cli(['login', 'start', 'linkedin'], { docker })).toBe(2);
    expect(err).toContain('port is already allocated');
    expect(err).not.toContain('pw123456');
  });

  it('stop stops and removes the login browser', async () => {
    expect(await cli(['login', 'stop', 'linkedin'])).toBe(0);
    expect(calls.map((args) => args.slice(0, 1).concat(args.at(-1) ?? ''))).toEqual([
      ['stop', 'jw-login-linkedin'],
      ['rm', 'jw-login-linkedin'],
    ]);
    expect(out).toContain('session_status');
  });
});

describe('doctor', () => {
  it('passes on a healthy installation', async () => {
    await writeFile(join(dataDir, 'adapters.json'), JSON.stringify({ enabled: ['linkedin'] }));
    expect(await cli(['doctor'])).toBe(0);
    expect(out).toContain('No problem found.');
    expect(calls.map((args) => args[0])).toEqual(expect.arrayContaining(['version', 'image', 'network', 'volume']));
  });

  it('fails when the image or the daemon is missing, and warns when a profile does not exist yet', async () => {
    await writeFile(join(dataDir, 'adapters.json'), JSON.stringify({ enabled: ['linkedin'] }));
    expect(await cli(['doctor'], { docker: fakeDocker({ 'image inspect': { code: 1 }, 'volume inspect': { code: 1 } }) })).toBe(2);
    expect(out).toMatch(/FAIL\s+browser image/);
    expect(out).toMatch(/warn\s+profile linkedin/);
    out = '';
    expect(await cli(['doctor'], { docker: fakeDocker({ version: { code: 1, stderr: 'cannot connect' } }) })).toBe(2);
    expect(out).toContain('the daemon is unreachable');
  });

  it('does not need Docker when no browser adapter is enabled', async () => {
    expect(await cli(['doctor'])).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain('Docker is not needed');
  });

  it('reports invalid configuration', async () => {
    expect(await cli(['doctor'], { env: env({ JW_BASE_URL: 'not a url' }) })).toBe(2);
    expect(out).toMatch(/FAIL\s+configuration/);
  });
});
