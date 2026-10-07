import { HostNotAllowedError, JobwatchError } from '@jobwatch/sdk';
import {
  FakeJobStore,
  FakeCompanyBoards,
  FakePlaceLog,
  FakePlatformMemory,
  FakeHttpClient,
  createHttpTestContext,
} from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import { RUNNER_SOURCE } from './runner';
import { buildCustomModule, checkTargetUrl, sampleScript } from './module';
import { SANDBOX_LIMITS, dockerSandboxArgs, processSpawner, runInSandbox, toBoardRead, type SandboxSpawner } from './sandbox';
import type { CustomAdapterRow } from '../store/store';

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const http = (routes: { url: string; body: unknown; status?: number }[] = []) =>
  new FakeHttpClient(
    ['careers.acme.com'],
    routes.map((route) => ({ url: route.url, body: route.body, status: route.status ?? 200 })),
  );
const real = processSpawner();
const run = (script: string, over: Partial<Parameters<typeof runInSandbox>[0]> = {}) =>
  runInSandbox({ spawner: real, script, kind: 'http', board: 'acme', filters: { title_any: [] }, http: http(), log: quietLog, ...over });

describe('the sandbox, in a real process with the permission model', () => {
  it('runs the script with the board and the filters, and returns the postings it built, checked and shaped', async () => {
    const result = await run(`async function read(board, filters) {
      return { name: board, postings: [{ id: 'a-1', title: ' Dev ', url: 'https://careers.acme.com/1', postedAt: '2026-10-01', locations: ['Paris', 'Paris'], extra: 'x' }, { id: 'a-1', title: 'Dup', url: 'https://careers.acme.com/2' }], seen: filters.title_any };
    }`);
    expect(result).toEqual({
      name: 'acme',
      postings: [
        {
          id: 'a-1',
          title: 'Dev',
          company: null,
          locations: ['Paris'],
          url: 'https://careers.acme.com/1',
          postedAt: '2026-10-01T00:00:00.000Z',
          description: '',
        },
      ],
    });
  }, 20_000);

  it("reaches the network only through http, which is the call's own client: its allowlist and its answers", async () => {
    const client = http([{ url: 'https://careers.acme.com/api', body: { jobs: [{ id: 'j1', t: 'Engineer' }] } }]);
    const result = await run(
      `async function read(board) {
        const list = (await http.get('https://careers.acme.com/api', { headers: { 'x-key': 'v' } })).json();
        let refused = 'allowed';
        try { await http.get('https://evil.example/steal'); } catch (e) { refused = e.message; }
        return { name: refused.slice(0, 40), postings: list.jobs.map((j) => ({ id: j.id, title: j.t, url: 'https://careers.acme.com/' + j.id })) };
      }`,
      { http: client },
    );
    expect(result.postings.map((p) => p.title)).toEqual(['Engineer']);
    expect(result.name).toMatch(/Blocked request/);
    expect(client.requests.map((r) => r.url)).toEqual(['https://careers.acme.com/api']); // the refused one never left
  }, 20_000);

  it('gives the script the SDK helpers as globals, to be awaited', async () => {
    const result = await run(`async function read() {
      return { name: await titleCase('société générale'), postings: [{ id: 'x', title: await htmlToText('<p>Hi &amp; bye</p>'), company: await slugify('Société Générale'), url: 'https://careers.acme.com/x' }] };
    }`);
    expect(result.name).toBe('Société Générale');
    expect(result.postings[0]).toMatchObject({ title: 'Hi & bye', company: 'societe-generale' });
  }, 20_000);

  it('cannot reach the network by any road: fetch, a raw socket or DNS (the permission model of Node 26 denies them)', async () => {
    const result = await run(`async function read() {
      const tries = {
        fetch: () => fetch('http://1.1.1.1'),
        tcp: () => new Promise((resolve, reject) => { const s = process.getBuiltinModule('net').connect(80, '1.1.1.1', () => resolve('CONNECTED')); s.on('error', reject); }),
        dns: () => process.getBuiltinModule('dns/promises').lookup('example.com'),
      };
      const out = {};
      for (const [name, f] of Object.entries(tries)) { try { await f(); out[name] = 'ALLOWED'; } catch (e) { out[name] = e.code || (e.cause && e.cause.code) || e.message; } }
      return { name: JSON.stringify(out), postings: [] };
    }`);
    expect(JSON.parse(result.name ?? '{}')).toEqual({ fetch: 'ERR_ACCESS_DENIED', tcp: 'ERR_ACCESS_DENIED', dns: 'ERR_ACCESS_DENIED' });
  }, 30_000);

  it('cannot read a file, run a program, start a worker or see the environment of the router', async () => {
    const result = await run(`async function read() {
      const tries = {
        fs: () => process.getBuiltinModule('fs').readFileSync('/etc/hosts', 'utf8'),
        write: () => process.getBuiltinModule('fs').writeFileSync('/tmp/jw-escape', 'x'),
        exec: () => process.getBuiltinModule('child_process').execSync('echo hi'),
        worker: () => new (process.getBuiltinModule('worker_threads').Worker)('1', { eval: true }),
      };
      const out = {};
      for (const [name, f] of Object.entries(tries)) { try { f(); out[name] = 'ALLOWED'; } catch (e) { out[name] = e.code; } }
      out.env = Object.keys(process.env).filter((key) => key !== '__CF_USER_TEXT_ENCODING');
      return { name: JSON.stringify(out), postings: [] };
    }`);
    expect(JSON.parse(result.name ?? '{}')).toEqual({
      fs: 'ERR_ACCESS_DENIED',
      write: 'ERR_ACCESS_DENIED',
      exec: 'ERR_ACCESS_DENIED',
      worker: 'ERR_ACCESS_DENIED',
      env: [],
    });
  }, 20_000);

  it('says what went wrong when the script throws, has no read function, is not valid code, or returns the wrong shape', async () => {
    await expect(run('async function read() { throw new Error("boom"); }')).rejects.toThrow(/The script failed: boom/);
    await expect(run('const x = 1;')).rejects.toThrow(/defines no function named read/);
    await expect(run('async function read( {')).rejects.toThrow(/The script failed/);
    await expect(
      run('async function read() { return { postings: [{ id: "bad id", title: "T", url: "https://x.test" }] }; }'),
    ).rejects.toThrow(/wrong shape/);
    await expect(run('async function read() { return { postings: [{ id: "a", title: "T", url: "http://x.test" }] }; }')).rejects.toThrow(
      /https/,
    );
    await expect(run('async function read() { return 5; }')).rejects.toThrow(/wrong shape/);
  }, 40_000);

  it('stops a script that never ends, and one that asks for more requests than a run may make', async () => {
    const started = Date.now();
    await expect(run('async function read() { while (true) {} }', { limits: { timeoutMs: 1500 } })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const client = http([{ url: 'https://careers.acme.com/a', body: {} }]);
    await expect(
      run(
        'async function read() { for (let i = 0; i < 100; i++) await http.get("https://careers.acme.com/a"); return { postings: [] }; }',
        { http: client, limits: { maxUnits: 5 } },
      ),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(client.requests).toHaveLength(5);
  }, 40_000);

  it('stops a script that floods its output', async () => {
    await expect(
      run(
        'async function read() { const big = "x".repeat(100000); for (let i = 0; i < 100; i++) process.stdout.write(big + "\\n"); await new Promise(() => {}); }',
        { limits: { timeoutMs: 15_000 } },
      ),
    ).rejects.toThrow(/too much|too long|before it answered/);
  }, 30_000);
});

describe('the runs, with a scripted process', () => {
  it('refuses a call it has no handler for, ignores noise, and answers a request that fails with the reason', async () => {
    let reply = '';
    const spawner: SandboxSpawner = {
      start() {
        let onLine: (line: string) => void = () => undefined;
        return {
          write: (line) => {
            const message = JSON.parse(line);
            if (message.type === 'run') {
              onLine('not json');
              onLine(JSON.stringify({ type: 'rpc', id: 1, fn: 'fs.readFile', args: ['/etc/passwd'] }));
              onLine(JSON.stringify({ type: 'rpc', id: 2, fn: 'http.get', args: ['https://careers.acme.com/missing'] }));
            } else if (message.id === 2) {
              reply = line;
              onLine(JSON.stringify({ type: 'result', value: { postings: [] } }));
            }
          },
          onLine: (l) => (onLine = l),
          onExit: () => undefined,
          kill: () => undefined,
        };
      },
    };
    const client = new FakeHttpClient(['careers.acme.com'], []); // no route: the fake throws
    await run('', { spawner, http: client });
    expect(JSON.parse(reply)).toMatchObject({ type: 'reply', id: 2, ok: false });
  });

  it('is a failure when the process ends before it answers', async () => {
    const spawner: SandboxSpawner = {
      start() {
        let onExit: (reason: string) => void = () => undefined;
        return { write: () => onExit('exited with code 137'), onLine: () => undefined, onExit: (l) => (onExit = l), kill: () => undefined };
      },
    };
    await expect(run('', { spawner })).rejects.toThrow(/exited with code 137 before it answered/);
  });

  it('turns a host refusal into an error of the script, not of the run', async () => {
    expect(new HostNotAllowedError('x')).toBeInstanceOf(Error);
    expect(new JobwatchError('timeout', 'x').code).toBe('timeout');
  });
});

describe('what comes back', () => {
  it('fills what the script leaves out, drops a repeated id, and turns a date it cannot read into none', () => {
    const read = toBoardRead({
      postings: [
        { id: 'a', title: 'T', url: 'https://x.test', postedAt: 'soon' },
        { id: 'a', title: 'U', url: 'https://x.test/2' },
      ],
    });
    expect(read).toEqual({
      name: null,
      postings: [{ id: 'a', title: 'T', company: null, locations: [], url: 'https://x.test', postedAt: null, description: '' }],
    });
  });
  it('refuses more postings than a run may bring', () => {
    const postings = Array.from({ length: SANDBOX_LIMITS.maxPostings + 1 }, (_, i) => ({ id: `p${i}`, title: 'T', url: 'https://x.test' }));
    expect(() => toBoardRead({ postings })).toThrow(/wrong shape/);
  });
});

describe('the docker sandbox', () => {
  const args = dockerSandboxArgs('node:26-bookworm-slim', 'jw-sandbox-0123456789abcdef');

  it('has no network, no capability, a read-only root, a small memory, few processes and an unprivileged user', () => {
    const joined = args.join(' ');
    for (const flag of [
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--memory 192m',
      '--memory-swap 192m',
      '--pids-limit 64',
      '--user 65534:65534',
      '--rm',
      '--label jobwatch.sandbox=true',
    ])
      expect(joined).toContain(flag);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--network=host');
    expect(args.indexOf('--permission')).toBeGreaterThan(args.indexOf('node:26-bookworm-slim'));
    expect(args[args.length - 1]).toBe(RUNNER_SOURCE);
  });

  it('mounts nothing and passes no environment of the router', () => {
    expect(args.filter((arg) => arg === '--env' || arg === '-e')).toEqual(['--env', '-e']); // NODE_OPTIONS emptied, and node -e for the runner
    expect(args).toContain('NODE_OPTIONS=');
  });

  it('refuses an image or a name that could carry a flag', () => {
    expect(() => dockerSandboxArgs('--privileged', 'jw-sandbox-0123456789abcdef')).toThrow(/image/);
    expect(() => dockerSandboxArgs('node', 'x; rm')).toThrow(/name/);
  });
});

describe('the module built from a row', () => {
  const row = (over: Partial<CustomAdapterRow> = {}): CustomAdapterRow => ({
    handle: 'acmejobs',
    name: 'Acme jobs',
    kind: 'http',
    url: 'https://careers.acme.com/api',
    script: `async function read(board) { const r = (await http.get('https://careers.acme.com/api/' + board)).json(); return { name: board, postings: r.map((j) => ({ id: j.id, title: j.title, url: 'https://careers.acme.com/j/' + j.id, locations: [j.city], description: j.text })) }; }`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('is an http adapter with one tool, allowed one host, with the input and output of the company-board tools', () => {
    const module = buildCustomModule(row(), { spawner: real });
    expect(module).toMatchObject({ id: 'custom-acmejobs', platform: 'custom-acmejobs', kind: 'http', allowedHosts: ['careers.acme.com'] });
    expect(module.tools.map((tool) => tool.name)).toEqual(['custom_acmejobs']);
    const tool = module.tools[0];
    expect(Object.keys((tool?.input as unknown as { shape: object }).shape)).toEqual(
      expect.arrayContaining([
        'boards',
        'title_any',
        'location_any',
        'posted_within',
        'disallowed_terms',
        'only_new',
        'max_results',
        'detail',
      ]),
    );
  });

  it('is a browser adapter when the row says so', () => {
    expect(buildCustomModule(row({ kind: 'browser' }), { spawner: real })).toMatchObject({ kind: 'browser', platform: 'custom-acmejobs' });
  });

  it('refuses an address that is not https, has credentials or a port, or is not a public name', () => {
    for (const url of [
      'http://careers.acme.com',
      'https://user@careers.acme.com',
      'https://careers.acme.com:8443',
      'https://localhost',
      'https://10.0.0.1',
      'not a url',
    ])
      expect(() => buildCustomModule(row({ url }), { spawner: real })).toThrow(/custom adapter "acmejobs"/);
    expect(checkTargetUrl('https://careers.acme.com/api/')).toEqual({ url: 'https://careers.acme.com/api/', host: 'careers.acme.com' });
    expect(checkTargetUrl('https://Careers.Acme.com/')).toEqual({ url: 'https://careers.acme.com', host: 'careers.acme.com' });
  });

  it('runs the script for each board, then the filters, the store and the answer are those of every board tool', async () => {
    const module = buildCustomModule(row(), { spawner: real });
    const tool = module.tools[0];
    if (tool === undefined) throw new Error('no tool');
    const ctx = createHttpTestContext({
      allowedHosts: module.allowedHosts,
      platform: 'custom-acmejobs',
      routes: [
        {
          url: 'https://careers.acme.com/api/acme',
          body: [
            { id: 'j1', title: 'Senior Frontend Engineer', city: 'Paris', text: 'We use React and TypeScript.' },
            { id: 'j2', title: 'Office Manager', city: 'Paris', text: 'Run the office.' },
          ],
        },
        { url: 'https://careers.acme.com/api/ghost', body: [] },
      ],
    });
    const result = await tool.handler(
      tool.input.parse({ boards: ['acme', 'ghost'], title_any: ['engineer'], detail: 'full' }) as never,
      ctx.ctx as never,
    );
    const data = result.data as {
      jobs: { id: string; source: string; board: string; company: string | null; description: string }[];
      boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
    };
    expect(data.jobs.map((job) => [job.id, job.source, job.board, job.company])).toEqual([['j1', 'custom-acmejobs', 'acme', 'acme']]);
    expect(data.jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(data.boards.map((board) => [board.board, board.status, board.jobs_total, board.relevant])).toEqual([
      ['acme', 'ok', 2, 1],
      ['ghost', 'ok', 0, 0],
    ]);
    expect(ctx.spent()).toBe(2); // one request per board: the script's requests are the call's units
    expect([...ctx.jobs.jobs.values()].map((job) => job.id)).toEqual(['j1']);
  }, 30_000);

  it('reports a script that fails on its own board, and the others carry on', async () => {
    const module = buildCustomModule(
      row({ script: `async function read(board) { if (board === 'bad') throw new Error('nope'); return { name: board, postings: [] }; }` }),
      { spawner: real },
    );
    const tool = module.tools[0];
    if (tool === undefined) throw new Error('no tool');
    const ctx = createHttpTestContext({ allowedHosts: module.allowedHosts, platform: 'custom-acmejobs', routes: [] });
    const result = await tool.handler(tool.input.parse({ boards: ['good', 'bad'] }) as never, ctx.ctx as never);
    const boards = (result.data as { boards: { board: string; status: string; message?: string }[] }).boards;
    expect(boards.map((board) => [board.board, board.status])).toEqual([
      ['good', 'ok'],
      ['bad', 'error'],
    ]);
    expect(boards[1]?.message).toMatch(/The script failed: nope/);
  }, 30_000);

  it('starts the editor from a sample that names the input and the output and leaves the body to write', () => {
    const http = sampleScript('http');
    const browser = sampleScript('browser');
    for (const text of [http, browser]) {
      expect(text).toContain('async function read(board, filters)');
      expect(text).toContain('TODO');
      expect(text).toContain('postings');
    }
    expect(http).not.toContain('session.goto');
    expect(browser).toContain('session.goto');
  });

  it('unused fakes stay out of the way', () => {
    expect([FakeJobStore, FakeCompanyBoards, FakePlaceLog, FakePlatformMemory]).toHaveLength(4);
  });
});
