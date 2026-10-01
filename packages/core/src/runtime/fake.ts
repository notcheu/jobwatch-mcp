import { BackendError, type ContainerState, type RuntimeBackend, type RuntimeHandle, type RuntimeSpec } from './backend';

/** In-memory backend for tests. Every call is recorded; failures and memory readings are scriptable. */
export class FakeBackend implements RuntimeBackend {
  readonly calls: string[] = [];
  readonly containers = new Map<string, { spec: RuntimeSpec; running: boolean; oomKilled: boolean }>();
  /** Memory the next readings return, per container name; default 300 MB. */
  readonly memory = new Map<string, number>();
  startFailures = 0;
  startDelayMs = 0;
  stopDelayMs = 0;
  failMemory = false;
  private counter = 0;

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    this.calls.push(`start:${spec.platform}`);
    if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new BackendError('docker run failed (scripted)');
    }
    this.counter += 1;
    this.containers.set(spec.name, { spec, running: true, oomKilled: false });
    return { name: spec.name, platform: spec.platform, address: `172.18.0.${this.counter + 1}` };
  }

  async stop(handle: RuntimeHandle, graceS: number): Promise<void> {
    this.calls.push(`stop:${handle.platform}:${graceS}`);
    if (this.stopDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stopDelayMs));
    this.containers.delete(handle.name);
  }

  async inspect(handle: RuntimeHandle): Promise<ContainerState> {
    const container = this.containers.get(handle.name);
    if (container === undefined) return { running: false, oomKilled: false, exitCode: null };
    return {
      running: container.running,
      oomKilled: container.oomKilled,
      exitCode: container.running ? null : container.oomKilled ? 137 : 0,
    };
  }

  async memoryBytes(handle: RuntimeHandle): Promise<number> {
    if (this.failMemory) throw new BackendError('docker exec failed (scripted)');
    return this.memory.get(handle.name) ?? 300 * 1024 * 1024;
  }

  async listManaged(): Promise<string[]> {
    return [...this.containers.keys()];
  }

  async remove(name: string): Promise<void> {
    this.calls.push(`remove:${name}`);
    this.containers.delete(name);
  }

  /** Simulate the container dying on its own (crash, or the kernel OOM killer). */
  die(name: string, oomKilled = false): void {
    const container = this.containers.get(name);
    if (container !== undefined) {
      container.running = false;
      container.oomKilled = oomKilled;
    }
  }

  get running(): string[] {
    return [...this.containers.entries()].filter(([, c]) => c.running).map(([name]) => name);
  }
}
