import { JobwatchError } from '@jobwatch/sdk';
import type { EngineLogger } from '../logging';
import type { RuntimeBackend, RuntimeHandle, RuntimeSpec } from './backend';
import { Semaphore } from './semaphore';

export type RuntimeState = 'cold' | 'starting' | 'busy' | 'idle_grace' | 'stopping';
export type StopReason = 'idle' | 'preempt' | 'max_lifetime' | 'critical' | 'died' | 'shutdown' | 'stale' | 'start_failed';
export type MemoryLevel = 'ok' | 'warn' | 'critical';

export type RuntimeEvent =
  | { type: 'state'; platform: string; state: RuntimeState }
  | { type: 'cold_start'; platform: string; ms: number }
  | { type: 'queue_wait'; ms: number }
  | { type: 'memory'; platform: string; bytes: number; level: MemoryLevel }
  | { type: 'stopped'; platform: string; reason: StopReason };

export interface ManagerConfig {
  image: string;
  network: string;
  seccompProfile?: string;
  /** Volume name = `<profileVolumePrefix><platform>`. */
  profileVolumePrefix: string;
  env?: Readonly<Record<string, string>>;
  idleTtlS: number;
  maxLifetimeS: number;
  queueTimeoutS: number;
  /** Defaults: hard cap and soft mark of 06-memory-and-lifecycle-policy.md. Per-lease budgets override. */
  memMaxMb: number;
  memHighMb: number;
  startTimeoutS?: number;
  /** How long the optional `quit` hook (Browser.close over DevTools) may take before the container is signalled. */
  quitTimeoutS?: number;
  /** `docker stop -t`: SIGTERM, then SIGKILL after this many seconds. */
  stopGraceS?: number;
  watchdogIntervalMs?: number;
  warnRatio?: number;
  criticalRatio?: number;
}

/** Where the browser layer (step 6) plugs in. All optional: the manager works, and is tested, without a browser. */
export interface RuntimeHooks {
  /** Runs after the container is up: wait for DevTools, run the fingerprint check. A rejection fails the start. */
  ready?: (handle: RuntimeHandle) => Promise<void>;
  /** Ask the application to quit cleanly (Browser.close) before the container is signalled. Errors are ignored. */
  quit?: (handle: RuntimeHandle) => Promise<void>;
  /** Memory is above the warn mark: close stray tabs, collect garbage. Errors are ignored. */
  onWarn?: (handle: RuntimeHandle) => Promise<void>;
}

export interface LeaseOptions {
  /** Per-tool budget; the runtime is (re)started with the largest cap of its tools (06). */
  memory?: { highMb: number; maxMb: number };
}

export interface Lease {
  readonly handle: RuntimeHandle;
  /** True when this lease had to start the container (cold start). */
  readonly coldStart: boolean;
  /** Aborted when the runtime dies or is killed for memory; `signal.reason` is the `JobwatchError` to return. */
  readonly signal: AbortSignal;
  /** Highest working set seen during the lease, in bytes (0 until the first watchdog reading). */
  peakBytes(): number;
  /** Give the browser back. Idempotent. Starts the idle timer. */
  release(): Promise<void>;
}

export interface RuntimeStatus {
  current:
    { platform: string; state: RuntimeState; address: string | undefined; startedAt: number | undefined; peakBytes: number } | undefined;
  waiting: number;
}

interface Current {
  platform: string;
  state: RuntimeState;
  /** Hard memory cap this runtime was started with, in MB: the watchdog thresholds are fractions of it. */
  capMb: number;
  handle: RuntimeHandle | undefined;
  startedAt: number;
  peak: number;
  idleTimer: NodeJS.Timeout | undefined;
  watchdogTimer: NodeJS.Timeout | undefined;
  lastWarnAt: number;
  abort: AbortController | undefined;
  stopping: Promise<void> | undefined;
}

