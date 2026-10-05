import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackendError, type RuntimeSpec } from './backend';
import { LocalBackend, findChrome } from './localBackend';

describe('findChrome', () => {
  it('looks in the usual places of each system', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findChrome('darwin', {}, (path) => path === mac)).toBe(mac);
    expect(findChrome('linux', { PATH: '/usr/local/bin:/usr/bin' }, (path) => path === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(findChrome('win32', { PROGRAMFILES: 'C:\\Program Files' }, () => true)).toContain('chrome.exe');
    expect(findChrome('linux', { PATH: '/usr/bin' }, () => false)).toBeUndefined();
  });
});

describe('LocalBackend', () => {
  let dir: string;
  const spec = { platform: 'linkedin', name: 'jw-linkedin', profileVolume: 'jw-profile-linkedin' } as RuntimeSpec;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jw-local-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in for Chrome: reads --user-data-dir, writes DevToolsActivePort like Chrome does, then stays alive. */
  async function fakeChrome(script: string): Promise<string> {
    const path = join(dir, 'chrome.sh');
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }
  const writePort =
    'for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#--user-data-dir=}";; esac; done\nprintf "9333\\n/devtools/browser/x" > "$d/DevToolsActivePort"\nexec sleep 30';

  it('starts Chrome on its own profile directory, reads the port it picked, and stops it', async () => {
    const backend = new LocalBackend({ executable: await fakeChrome(writePort), profilesDir: join(dir, 'profiles') });
    const handle = await backend.start(spec);
    expect(handle.address).toBe('127.0.0.1:9333');
    expect((await backend.inspect(handle)).running).toBe(true);
    await backend.stop(handle, 2);
    expect((await backend.inspect(handle)).running).toBe(false);
  });

  it('explains when Chrome exits at once (profile already in use)', async () => {
    const backend = new LocalBackend({ executable: await fakeChrome('exit 0'), profilesDir: join(dir, 'profiles') });
    await expect(backend.start(spec)).rejects.toThrow('exited at once');
  });

  it('says so when there is no Chrome', async () => {
    const backend = new LocalBackend({ executable: join(dir, 'missing'), profilesDir: join(dir, 'profiles') });
    await expect(backend.start(spec)).rejects.toThrow(BackendError);
    await expect(backend.start(spec)).rejects.toThrow('BROWSER_LOCAL_CHROME_PATH');
  });
});
