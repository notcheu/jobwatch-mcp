import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  HostNotAllowedError,
  JobwatchError,
  htmlToText,
  slugify,
  titleCase,
  z,
  type BoardRead,
  type BrowserSession,
  type HttpClient,
  type Logger,
} from '@jobwatch/sdk';
import { RUNNER_SOURCE } from './runner';

/** What the router needs of the isolated process: lines in, lines out, an end, and a way to stop it. */
export interface SandboxProcess {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (reason: string) => void): void;
  kill(): void;
}
export interface SandboxSpawner {
  start(): SandboxProcess;
}

/** The limits of one run of a script. */
export const SANDBOX_LIMITS = {
  /** Wall clock for the whole run; the process is killed after it. */
  timeoutMs: 40_000,
  /** Requests and page loads a script may make in one run (each one is a unit of the adapter's budget). */
  maxUnits: 30,
  /** Calls of any kind (the units above, the helpers and the log). */
  maxCalls: 400,
  /** Bytes the process may write in all: a script that floods stdout is stopped. */
  maxOutputBytes: 4_000_000,
  maxPostings: 2000,
} as const;

const MAX_URL = 2000;
const MAX_LOG = 500;

// ------------------------------------------------------------------------------------------------ the spawners

/** `docker run` arguments of a sandbox: no network, no capability, a read-only root, a small memory, few processes, nobody. Exported for the tests. */
export function dockerSandboxArgs(image: string, name: string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/.test(image)) throw new Error('Refusing to run docker: invalid sandbox image');
  if (!/^jw-sandbox-[a-f0-9]{16}$/.test(name)) throw new Error('Refusing to run docker: invalid sandbox name');
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--label',
    'jobwatch.sandbox=true',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=8m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '192m',
    '--memory-swap',
    '192m',
    '--pids-limit',
    '64',
    '--cpus',
    '1',
    '--user',
    '65534:65534',
    '--env',
    'NODE_OPTIONS=',
    image,
    'node',
    '--permission',
    '--max-old-space-size=96',
    '--input-type=module',
    '-e',
    RUNNER_SOURCE,
  ];
}

/** The `ChildProcess` as a `SandboxProcess`: lines are cut here, and what the process writes in all is capped. */
function wrap(child: ReturnType<typeof spawn>, onKill: () => void): SandboxProcess {
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: ((reason: string) => void)[] = [];
  let buffer = '';
  let written = 0;
  let ended = false;
  const finish = (reason: string): void => {
    if (ended) return;
    ended = true;
    for (const listener of exitListeners) listener(reason);
  };
  const stop = (reason: string): void => {
    onKill();
    child.kill('SIGKILL');
    finish(reason);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    written += chunk.length;
    if (written > SANDBOX_LIMITS.maxOutputBytes) return stop('wrote too much');
    buffer += chunk.toString('utf8');
    if (buffer.length > SANDBOX_LIMITS.maxOutputBytes) return stop('wrote a line that is too long');
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      for (const listener of lineListeners) listener(line);
      cut = buffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', () => undefined); // drained, never kept: it could only be the script's own noise
  child.stdin?.on('error', () => undefined);
  child.on('error', (error) => finish(`could not start: ${error.message}`));
  child.on('close', (code) => finish(`exited with code ${code ?? -1}`));
  return {
    write: (line) => void child.stdin?.write(`${line}\n`),
    onLine: (listener) => void lineListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    kill: () => stop('stopped'),
  };
}

/** Each run is a container (`docker run`) with no network at all: the script can reach nothing but what the router relays. */
export function dockerSpawner(
  image: string,
  docker: (args: readonly string[]) => ReturnType<typeof spawn> = (args) => spawn('docker', [...args], { stdio: ['pipe', 'pipe', 'pipe'] }),
): SandboxSpawner {
  return {
    start() {
      const name = `jw-sandbox-${randomBytes(8).toString('hex')}`;
      const child = docker(dockerSandboxArgs(image, name));
      // `--rm` removes the container once it stops; killing the CLI does not stop the container, so ask the daemon to
      return wrap(child, () => void docker(['kill', name]).on('error', () => undefined));
    },
  };
}

/** Removes the sandbox containers a router that was killed left behind. Never throws: docker may not be there. */
export function reapSandboxes(
  docker: (args: readonly string[]) => ReturnType<typeof spawn> = (args) =>
    spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'ignore'] }),
): Promise<number> {
  return new Promise((resolve) => {
    const list = docker(['ps', '-aq', '--filter', 'label=jobwatch.sandbox=true']);
    let ids = '';
    list.stdout?.on('data', (chunk: Buffer) => (ids += chunk.toString()));
    list.on('error', () => resolve(0));
    list.on('close', () => {
      const found = ids.split('\n').filter((id) => /^[a-f0-9]{6,64}$/.test(id));
      if (found.length === 0) return resolve(0);
      const remove = docker(['rm', '-f', ...found]);
      remove.on('error', () => resolve(0));
      remove.on('close', () => resolve(found.length));
    });
  });
}