const MIB = 1024 * 1024;
const WARN_REPEAT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * One browser at a time, for the whole router (06-memory-and-lifecycle-policy.md). The per-platform state machine of the
 * spec collapses to ONE slot, because a second platform can only run after the first is gone:
 *
 *   COLD -> STARTING -> BUSY -> IDLE_GRACE -> STOPPING -> COLD
 *
 * - `lease()` waits its turn in a FIFO queue (`busy` after the queue timeout), reuses a warm runtime of the same platform,
 *   stops an idle one of another platform at once (preemption), recycles one older than `maxLifetimeS` (never mid-call),
 *   and starts a cold one (one retry).
 * - The idle timer stops the runtime `idleTtlS` after the last lease ends. Profile volumes are never touched.
 * - The watchdog polls the working set every few seconds: at the warn mark it asks the browser layer to shed memory, at
 *   the critical mark it aborts the lease with `budget_exceeded` and stops the runtime; a container that dies is reported
 *   as `oom_killed` when the kernel killed it.
 */
export class RuntimeManager {
  private readonly semaphore = new Semaphore(1);
  private current: Current | undefined;
  private shuttingDown = false;
  private readonly cfg: Required<
    Pick<ManagerConfig, 'startTimeoutS' | 'quitTimeoutS' | 'stopGraceS' | 'watchdogIntervalMs' | 'warnRatio' | 'criticalRatio'>
  > &
    ManagerConfig;

  constructor(
    private readonly backend: RuntimeBackend,
    config: ManagerConfig,
    private readonly logger: EngineLogger,
    private readonly hooks: RuntimeHooks = {},
    private readonly onEvent: (event: RuntimeEvent) => void = () => undefined,
  ) {
    this.cfg = {
      startTimeoutS: 30,
      quitTimeoutS: 10,
      stopGraceS: 10,
      watchdogIntervalMs: 5000,
      warnRatio: 0.7,
      criticalRatio: 0.9,
      ...config,
    };
  }

  status(): RuntimeStatus {
    const c = this.current;
    return {
      current: c && {
        platform: c.platform,
        state: c.state,
        address: c.handle?.address,
        startedAt: c.handle ? c.startedAt : undefined,
        peakBytes: c.peak,
      },
      waiting: this.semaphore.waiting,
    };
  }

