import { spawn } from 'node:child_process';
import { BackendError, type ContainerState, type RuntimeBackend, type RuntimeHandle, type RuntimeSpec } from './backend';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `docker <args>`. Injected so the tests never need a daemon. Must not use a shell. */
export type DockerRunner = (args: readonly string[], options: { timeoutMs: number }) => Promise<CliResult>;

export const MANAGED_LABEL = 'jobwatch.managed=true';
const MAX_OUTPUT = 1_000_000;

/** The real runner: `spawn('docker', args)`, no shell, output capped, killed on timeout. */
export const spawnDocker: DockerRunner = (args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new BackendError(`docker ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(new BackendError(`cannot run docker: ${cause.message}`, { cause }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Values may carry commas and spaces (an Accept-Language list), but never a newline or NUL.
const ENV_VALUE = /^[^\0\r\n]{0,2048}$/;

function check(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new BackendError(`Refusing to run docker: invalid ${label}`);
}

/**
 * Every `docker run` flag of 06-memory-and-lifecycle-policy.md, as an argument ARRAY. Exported for the tests, which
 * pin the hardening: nothing here may be dropped without the test (and the doc) changing.
 */
export function runArgs(spec: RuntimeSpec): string[] {
  check('container name', spec.name, NAME);
  check('platform', spec.platform, NAME);
  check('image', spec.image, IMAGE);
  check('profile volume', spec.profileVolume, NAME);
  check('network', spec.network, NAME);
  if (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 256 || spec.memoryMb > 16_384)
    throw new BackendError('Refusing to run docker: invalid memory cap');
  if (!Number.isInteger(spec.memoryReservationMb) || spec.memoryReservationMb < 128 || spec.memoryReservationMb > spec.memoryMb) {
    throw new BackendError('Refusing to run docker: invalid memory reservation');
  }
  if (spec.seccompProfile !== undefined && (!spec.seccompProfile.startsWith('/') || /[\0\r\n,]/.test(spec.seccompProfile))) {
    throw new BackendError('Refusing to run docker: invalid seccomp profile path (must be absolute)');
  }
  const args = [
    'run',
    '-d',
    '--init',
    '--name',
    spec.name,
    '--memory',
    `${spec.memoryMb}m`,
    '--memory-swap',
    `${spec.memoryMb}m`,
    '--memory-reservation',
    `${spec.memoryReservationMb}m`,
    '--oom-score-adj',
    '500',
    '--pids-limit',
    '512',
    '--shm-size',
    '256m',
    '--cpus',
    '1.5',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(spec.seccompProfile ? ['--security-opt', `seccomp=${spec.seccompProfile}`] : []),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=256m',
    '--tmpfs',
    '/run:rw,size=16m',
    '--tmpfs',
    '/home/chrome:rw,size=64m,uid=1000,gid=1000',
    '-v',
    `${spec.profileVolume}:/profile`,
    '--network',
    spec.network,
    '--label',
    MANAGED_LABEL,
    '--label',
    `jobwatch.platform=${spec.platform}`,
  ];
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    check(`environment variable name "${key}"`, key, ENV_NAME);
    check(`value of environment variable ${key}`, value, ENV_VALUE);
    args.push('-e', `${key}=${value}`);
  }
  // `--` ends the options, so an image reference can never be read as a flag.
  args.push('--', spec.image);
  return args;
}

export const LOGIN_LABEL = 'jobwatch.login=true';
export const LOGIN_PORT = 6080;

/**
 * `docker run` arguments of the manual-login container (05-browser-runtime.md, "Login procedure"): the same hardening as a
 * run container plus noVNC published on the host's loopback ONLY, and a label of its own so the orphan reaper (which only
 * knows `jobwatch.managed`) never kills a login in progress. The caller puts `MODE=login` and `VNC_PASSWORD` in `spec.env`.
 */
export function loginRunArgs(spec: RuntimeSpec, hostPort: number): string[] {
  if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65_535)
    throw new BackendError('Refusing to run docker: invalid login port');
  const args = runArgs(spec);
  const label = args.indexOf(MANAGED_LABEL);
  if (label === -1) throw new BackendError('internal: managed label missing from the docker arguments');
  args[label] = LOGIN_LABEL;
  const end = args.lastIndexOf('--');
  args.splice(end, 0, '-p', `127.0.0.1:${hostPort}:${LOGIN_PORT}`);
  return args;
}

/** Reads `memory.current - inactive_file` inside the container: the working set `docker stats` shows (06). */
const WORKING_SET_SCRIPT =
  "c=$(cat /sys/fs/cgroup/memory.current); i=$(awk '/^inactive_file /{print $2}' /sys/fs/cgroup/memory.stat); echo $((c-i))";

interface InspectJson {
  State?: { Running?: boolean; OOMKilled?: boolean; ExitCode?: number };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string } | undefined> };
}

export class DockerCliBackend implements RuntimeBackend {
  constructor(
    private readonly run: DockerRunner = spawnDocker,
    private readonly network: string,
  ) {}

  private async docker(args: readonly string[], timeoutMs: number, what: string): Promise<CliResult> {
    const result = await this.run(args, { timeoutMs });
    if (result.code !== 0) throw new BackendError(`docker ${what} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
    return result;
  }

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    await this.remove(spec.name); // a stale container of the same name (crash, kill) would make `run` fail
    await this.docker(runArgs(spec), 60_000, 'run');
    const handle = await this.handleFor(spec.name, spec.platform);
    return handle;
  }

  private async handleFor(name: string, platform: string): Promise<RuntimeHandle> {
    const result = await this.docker(['inspect', name], 15_000, 'inspect');
    const json = parseInspect(result.stdout);
    const address = json.NetworkSettings?.Networks?.[this.network]?.IPAddress;
    if (json.State?.Running !== true) throw new BackendError(`container ${name} is not running right after start`);
    if (address === undefined || address === '') throw new BackendError(`container ${name} has no address on network ${this.network}`);
    return { name, platform, address };
  }

  async stop(handle: RuntimeHandle, graceS: number): Promise<void> {
    check('container name', handle.name, NAME);
    const grace = Math.max(1, Math.min(60, Math.floor(graceS)));
    // `docker stop -t N`: SIGTERM, wait N seconds, SIGKILL. A container that is already gone is fine.
    const stopped = await this.run(['stop', '-t', String(grace), handle.name], { timeoutMs: (grace + 20) * 1000 });
    if (stopped.code !== 0 && !/No such container/i.test(stopped.stderr)) {
      throw new BackendError(`docker stop failed (exit ${stopped.code}): ${stopped.stderr.trim().slice(0, 500)}`);
    }
    await this.remove(handle.name);
  }

  async inspect(handle: RuntimeHandle): Promise<ContainerState> {
    const result = await this.run(['inspect', handle.name], { timeoutMs: 15_000 });
    if (result.code !== 0) return { running: false, oomKilled: false, exitCode: null };
    const { State } = parseInspect(result.stdout);
    return { running: State?.Running === true, oomKilled: State?.OOMKilled === true, exitCode: State?.ExitCode ?? null };
  }

  async memoryBytes(handle: RuntimeHandle): Promise<number> {
    const result = await this.docker(['exec', handle.name, 'sh', '-c', WORKING_SET_SCRIPT], 10_000, 'exec (memory)');
    const text = result.stdout.trim();
    // Digits only: Number('') is 0, which would turn a failed reading into "nothing used" and silence the watchdog.
    const value = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(value)) throw new BackendError('unexpected memory reading from the container');
    return value;
  }

  async listManaged(): Promise<string[]> {
    const result = await this.docker(['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', '{{.Names}}'], 15_000, 'ps');
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => NAME.test(line));
  }

  async remove(name: string): Promise<void> {
    check('container name', name, NAME);
    const result = await this.run(['rm', '-f', name], { timeoutMs: 30_000 });
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
      throw new BackendError(`docker rm failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
    }
  }
}

function parseInspect(stdout: string): InspectJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new BackendError('docker inspect returned something that is not JSON', { cause });
  }
  const first = Array.isArray(parsed) ? (parsed[0] as InspectJson | undefined) : undefined;
  if (first === undefined) throw new BackendError('docker inspect returned no container');
  return first;
}
