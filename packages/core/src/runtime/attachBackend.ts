import { BackendError, type ContainerState, type RuntimeBackend, type RuntimeHandle, type RuntimeSpec } from './backend';

/**
 * A Chrome that is already running and that somebody else owns (`JW_CDP_URL`). There is nothing to start, stop or
 * measure: `start` only checks that DevTools answers, `stop` leaves the browser alone (never quits it), and no memory cap
 * applies. The browser layer opens its own tab in it and never touches the others (`connectBrowser`, `shared: true`).
 */
export class AttachBackend implements RuntimeBackend {
  constructor(
    /** `ip:port` of the DevTools of the running Chrome. */
    private readonly address: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    if (!(await this.answers())) {
      throw new BackendError(
        `No Chrome answers on ${this.address}. Start it with --remote-debugging-port=${this.address.split(':')[1] ?? '9222'} and its own --user-data-dir.`,
      );
    }
    return { name: spec.name, platform: spec.platform, address: this.address };
  }

  async stop(): Promise<void> {
    // The browser is not ours.
  }

  async inspect(): Promise<ContainerState> {
    return { running: await this.answers(), oomKilled: false, exitCode: null };
  }

  async memoryBytes(): Promise<number> {
    return 0;
  }

  async listManaged(): Promise<string[]> {
    return [];
  }

  async remove(): Promise<void> {
    // Nothing of ours to remove.
  }

  private async answers(): Promise<boolean> {
    try {
      const response = await this.doFetch(`http://${this.address}/json/version`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
