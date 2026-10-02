/**
 * What the runtime manager needs from a container runtime. Implemented by `DockerCliBackend` (shells out to the `docker`
 * CLI against the rootless daemon) and by a fake in the tests. Nothing here knows about Chrome or CDP: the browser layer
 * (step 6) plugs in through the manager's hooks.
 */

export interface RuntimeSpec {
  platform: string;
  /** Unique container name, e.g. `jw-linkedin`. */
  name: string;
  image: string;
  /** Hard memory cap (`--memory`, and `--memory-swap` equal to it: no swap). */
  memoryMb: number;
  /** Soft hint (`--memory-reservation`). Does NOT set memory.high (measured in S3), the watchdog is the soft control. */
  memoryReservationMb: number;
  /** Named Docker volume mounted at /profile. Never a host path. */
  profileVolume: string;
  /** Internal Docker network shared with the router. */
  network: string;
  /** Path of the custom seccomp profile, as seen by the `docker` CLI process (docs/plans/05-browser-runtime.md, G6). */
  seccompProfile?: string;
  env?: Readonly<Record<string, string>>;
}

export interface RuntimeHandle {
  name: string;
  platform: string;
  /** IP address on the browser network. DevTools must be reached by IP, never by name (G2). */
  address: string;
}

export interface ContainerState {
  running: boolean;
  oomKilled: boolean;
  exitCode: number | null;
}

export interface RuntimeBackend {
  /** Create and start the container; resolves once it is running and has an address. Removes a stale container of the same name first. */
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
  /** SIGTERM, wait `graceS`, then SIGKILL; then remove the container. The profile volume is never touched. */
  stop(handle: RuntimeHandle, graceS: number): Promise<void>;
  inspect(handle: RuntimeHandle): Promise<ContainerState>;
  /** Working-set bytes: `memory.current` minus `inactive_file` (what `docker stats` shows), NOT `memory.peak` (06). */
  memoryBytes(handle: RuntimeHandle): Promise<number>;
  /** Names of every container carrying the `jobwatch.managed=true` label, running or not. */
  listManaged(): Promise<string[]>;
  /** Force-remove a container by name. A missing container is not an error. */
  remove(name: string): Promise<void>;
}

export class BackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackendError';
  }
}
