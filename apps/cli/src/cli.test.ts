import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_API_VERSION, defineAdapter, defineBrowserTool, defineHttpTool, defineUtility, z, type AdapterModule } from '@jobwatch/sdk';
import type { InstalledAdapters, InstalledUtilities } from '@jobwatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run, type Deps } from './cli';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
const limits = { timeoutS: 10, cost: 1, outputMaxBytes: 2048 } as const;
const input = z.object({}).strict();
const output = z.object({ ok: z.boolean() });

const apec: AdapterModule = defineAdapter({
  id: 'apec',
  displayName: 'APEC',
  description: 'APEC.',
  sdkApi: SDK_API_VERSION,
  platform: 'apec',
  kind: 'http',
  allowedHosts: ['www.apec.fr'],
  tools: [
    defineHttpTool({
      name: 'apec_search',
      title: 'Search (read-only)',
      description: 'Searches. Read-only, no side effects.',
      input,
      output,
      annotations,
      limits,
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
    defineHttpTool({
      name: 'apec_job',
      title: 'Job (read-only)',
      description: 'A job. Read-only, no side effects.',
      input,
      output,
      annotations,
      limits,
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
  ],
});
const linkedin: AdapterModule = defineAdapter({
  id: 'linkedin',
  displayName: 'LinkedIn',
  description: 'LinkedIn.',
  sdkApi: SDK_API_VERSION,
  platform: 'linkedin',
  kind: 'browser',
  allowedHosts: ['www.linkedin.com', 'media.licdn.com'],
  tools: [
    defineBrowserTool({
      name: 'linkedin_search',
      title: 'Search (read-only)',
      description: 'Searches. Read-only, no side effects.',
      input: z.object({ keywords: z.string().min(1), max_jobs: z.number().int().default(50) }).strict(),
      output,
      annotations,
      limits,
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
  ],
});

const geo = defineUtility({
  id: 'linkedin-geo',
  displayName: 'LinkedIn locations',
  description: 'Places.',
  sdkApi: SDK_API_VERSION,
  platform: 'linkedin-geo',
  allowedHosts: ['www.linkedin.com'],
  tools: [
    defineHttpTool({
      name: 'linkedin_locations',
      title: 'Locations (read-only)',
      description: 'Finds places. Read-only, no side effects.',
      input,
      output,
      annotations,
      limits,
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
  ],
});

const table: InstalledAdapters = { linkedin: async () => linkedin, apec: async () => apec };
const utilitiesTable: InstalledUtilities = { 'linkedin-geo': async () => geo };

let dataDir: string;
let out: string;
let err: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jw-cli-'));
  out = '';
  err = '';
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const cli = (argv: string[], over: Partial<Deps> = {}): Promise<number> =>
  run(argv, {
    io: { out: (t) => (out += t), err: (t) => (err += t) },
    env: { JW_DATA_DIR: dataDir },
    adapters: table,
    utilities: utilitiesTable,
    version: '9.9.9',
    ...over,
  });

const enabledFile = async (): Promise<unknown> => JSON.parse(await readFile(join(dataDir, 'adapters.json'), 'utf8'));

describe('help and version', () => {
  it('prints usage and exits 1 when called without arguments', async () => {
    expect(await cli([])).toBe(EXIT.usage);
    expect(out).toContain('jobwatch adapters list');
  });

  it.each([['--help'], ['-h'], ['help']])('%s prints usage and exits 0', async (flag) => {
    expect(await cli([flag])).toBe(EXIT.ok);
    expect(out).toContain('Usage:');
  });

  it('prints the version', async () => {
    expect(await cli(['--version'])).toBe(EXIT.ok);
    expect(out).toBe('9.9.9\n');
  });

  it('rejects unknown commands and subcommands on stderr', async () => {
    expect(await cli(['frobnicate'])).toBe(EXIT.usage);
    expect(err).toContain('Unknown command: frobnicate');
    err = '';
    expect(await cli(['adapters', 'purge'])).toBe(EXIT.usage);
    expect(err).toContain('Unknown adapters command: purge');
    err = '';
    expect(await cli(['adapters'])).toBe(EXIT.usage);
    expect(err).toContain('(none)');
  });
});

describe('adapters list', () => {
  it('shows every installed adapter, sorted, all disabled on a fresh install', async () => {
    expect(await cli(['adapters', 'list'])).toBe(EXIT.ok);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+KIND\s+TOOLS\s+HOSTS$/);
    expect(lines[1]).toMatch(/^apec\s+disabled\s+http\s+apec_search, apec_job\s+www\.apec\.fr$/);
    expect(lines[2]).toMatch(/^linkedin\s+disabled\s+browser\s+linkedin_search\s+www\.linkedin\.com, media\.licdn\.com$/);
    expect(out).toContain(`Enabled list: ${join(dataDir, 'adapters.json')} (not created: nothing enabled yet)`);
  });

  it('marks enabled adapters', async () => {
    await writeFile(join(dataDir, 'adapters.json'), '{"enabled":["linkedin"]}');
    await cli(['adapters', 'list']);
    expect(out).toMatch(/linkedin\s+enabled/);
    expect(out).toMatch(/apec\s+disabled/);
    expect(out).toContain(`Enabled list: ${join(dataDir, 'adapters.json')}\n`);
  });

  it('says when JW_ADAPTERS overrides the file', async () => {
    await cli(['adapters', 'list'], { env: { JW_DATA_DIR: dataDir, JW_ADAPTERS: 'apec' } });
    expect(out).toMatch(/apec\s+enabled/);
    expect(out).toContain('JW_ADAPTERS (environment, overrides the file)');
  });

  it('--tools adds each tool with its parameters, required ones starred, defaults shown', async () => {
    expect(await cli(['adapters', 'list', '--tools', 'linkedin'])).toBe(EXIT.ok);
    expect(out).not.toMatch(/^apec/m);
    expect(out).toContain('linkedin (disabled)');
    expect(out).toMatch(/linkedin_search {2}Search \(read-only\) {2}\(reserves up to 1 unit\(s\)\)/);
    expect(out).toMatch(/keywords\*: string/);
    expect(out).toMatch(/max_jobs: integer = 50/);
  });

  it('--tools --json puts the whole catalog entry (schemas, limits) on each tool', async () => {
    expect(await cli(['adapters', 'list', '--tools', '--json', 'apec'])).toBe(EXIT.ok);
    const json = JSON.parse(out) as { adapters: { id: string; tools: { name: string; inputSchema: object; limits: object }[] }[] };
    expect(json.adapters.map((a) => a.id)).toEqual(['apec']);
    expect(json.adapters[0]?.tools[0]).toMatchObject({ name: 'apec_search', inputSchema: { type: 'object' }, limits: { rate: {} } });
  });

  it('narrows the list to the ids given and refuses an unknown one', async () => {
    expect(await cli(['adapters', 'list', 'apec'])).toBe(EXIT.ok);
    expect(out).toMatch(/^apec/m);
    expect(out).not.toMatch(/^linkedin/m);
    expect(await cli(['adapters', 'list', 'nope'])).toBe(EXIT.usage);
    expect(err).toContain('Unknown adapter: nope');
  });

  it('prints machine-readable JSON with --json and no table', async () => {
    await writeFile(join(dataDir, 'adapters.json'), '{"enabled":["apec"]}');
    expect(await cli(['adapters', 'list', '--json'])).toBe(EXIT.ok);
    const json = JSON.parse(out) as {
      source: string;
      adapters: { id: string; enabled: boolean; kind: string; tools: { name: string }[] }[];
      enabledButNotInstalled: string[];
    };
    expect(json.source).toBe('file');
    expect(json.adapters.map((a) => [a.id, a.enabled, a.kind])).toEqual([
      ['apec', true, 'http'],
      ['linkedin', false, 'browser'],
    ]);
    expect(json.adapters[0]?.tools.map((t) => t.name)).toEqual(['apec_search', 'apec_job']);
    expect(json.enabledButNotInstalled).toEqual([]);
  });

  it('says so when nothing is installed', async () => {
    expect(await cli(['adapters', 'list'], { adapters: {} })).toBe(EXIT.ok);
    expect(out).toContain('No adapters are installed.');
  });

  it('shows a broken adapter instead of hiding it, and exits 2', async () => {
    const broken: InstalledAdapters = { ...table, ghost: async () => Promise.reject(new Error('Cannot find module')) };
    expect(await cli(['adapters', 'list'], { adapters: broken })).toBe(EXIT.broken);
    expect(out).toMatch(/ghost\s+disabled\s+-\s+-\s+BROKEN: Cannot find module/);
    expect(out).toMatch(/apec\s+disabled/);
  });

  it('warns about an enabled id that is no longer installed (the router would refuse to start)', async () => {
    await writeFile(join(dataDir, 'adapters.json'), '{"enabled":["apec","removed"]}');
    await cli(['adapters', 'list']);
    expect(out).toContain('Warning: "removed" is enabled but not installed');
    expect(out).toContain('jobwatch adapters disable removed');
  });

  it('refuses stray arguments and unknown options', async () => {
    expect(await cli(['adapters', 'list', 'extra'])).toBe(EXIT.usage);
    expect(await cli(['adapters', 'list', '--wat'])).toBe(EXIT.usage);
    expect(err).toContain('wat');
  });

  it('reports a corrupt adapters.json as an error, not as "nothing enabled"', async () => {
    await writeFile(join(dataDir, 'adapters.json'), '{oops');
    expect(await cli(['adapters', 'list'])).toBe(EXIT.usage);
    expect(err).toContain('is not valid JSON');
  });

  it('prints no terminal escape codes (safe to pipe and to log)', async () => {
    await cli(['adapters', 'list']);
    expect(out.includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('adapters enable / disable', () => {
  it('tells a running router to reload instead of asking for a restart', async () => {
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const control = await startControlServer(controlSocketPath(dataDir), {
      'adapters.reload': async () => ({
        enabled: ['linkedin'],
        addedAdapters: ['linkedin'],
        removedAdapters: [],
        addedTools: ['linkedin_search'],
        removedTools: [],
      }),
    });
    try {
      expect(await cli(['adapters', 'enable', 'linkedin'])).toBe(EXIT.ok);
    } finally {
      await control.close();
    }
    expect(out).toContain('Applied to the running router (no restart). Tools added: linkedin_search; removed: none.');
    expect(out).toContain('Reconnect the Claude connector');
    expect(out).not.toContain('Restart the router to apply');
  });

  it('says why when the running router refuses, and still asks for a restart', async () => {
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const control = await startControlServer(controlSocketPath(dataDir), {
      'adapters.reload': async () => {
        throw new Error('JW_ADAPTERS sets the list of adapters');
      },
    });
    try {
      await cli(['adapters', 'enable', 'linkedin']);
    } finally {
      await control.close();
    }
    expect(out).toContain('did not apply it: JW_ADAPTERS sets the list of adapters');
    expect(out).toContain('Restart the router to apply');
  });

  it('enables, writes the file, and tells the operator to restart the router', async () => {
    expect(await cli(['adapters', 'enable', 'linkedin'])).toBe(EXIT.ok);
    expect(await enabledFile()).toEqual({ enabled: ['linkedin'], utilities: [] });
    expect(out).toContain('Enabled: linkedin');
    expect(out).toContain('Enabled now: linkedin');
    expect(out).toContain('Restart the router to apply');
  });

  it('enables several at once, de-duplicates, and keeps the file sorted', async () => {
    await cli(['adapters', 'enable', 'linkedin', 'apec', 'apec']);
    expect(await enabledFile()).toEqual({ enabled: ['apec', 'linkedin'], utilities: [] });
  });

  it('is idempotent: enabling twice changes nothing and does not ask for a restart', async () => {
    await cli(['adapters', 'enable', 'apec']);
    out = '';
    expect(await cli(['adapters', 'enable', 'apec'])).toBe(EXIT.ok);
    expect(out).toContain('Already enabled: apec');
    expect(out).not.toContain('Restart the router');
  });

  it('disables, and reports an adapter that was not enabled', async () => {
    await cli(['adapters', 'enable', 'apec', 'linkedin']);
    out = '';
    expect(await cli(['adapters', 'disable', 'linkedin', 'apec'])).toBe(EXIT.ok);
    expect(await enabledFile()).toEqual({ enabled: [], utilities: [] });
    expect(out).toContain('Disabled: linkedin, apec');
    expect(out).toContain('Enabled now: none');
    out = '';
    await cli(['adapters', 'disable', 'apec']);
    expect(out).toContain('Already disabled: apec');
    expect(out).not.toContain('Restart the router');
  });

  it('refuses an id that is not installed, names the installed ones, and writes nothing', async () => {
    expect(await cli(['adapters', 'enable', 'apec', 'wttj'])).toBe(EXIT.usage);
    expect(err).toContain('error: not installed: wttj');
    expect(err).not.toContain('Invalid configuration');
    expect(err).toContain('installed: apec, linkedin');
    await expect(readFile(join(dataDir, 'adapters.json'), 'utf8')).rejects.toThrow();
  });

  it('can always disable a stale entry', async () => {
    await writeFile(join(dataDir, 'adapters.json'), '{"enabled":["apec","removed"]}');
    expect(await cli(['adapters', 'disable', 'removed'])).toBe(EXIT.ok);
    expect(await enabledFile()).toEqual({ enabled: ['apec'], utilities: [] });
  });

  it('refuses to edit while JW_ADAPTERS is set', async () => {
    expect(await cli(['adapters', 'enable', 'apec'], { env: { JW_DATA_DIR: dataDir, JW_ADAPTERS: 'linkedin' } })).toBe(EXIT.usage);
    expect(err).toContain('JW_ADAPTERS is set');
    await expect(readFile(join(dataDir, 'adapters.json'), 'utf8')).rejects.toThrow();
  });

  it('needs at least one id', async () => {
    expect(await cli(['adapters', 'enable'])).toBe(EXIT.usage);
    expect(err).toContain('needs at least one adapter id');
    expect(err).toContain('Installed: apec, linkedin');
  });

  it('rejects path-like ids before touching the disk', async () => {
    expect(await cli(['adapters', 'enable', '../etc/passwd'])).toBe(EXIT.usage);
    await expect(readFile(join(dataDir, 'adapters.json'), 'utf8')).rejects.toThrow();
  });

  it('works without any server configuration (no public base URL needed)', async () => {
    expect(await cli(['adapters', 'enable', 'apec'], { env: { JW_DATA_DIR: dataDir } })).toBe(EXIT.ok);
  });
});

describe('dashboard', () => {
  it('asks the running router to open it and says where, with the sign-in and the closing time', async () => {
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const seen: unknown[] = [];
    const control = await startControlServer(controlSocketPath(dataDir), {
      'dashboard.start': async (request) => (
        seen.push(request),
        {
          running: true,
          url: 'https://jobs.example.com/dashboard/',
          signIn: 'google',
          sessions: 0,
          stopsAt: '2026-10-09T12:30:00.000Z',
          requests: 0,
        }
      ),
    });
    try {
      expect(await cli(['dashboard', 'start', '--ttl', '15'])).toBe(0);
    } finally {
      await control.close();
    }
    expect(seen).toEqual([{ command: 'dashboard.start', ttlMinutes: 15 }]);
    expect(out).toContain('Dashboard is open: https://jobs.example.com/dashboard/');
    expect(out).toContain('Sign-in: Google');
    expect(out).toContain('2026-10-09T12:30:00.000Z');
  });

  it('closes it and reports the status', async () => {
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const control = await startControlServer(controlSocketPath(dataDir), {
      'dashboard.stop': async () => ({ running: false, url: 'x', signIn: 'google', sessions: 0, stopsAt: null, requests: 3 }),
      'dashboard.status': async () => ({ running: false, url: 'x', signIn: 'none', sessions: 0, stopsAt: null, requests: 0 }),
    });
    try {
      expect(await cli(['dashboard', 'stop'])).toBe(0);
      expect(out).toContain('Dashboard is closed.');
      expect(await cli(['dashboard', 'status'])).toBe(0);
    } finally {
      await control.close();
    }
  });

  it("says so when no router is running, and shows the router's own refusal", async () => {
    expect(await cli(['dashboard', 'status'])).toBe(2);
    expect(err).toContain('No router is running');
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const control = await startControlServer(controlSocketPath(dataDir), {
      'dashboard.start': async () => {
        throw new Error('Signing in needs a Google client');
      },
    });
    try {
      err = '';
      expect(await cli(['dashboard', 'start'])).toBe(2);
    } finally {
      await control.close();
    }
    expect(err).toContain('Signing in needs a Google client');
  });

  it('rejects a missing or unknown action and a bad --ttl', async () => {
    expect(await cli(['dashboard'])).toBe(1);
    expect(await cli(['dashboard', 'restart'])).toBe(1);
    expect(err).toContain('Usage:');
    for (const ttl of ['0', '-5', 'abc', '5000']) expect(await cli(['dashboard', 'start', '--ttl', ttl]), ttl).toBe(1);
    expect(await cli(['dashboard', 'stop', '--ttl', '5'])).toBe(1);
  });
});

describe('linkedin-geo', () => {
  it('is also reachable as linked-geo', async () => {
    await withRouter(async (seen) => {
      expect(await cli(['linked-geo', 'Berlin'])).toBe(0);
      expect(seen).toEqual([{ command: 'linkedin-geo.lookup', query: 'Berlin' }]);
    });
  });

  const places = [
    { id: '103035651', label: 'Berlin, Germany' },
    { id: '90009712', label: 'Berlin Metropolitan Area' },
  ];
  const withRouter = async (run: (seen: Record<string, unknown>[]) => Promise<void>) => {
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const seen: Record<string, unknown>[] = [];
    const record = (name: string, answer: Record<string, unknown>) => async (request: Record<string, unknown>) => (
      seen.push({ ...request, command: name }),
      answer
    );
    const control = await startControlServer(controlSocketPath(dataDir), {
      'linkedin-geo.lookup': record('linkedin-geo.lookup', { places, best: places[0] }),
      'linkedin-geo.save': record('linkedin-geo.save', { saved: { alias: 'home' } }),
      'linkedin-geo.forget': record('linkedin-geo.forget', { forgotten: 'home', remembered: [] }),
      'linkedin-geo.list': record('linkedin-geo.list', {
        remembered: [
          { alias: 'home', id: '103035651', label: 'Berlin, Germany', saved_by: 'operator' },
          { alias: 'lisbon', id: '100364837', label: 'Lisbon, Portugal', saved_by: 'auto' },
        ],
      }),
    });
    try {
      await run(seen);
    } finally {
      await control.close();
    }
  };

  it('lists the candidates with their geoIds and says how to remember one', async () => {
    await withRouter(async (seen) => {
      expect(await cli(['linkedin-geo', 'Berlin'])).toBe(0);
      expect(seen).toEqual([{ command: 'linkedin-geo.lookup', query: 'Berlin' }]);
    });
    expect(out).toContain(' 1. 103035651    Berlin, Germany');
    expect(out).toContain(' 2. 90009712     Berlin Metropolitan Area');
    expect(out).toContain('--save <name> --pick <number>');
  });

  it('remembers a name for the chosen candidate, with its label, and takes a text of several words', async () => {
    await withRouter(async (seen) => {
      expect(await cli(['linkedin-geo', 'Berlin', '--save', 'home', '--pick', '2'])).toBe(0);
      expect(seen[1]).toEqual({ command: 'linkedin-geo.save', alias: 'home', id: '90009712', label: 'Berlin Metropolitan Area' });
      expect(await cli(['linkedin-geo', 'Austin,', 'Texas'])).toBe(0);
      expect(seen[2]).toEqual({ command: 'linkedin-geo.lookup', query: 'Austin, Texas' });
    });
    expect(out).toContain('Remembered "home" = 90009712 (Berlin Metropolitan Area).');
  });

  it('takes the first candidate without --pick, and refuses a pick that does not exist', async () => {
    await withRouter(async (seen) => {
      expect(await cli(['linkedin-geo', 'Berlin', '--save', 'home'])).toBe(0);
      expect(seen[1]).toMatchObject({ id: '103035651' });
      expect(await cli(['linkedin-geo', 'Berlin', '--save', 'home', '--pick', '9'])).toBe(1);
      expect(err).toContain('--pick is a number between 1 and 2');
    });
  });

  it('lists and forgets remembered names, marking the ones a search looked up by itself', async () => {
    await withRouter(async (seen) => {
      expect(await cli(['linkedin-geo', '--list'])).toBe(0);
      expect(out).toContain('home');
      expect(out).toMatch(/lisbon\s+100364837\s+Lisbon, Portugal\s+\(looked up by a search\)/);
      expect(await cli(['linkedin-geo', '--forget', 'home'])).toBe(0);
      expect(seen[1]).toEqual({ command: 'linkedin-geo.forget', alias: 'home' });
      expect(out).toContain('Forgot "home".');
    });
  });

  it("says so when no router is running, and shows the router's own refusal", async () => {
    expect(await cli(['linkedin-geo', 'Berlin'])).toBe(2);
    expect(err).toContain('No router is running');
    const { startControlServer, controlSocketPath } = await import('@jobwatch/core');
    const control = await startControlServer(controlSocketPath(dataDir), {
      'linkedin-geo.lookup': async () => {
        throw new Error('The tool linkedin_locations is not available: enable its adapter first (jobwatch adapters enable linkedin-geo).');
      },
    });
    try {
      err = '';
      expect(await cli(['linkedin-geo', 'Berlin'])).toBe(2);
    } finally {
      await control.close();
    }
    expect(err).toContain('jobwatch adapters enable linkedin-geo');
  });

  it('refuses a call that asks for nothing, for two things, or for a pick without a save', async () => {
    for (const args of [
      ['linkedin-geo'],
      ['linkedin-geo', 'Berlin', '--list'],
      ['linkedin-geo', '--list', '--forget', 'x'],
      ['linkedin-geo', 'Berlin', '--pick', '2'],
      ['linkedin-geo', '--save', 'x'],
    ]) {
      err = '';
      expect(await cli(args), args.join(' ')).toBe(1);
      expect(err).toContain('Usage:');
    }
  });
});

describe('utilities are listed and enabled apart from the adapters', () => {
  it('keeps each kind out of the other list', async () => {
    expect(await cli(['adapters', 'list'])).toBe(EXIT.ok);
    expect(out).toContain('apec');
    expect(out).not.toContain('linkedin-geo');
    out = '';
    expect(await cli(['utilities', 'list'])).toBe(EXIT.ok);
    expect(out).toContain('linkedin-geo');
    expect(out).not.toContain('apec');
  });

  it('writes a utility to its own list and refuses the wrong command, naming the right one', async () => {
    expect(await cli(['utilities', 'enable', 'linkedin-geo'])).toBe(EXIT.ok);
    expect(await enabledFile()).toEqual({ enabled: [], utilities: ['linkedin-geo'] });
    expect(await cli(['adapters', 'enable', 'linkedin-geo'])).toBe(EXIT.usage);
    expect(err).toContain('linkedin-geo is a utility: use `jobwatch utilities`');
    expect(await cli(['utilities', 'enable', 'apec'])).toBe(EXIT.usage);
    expect(err).toContain('apec is an adapter');
    expect(await enabledFile()).toEqual({ enabled: [], utilities: ['linkedin-geo'] });
    expect(await cli(['utilities', 'disable', 'linkedin-geo'])).toBe(EXIT.ok);
    expect(await enabledFile()).toEqual({ enabled: [], utilities: [] });
  });
});