  async lease(platform: string, options: LeaseOptions = {}): Promise<Lease> {
    this.assertRunning();
    const queuedAt = Date.now();
    const releaseSlot = await this.semaphore.acquire(this.cfg.queueTimeoutS * 1000, this.cfg.queueTimeoutS);
    this.emit({ type: 'queue_wait', ms: Date.now() - queuedAt });
    try {
      this.assertRunning();
      const { current, coldStart } = await this.prepare(platform, options);
      current.abort = new AbortController();
      this.setState(current, 'busy');
      this.scheduleWatchdog(current);
      return this.makeLease(current, coldStart, releaseSlot);
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  /** Stop the runtime and refuse new leases. Called on SIGTERM. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const c = this.current;
    if (c !== undefined) {
      c.abort?.abort(new JobwatchError('internal', 'The router is shutting down.'));
      await this.stopCurrent('shutdown');
    }
  }

  /** Remove containers left by a previous router process (crash, kill). Returns their names. */
  async reapOrphans(): Promise<string[]> {
    const keep = this.current?.handle?.name;
    const reaped: string[] = [];
    for (const name of await this.backend.listManaged()) {
      if (name === keep) continue;
      await this.backend.remove(name);
      reaped.push(name);
    }
    if (reaped.length > 0) this.logger.warn({ containers: reaped }, 'orphans_reaped');
    return reaped;
  }

  // ------------------------------------------------------------------ internals

  private assertRunning(): void {
    if (this.shuttingDown) throw new JobwatchError('internal', 'The router is shutting down.');
  }

  private emit(event: RuntimeEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger.error({ err: error }, 'runtime_listener_failed');
    }
  }

  private setState(current: Current, state: RuntimeState): void {
    current.state = state;
    this.emit({ type: 'state', platform: current.platform, state });
  }

  /** Make `this.current` a runtime of `platform` that is up and idle (state unchanged here). Holds the semaphore. */
  private async prepare(platform: string, options: LeaseOptions): Promise<{ current: Current; coldStart: boolean }> {
    for (;;) {
      const existing = this.current;
      if (existing === undefined) break;
      if (existing.stopping !== undefined) {
        await existing.stopping;
        continue;
      }
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
      existing.state = 'busy'; // an idle timer that already fired must not stop it under our feet
      let reason: StopReason | undefined;
      if (existing.platform !== platform) reason = 'preempt';
      else if (Date.now() - existing.startedAt > this.cfg.maxLifetimeS * 1000) reason = 'max_lifetime';
      else if (
        existing.handle === undefined ||
        !(await this.backend.inspect(existing.handle).then(
          (s) => s.running,
          () => false,
        ))
      )
        reason = 'stale';
      if (reason === undefined) return { current: existing, coldStart: false };
      await this.stopCurrent(reason);
    }
    return { current: await this.startRuntime(platform, options), coldStart: true };
  }

  private specFor(platform: string, options: LeaseOptions): RuntimeSpec {
    const memory = options.memory ?? { highMb: this.cfg.memHighMb, maxMb: this.cfg.memMaxMb };
    return {
      platform,
      name: `jw-${platform}`,
      image: this.cfg.image,
      memoryMb: memory.maxMb,
      memoryReservationMb: memory.highMb,
      profileVolume: `${this.cfg.profileVolumePrefix}${platform}`,
      network: this.cfg.network,
      ...(this.cfg.seccompProfile ? { seccompProfile: this.cfg.seccompProfile } : {}),
      ...(this.cfg.env ? { env: this.cfg.env } : {}),
    };
  }

  private async startRuntime(platform: string, options: LeaseOptions): Promise<Current> {
    const spec = this.specFor(platform, options);
    const current: Current = {
      platform,
      state: 'starting',
      capMb: spec.memoryMb,
      handle: undefined,
      startedAt: Date.now(),
      peak: 0,
      idleTimer: undefined,
      watchdogTimer: undefined,
      lastWarnAt: 0,
      abort: undefined,
      stopping: undefined,
    };
    this.current = current;
    this.emit({ type: 'state', platform, state: 'starting' });
    const began = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const work = (async () => {
          const handle = await this.backend.start(spec);
          current.handle = handle;
          await this.hooks.ready?.(handle);
          return handle;
        })();
        await withTimeout(work, this.cfg.startTimeoutS * 1000, `start timed out after ${this.cfg.startTimeoutS} s`);
        current.startedAt = Date.now();
        this.emit({ type: 'cold_start', platform, ms: Date.now() - began });
        return current;
      } catch (error) {
        lastError = error;
        this.logger.warn({ err: error, platform, attempt }, 'runtime_start_failed');
        current.handle = undefined;
        await this.backend.remove(spec.name).catch((cleanup: unknown) => this.logger.error({ err: cleanup }, 'runtime_cleanup_failed'));
      }
    }
    this.current = undefined;
    this.emit({ type: 'stopped', platform, reason: 'start_failed' });
    this.emit({ type: 'state', platform, state: 'cold' });
    this.logger.error({ err: lastError, platform }, 'runtime_start_gave_up');
    throw new JobwatchError('internal', `The ${platform} browser could not be started.`, { details: { platform } });
  }

  private makeLease(current: Current, coldStart: boolean, releaseSlot: () => void): Lease {
    let released = false;
    const handle = current.handle;
    const abort = current.abort;
    if (handle === undefined || abort === undefined) throw new Error('lease on a runtime that is not up');
    return {
      handle,
      coldStart,
      signal: abort.signal,
      peakBytes: () => current.peak,
      release: async () => {
        if (released) return;
        released = true;
        if (this.current === current && current.state === 'busy') {
          current.abort = undefined;
          this.setState(current, 'idle_grace');
          current.idleTimer = setTimeout(() => {
            if (this.current === current && current.state === 'idle_grace') void this.stopCurrent('idle');
          }, this.cfg.idleTtlS * 1000);
        }
        releaseSlot();
      },
    };
  }

  /** Quit cleanly, then SIGTERM/SIGKILL, then remove. Never rejects. Resolves when the runtime is gone. */
  private stopCurrent(reason: StopReason): Promise<void> {
    const current = this.current;
    if (current === undefined) return Promise.resolve();
    if (current.stopping !== undefined) return current.stopping;
    clearTimeout(current.idleTimer);
    clearTimeout(current.watchdogTimer);
    current.idleTimer = undefined;
    current.watchdogTimer = undefined;
    this.setState(current, 'stopping');
    const handle = current.handle;
    current.stopping = (async () => {
      try {
        if (handle !== undefined) {
          if (this.hooks.quit)
            await withTimeout(this.hooks.quit(handle), this.cfg.quitTimeoutS * 1000, 'quit timed out').catch(() => undefined);
          try {
            await this.backend.stop(handle, this.cfg.stopGraceS);
          } catch (error) {
            this.logger.error({ err: error, platform: current.platform }, 'runtime_stop_failed');
            await this.backend
              .remove(handle.name)
              .catch((cleanup: unknown) => this.logger.error({ err: cleanup }, 'runtime_cleanup_failed'));
          }
        }
      } finally {
        if (this.current === current) this.current = undefined;
        this.emit({ type: 'stopped', platform: current.platform, reason });
        this.emit({ type: 'state', platform: current.platform, state: 'cold' });
        this.logger.info({ platform: current.platform, reason }, 'runtime_stopped');
      }
    })();
    return current.stopping;
  }

  private scheduleWatchdog(current: Current): void {
    clearTimeout(current.watchdogTimer);
    current.watchdogTimer = setTimeout(() => void this.watchdogTick(current), this.cfg.watchdogIntervalMs);
  }

  private async watchdogTick(current: Current): Promise<void> {
    const handle = current.handle;
    if (this.current !== current || current.stopping !== undefined || handle === undefined) return;
    try {
      const state = await this.backend.inspect(handle);
      if (this.current !== current || current.stopping !== undefined) return;
      if (!state.running) {
        const error = state.oomKilled
          ? new JobwatchError('oom_killed', 'The browser was killed for using too much memory.', {
              details: { platform: current.platform },
            })
          : new JobwatchError('internal', 'The browser stopped unexpectedly.', {
              details: { platform: current.platform, exit_code: state.exitCode },
            });
        this.logger.error({ platform: current.platform, oom: state.oomKilled, exitCode: state.exitCode }, 'runtime_died');
        current.abort?.abort(error);
        await this.stopCurrent('died');
        return;
      }
      const bytes = await this.backend.memoryBytes(handle);
      if (this.current !== current || current.stopping !== undefined) return;
      current.peak = Math.max(current.peak, bytes);
      const ratio = bytes / (current.capMb * MIB);
      if (ratio >= this.cfg.criticalRatio) {
        this.emit({ type: 'memory', platform: current.platform, bytes, level: 'critical' });
        this.logger.error({ platform: current.platform, mb: Math.round(bytes / MIB) }, 'mem_critical');
        current.abort?.abort(
          new JobwatchError('budget_exceeded', 'The browser used too much memory and was stopped.', {
            details: { platform: current.platform },
          }),
        );
        await this.stopCurrent('critical');
        return;
      }
      if (ratio >= this.cfg.warnRatio) {
        this.emit({ type: 'memory', platform: current.platform, bytes, level: 'warn' });
        if (Date.now() - current.lastWarnAt >= WARN_REPEAT_MS) {
          current.lastWarnAt = Date.now();
          this.logger.warn({ platform: current.platform, mb: Math.round(bytes / MIB) }, 'mem_warn');
          await this.hooks.onWarn?.(handle).catch((error: unknown) => this.logger.error({ err: error }, 'mem_warn_hook_failed'));
        }
      } else {
        this.emit({ type: 'memory', platform: current.platform, bytes, level: 'ok' });
      }
    } catch (error) {
      // A failed reading is not a reason to kill a working browser; it is logged and tried again.
      this.logger.warn({ err: error, platform: current.platform }, 'watchdog_read_failed');
    }
    if (this.current === current && current.stopping === undefined) this.scheduleWatchdog(current);
  }
}
