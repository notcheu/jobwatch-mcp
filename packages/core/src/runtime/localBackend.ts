import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { BackendError, type ContainerState, type RuntimeBackend, type RuntimeHandle, type RuntimeSpec } from './backend';

const PORT_FILE = 'DevToolsActivePort';

const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** Where Chrome usually lives. `exists` is injected so the tests need no browser. */
export function findChrome(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates: string[] = [];
  if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium']) candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']])
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean))
      for (const name of LINUX_NAMES) candidates.push(join(dir, name));
  }
  return candidates.find(exists);
}

export interface LocalBackendOptions {
  /** Chrome executable (`JW_LOCAL_CHROME_PATH`); unset = `findChrome`. */
  executable?: string;
  /** Directory holding one Chrome profile per platform, so a sign-in survives a restart. */
  profilesDir: string;
  startTimeoutMs?: number;
}

/**
 * Chrome started on this machine, headful, the way Playwright starts its own: `--remote-debugging-port=0` (Chrome picks a free
 * port and writes it to `DevToolsActivePort` in the profile directory), then the browser layer attaches over DevTools. One profile
 * directory per platform. Nothing is isolated or capped here: this is for development on your own machine.
 */
export class LocalBackend implements RuntimeBackend {
  private readonly children = new Map<string, ChildProcess>();

  constructor(private readonly options: LocalBackendOptions) {}

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const executable = this.options.executable ?? findChrome(process.platform, process.env);
    if (executable === undefined || !existsSync(executable))
      throw new BackendError('Chrome was not found. Install it or set JW_LOCAL_CHROME_PATH to its executable.');
    await this.remove(spec.name);
    const profile = join(this.options.profilesDir, spec.profileVolume);
    await mkdir(profile, { recursive: true });
    await rm(join(profile, PORT_FILE), { force: true }); // a stale file from a previous run would name a dead port

    const child = spawn(
      executable,
      ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
      { stdio: 'ignore' },
    );
    this.children.set(spec.name, child);
    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', (cause) => reject(new BackendError(`cannot run Chrome: ${cause.message}`, { cause })));
      child.once('exit', () =>
        reject(
          new BackendError('Chrome exited at once. Is another Chrome already using this profile directory? Close it, or use JW_CDP_URL.'),
        ),
      );
    });
    exited.catch(() => undefined); // handled by the race below; this keeps a late exit (after start) from being unhandled

    try {
      const port = await Promise.race([this.waitForPort(profile), exited]);
      return { name: spec.name, platform: spec.platform, address: `127.0.0.1:${port}` };
    } catch (error) {
      await this.remove(spec.name);
      throw error;
    }
  }

  async stop(handle: RuntimeHandle, graceS: number): Promise<void> {
    const child = this.children.get(handle.name);
    this.children.delete(handle.name);
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), graceS * 1000);
    await gone;
    clearTimeout(timer);
  }

  async inspect(handle: RuntimeHandle): Promise<ContainerState> {
    const child = this.children.get(handle.name);
    const running = child !== undefined && child.exitCode === null && child.signalCode === null;
    return { running, oomKilled: false, exitCode: child?.exitCode ?? null };
  }

  async memoryBytes(): Promise<number> {
    return 0;
  }

  async listManaged(): Promise<string[]> {
    return [];
  }

  async remove(name: string): Promise<void> {
    const child = this.children.get(name);
    this.children.delete(name);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  private async waitForPort(profile: string): Promise<number> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 20_000);
    for (;;) {
      try {
        const port = Number((await readFile(join(profile, PORT_FILE), 'utf8')).split('\n')[0]);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {
        // not written yet
      }
      if (Date.now() >= deadline) throw new BackendError('Chrome did not open its DevTools port in time');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