/**
 * A bare Node process with the permission model: no files, no network, no child process, no worker, an empty environment. It is not a
 * container: nothing caps its memory beyond the heap or its processes and CPU, and Node's permission model is the only wall between the
 * script and the host, so it is for local development only and the router says so at start. NEVER the setting of a router that is reachable.
 */
export function processSpawner(execPath: string = process.execPath): SandboxSpawner {
  return {
    start() {
      const child = spawn(execPath, ['--permission', '--max-old-space-size=96', '--input-type=module', '-e', RUNNER_SOURCE], {
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return wrap(child, () => undefined);
    },
  };
}

// ----------------------------------------------------------------------------------------------- what comes back

const posting = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'an id is 1 to 64 letters, digits, - or _'),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().max(200).nullish(),
  locations: z.array(z.string().trim().min(1).max(200)).max(20).nullish(),
  url: z
    .string()
    .max(1000)
    .refine((value) => value.startsWith('https://'), 'a posting address is https'),
  postedAt: z.string().max(40).nullish(),
  description: z.string().max(100_000).nullish(),
});
const resultSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  postings: z.array(posting).max(SANDBOX_LIMITS.maxPostings),
});

/** What the script returned, checked and shaped as a board read; a wrong shape is the script's fault, said in plain words. */
export function toBoardRead(value: unknown): BoardRead {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JobwatchError(
      'upstream_error',
      `The script returned the wrong shape: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    );
  }
  const seen = new Set<string>();
  const postings = parsed.data.postings
    .filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
    .map((entry) => {
      const time = entry.postedAt === null || entry.postedAt === undefined ? Number.NaN : Date.parse(entry.postedAt);
      return {
        id: entry.id,
        title: entry.title,
        company: entry.company === undefined || entry.company === '' ? null : entry.company,
        locations: [...new Set(entry.locations ?? [])],
        url: entry.url,
        postedAt: Number.isNaN(time) ? null : new Date(time).toISOString(),
        description: entry.description ?? '',
      };
    });
  return { name: parsed.data.name ?? null, postings };
}

// ------------------------------------------------------------------------------------------------------- the run

const rpcSchema = z.object({
  type: z.literal('rpc'),
  id: z.number().int().positive(),
  fn: z.string().max(40),
  args: z.array(z.unknown()).max(4),
});
const outcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), value: z.unknown() }),
  z.object({ type: z.literal('error'), message: z.string().max(600) }),
]);

const requestOptions = z.object({ headers: z.record(z.string().max(100), z.string().max(2000)).optional() }).passthrough();

export interface SandboxRun {
  spawner: SandboxSpawner;
  script: string;
  kind: 'http' | 'browser';
  /** One entry of the tool's `boards` argument. */
  board: string;
  /** The tool's other arguments. */
  filters: unknown;
  /** The call's metered, allowlisted HTTP client: every request the script makes goes through it. */
  http: HttpClient;
  /** The call's browser session, for a script of kind `browser`. */
  session?: BrowserSession;
  log: Logger;
  limits?: { [K in keyof typeof SANDBOX_LIMITS]?: number };
}

/**
 * Runs the script of a custom adapter for one board and returns what it found. The process is the only trust boundary: every line it
 * writes is parsed and checked, every request it asks for goes through the call's own HTTP client (host allowlist, metering, caps), and
 * the run ends, by killing the process, at the deadline, at too many units or calls, or at too much output.
 */
export async function runInSandbox(run: SandboxRun): Promise<BoardRead> {
  const limits = { ...SANDBOX_LIMITS, ...run.limits };
  const child = run.spawner.start();
  let units = 0;
  let calls = 0;

  const handlers: Record<string, (args: readonly unknown[]) => Promise<unknown>> = {
    'sdk.htmlToText': async ([html]) => htmlToText(String(html ?? '').slice(0, 1_000_000)),
    'sdk.slugify': async ([text]) => slugify(String(text ?? '').slice(0, 1000)),
    'sdk.titleCase': async ([text]) => titleCase(String(text ?? '').slice(0, 1000)),
    log: async ([message]) => void run.log.info('custom_adapter_log', { message: String(message ?? '').slice(0, MAX_LOG) }),
  };
  const spend = (): void => {
    units += 1;
    if (units > limits.maxUnits)
      throw new JobwatchError('budget_exceeded', `The script made more than ${limits.maxUnits} requests or page loads in one run.`);
  };
  const url = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL) throw new Error('The address is not valid.');
    return value;
  };
  const reply = (response: { status: number; ok: boolean; headers: Readonly<Record<string, string>>; text: string }) => ({
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text: response.text,
  });
  handlers['http.get'] = async ([address, options]) => {
    spend();
    const parsed = requestOptions.parse(options ?? {});
    return reply(
      await run.http.get(url(address), { timeoutMs: 25_000, ...(parsed.headers === undefined ? {} : { headers: parsed.headers }) }),
    );
  };
  handlers['http.postJson'] = async ([address, body, options]) => {
    spend();
    const parsed = requestOptions.parse(options ?? {});
    return reply(
      await run.http.postJson(url(address), body, {
        timeoutMs: 25_000,
        ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
      }),
    );
  };
  if (run.kind === 'browser' && run.session !== undefined) {
    const session = run.session;
    handlers['session.goto'] = async ([address, options]) => {
      spend();
      const timeoutMs = z
        .object({ timeoutMs: z.number().int().min(1000).max(30_000).default(20_000), waitFor: z.string().max(200).optional() })
        .parse(options ?? {});
      await session.goto(url(address), timeoutMs);
    };
    handlers['session.evaluate'] = async ([script, arg]) => {
      if (typeof script !== 'string' || script.length > 20_000) throw new Error('The page script must be a function expression as text.');
      return session.evaluate(script, arg);
    };
    handlers['session.waitForSelector'] = async ([selector, timeoutMs]) =>
      session.waitForSelector(
        z.string().max(300).parse(selector),
        z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .parse(timeoutMs ?? 10_000),
      );
    handlers['session.text'] = async ([selector]) => session.text(z.string().max(300).parse(selector));
    handlers['session.url'] = async () => session.url();
  }

  return await new Promise<BoardRead>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      action();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new JobwatchError('timeout', `The script ran for more than ${Math.round(limits.timeoutMs / 1000)} s and was stopped.`)),
        ),
      limits.timeoutMs,
    );
    child.onExit((reason) =>
      settle(() => reject(new JobwatchError('upstream_error', `The script's sandbox ${reason} before it answered.`))),
    );
    child.onLine((line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return; // noise on the channel is not a message
      }
      const outcome = outcomeSchema.safeParse(message);
      if (outcome.success) {
        const done = outcome.data;
        return settle(() => {
          if (done.type === 'error') return reject(new JobwatchError('upstream_error', `The script failed: ${done.message}`));
          try {
            resolve(toBoardRead(done.value));
          } catch (error) {
            reject(error);
          }
        });
      }
      const rpc = rpcSchema.safeParse(message);
      if (!rpc.success || settled) return;
      calls += 1;
      const { id, fn, args } = rpc.data;
      const answer = (payload: object): void => child.write(JSON.stringify({ type: 'reply', id, ...payload }));
      if (calls > limits.maxCalls)
        return settle(() => reject(new JobwatchError('budget_exceeded', `The script made more than ${limits.maxCalls} calls in one run.`)));
      const handler = handlers[fn];
      if (handler === undefined) return answer({ ok: false, error: `There is no ${fn} here.` });
      handler(args).then(
        (value) => answer({ ok: true, value: value ?? null }),
        (error: unknown) => {
          // a budget refusal ends the run; any other failure is the script's to handle (a refused host, a 404 it did not expect)
          if (error instanceof JobwatchError && error.code === 'budget_exceeded') return settle(() => reject(error));
          const text =
            error instanceof HostNotAllowedError ? error.message : error instanceof Error ? error.message : 'The request failed.';
          answer({ ok: false, error: text.slice(0, 300) });
        },
      );
    });
    child.write(JSON.stringify({ type: 'run', kind: run.kind, script: run.script, board: run.board, filters: run.filters }));
  });
}
