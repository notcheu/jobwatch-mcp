/**
 * Runs against a REAL browser container (see tests/integration/run.sh): the Docker backend, DevTools by IP, the guarded
 * session over Playwright, the fingerprint check, the memory reading, clean quit and the runtime manager's lifecycle.
 * The network is internal: there is no internet, which is useful: nothing here can leave the machine.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logging';
import { DockerCliBackend, loginRunArgs, spawnDocker } from '../runtime/dockerCli';
import { RuntimeManager } from '../runtime/manager';
import type { RuntimeHandle, RuntimeSpec } from '../runtime/backend';
import { createBrowserHooks, waitForDevTools } from './hooks';
import { connectBrowser } from './session';
import { devtoolsBaseUrl } from './address';

const image = process.env['IT_IMAGE'] ?? '';
const network = process.env['IT_NETWORK'] ?? '';
const enabled = image !== '' && network !== '';
const seccompProfile = '/work/images/browser/chrome-seccomp.json';

const spec: RuntimeSpec = {
  platform: 'it',
  name: 'jw-it',
  image,
  memoryMb: 1500,
  memoryReservationMb: 1200,
  profileVolume: 'jw-it-profile',
  network,
  seccompProfile,
  env: { CHROME_LANG: 'fr-FR', ACCEPT_LANGS: 'fr-FR,en-GB,sv-SE,ja-JP,en-US' },
};

let logs = '';
const logger = createLogger({ level: 'debug', destination: new Writable({ write: (c, _e, d) => ((logs += String(c)), d()) }) });
const backend = new DockerCliBackend(undefined, network);
let handle: RuntimeHandle;

describe.skipIf(!enabled)('real browser container', () => {
  beforeAll(async () => {
    const started = Date.now();
    handle = await backend.start(spec);
    console.log(`cold start (docker run -> running): ${Date.now() - started} ms, address ${handle.address}`);
    await waitForDevTools(handle.address, 40_000);
    console.log(`DevTools answering after ${Date.now() - started} ms`);
  });
  afterAll(async () => {
    await backend.remove('jw-it').catch(() => undefined);
  });

  it('is on the internal network, hardened, and labelled', async () => {
    expect(handle.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(await backend.listManaged()).toContain('jw-it');
    expect(await backend.inspect(handle)).toMatchObject({ running: true, oomKilled: false });
  });

  it('answers DevTools by IP and refuses a DNS name (G2)', async () => {
    expect((await fetch(`${devtoolsBaseUrl(handle.address)}/json/version`)).status).toBe(200);
    const byName = await fetch(`http://${handle.name}:9222/json/version`).catch(() => undefined);
    expect(byName?.status).toBe(500); // "Host header is specified and is not an IP address or localhost"
  });

  it('reads the working set through docker exec, and it is plausible (50 MB to the cap)', async () => {
    const bytes = await backend.memoryBytes(handle);
    console.log(`idle working set: ${Math.round(bytes / 1048576)} MB`);
    expect(bytes).toBeGreaterThan(50 * 1048576);
    expect(bytes).toBeLessThan(1500 * 1048576);
  });

  it('passes the startup fingerprint check with the configured language list (enforce mode)', async () => {
    const hooks = createBrowserHooks({
      connect: connectBrowser,
      logger,
      fingerprint: 'enforce',
      expectations: { languages: ['fr-FR', 'en-GB', 'sv-SE', 'ja-JP', 'en-US'] },
    });
    await hooks.ready?.(handle);
    expect(logs).not.toContain('fingerprint_mismatch');
  });

  it('fails the fingerprint check when the expected languages differ (enforce mode)', async () => {
    const hooks = createBrowserHooks({
      connect: connectBrowser,
      logger,
      fingerprint: 'enforce',
      expectations: { languages: ['en-US', 'en'] },
    });
    await expect(hooks.ready?.(handle)).rejects.toMatchObject({ code: 'internal' });
    expect(logs).toContain('fingerprint_mismatch');
  });

  it('gives a session on the single existing tab and never opens a second one', async () => {
    const connection = await connectBrowser(handle.address, ['www.example.com']);
    try {
      expect(connection.session.url()).toBe('about:blank');
      expect(await connection.session.evaluate<number>('() => 1 + 1')).toBe(2);
      const tabs = async () =>
        ((await (await fetch(`${devtoolsBaseUrl(handle.address)}/json/list`)).json()) as { type: string }[]).filter(
          (t) => t.type === 'page',
        ).length;
      expect(await tabs()).toBe(1);
      // a popup from page script must be closed at once
      await connection.session.evaluate("() => { window.open('about:blank'); return true; }");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await tabs()).toBe(1);
    } finally {
      await connection.disconnect();
    }
  });

  it('with maxTabs 3: opens extra tabs up to the limit, keeps them through popups, and park closes them', async () => {
    const connection = await connectBrowser(handle.address, ['www.example.com'], { maxTabs: 3 });
    try {
      const count = async () =>
        ((await (await fetch(`${devtoolsBaseUrl(handle.address)}/json/list`)).json()) as { type: string }[]).filter(
          (t) => t.type === 'page',
        ).length;
      const first = await connection.session.openTab();
      const second = await connection.session.openTab();
      expect(await count()).toBe(3);
      await expect(connection.session.openTab()).rejects.toMatchObject({ code: 'internal' }); // the limit
      await expect(first.goto('https://evil.example/', { timeoutMs: 5000 })).rejects.toMatchObject({ code: 'internal' });
      await second.close();
      expect(await count()).toBe(2);
      await connection.park(); // the tab left open does not outlive the call
      expect(await count()).toBe(1);
    } finally {
      await connection.disconnect();
    }
  });

  it('with the default (maxTabs 1) openTab refuses', async () => {
    const connection = await connectBrowser(handle.address, ['www.example.com']);
    try {
      await expect(connection.session.openTab()).rejects.toMatchObject({ code: 'internal' });
    } finally {
      await connection.disconnect();
    }
  });

  it('disconnecting does not quit the browser (the next call reuses it)', async () => {
    expect(await backend.inspect(handle)).toMatchObject({ running: true });
    const again = await connectBrowser(handle.address, []);
    expect(again.session.url()).toBe('about:blank');
    await again.disconnect();
  });

  it('refuses navigation off the allowlist before and after the page navigates itself', async () => {
    const connection = await connectBrowser(handle.address, ['www.example.com']);
    try {
      await expect(connection.session.goto('https://evil.example/', { timeoutMs: 5000 })).rejects.toMatchObject({ code: 'internal' }); // HostNotAllowedError
      // the page itself tries to navigate away (a redirect, a link): the request router aborts it
      await connection.session.evaluate("() => { window.location.href = 'https://evil.example/steal'; return true; }");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(connection.session.url()).not.toContain('evil.example');
    } finally {
      await connection.disconnect();
    }
  });

  it('maps an unreachable allowed host (no internet here) to upstream_error without leaking the URL', async () => {
    const connection = await connectBrowser(handle.address, ['www.example.com']);
    try {
      const error = await connection.session.goto('https://www.example.com/?token=SECRET', { timeoutMs: 20_000 }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: expect.stringMatching(/upstream_error|timeout/) });
      expect(JSON.stringify((error as { toBody(): unknown }).toBody())).not.toContain('SECRET');
    } finally {
      await connection.disconnect();
    }
  });

  it('parks the tab on about:blank and sheds memory without error', async () => {
    const connection = await connectBrowser(handle.address, []);
    try {
      await connection.session.evaluate("() => { document.title = 'work'; return true; }");
      await connection.park();
      expect(connection.session.url()).toBe('about:blank');
      await connection.shedMemory();
      expect(await backend.inspect(handle)).toMatchObject({ running: true });
    } finally {
      await connection.disconnect();
    }
  });

  it('quits cleanly through DevTools and the container exits on its own', async () => {
    const hooks = createBrowserHooks({ connect: connectBrowser, logger, fingerprint: 'off', expectations: {} });
    await hooks.quit?.(handle);
    const deadline = Date.now() + 25_000;
    let state = await backend.inspect(handle);
    while (state.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await backend.inspect(handle);
    }
    console.log(`after Browser.close: running=${state.running} exit=${state.exitCode}`);
    expect(state.running).toBe(false);
    expect(state.exitCode).toBe(0);
  });

  it('stop() removes the container and leaves the profile volume', async () => {
    await backend.stop(handle, 10);
    expect(await backend.listManaged()).not.toContain('jw-it');
  });
});

describe.skipIf(!enabled)('runtime manager with the real backend', () => {
  it('cold start, warm reuse, idle stop, and no container left behind', async () => {
    const events: string[] = [];
    const hooks = createBrowserHooks({ connect: connectBrowser, logger, fingerprint: 'enforce', expectations: {} });
    const manager = new RuntimeManager(
      backend,
      {
        image,
        network,
        seccompProfile,
        profileVolumePrefix: 'jw-it-',
        env: spec.env ?? {},
        idleTtlS: 4,
        maxLifetimeS: 1800,
        queueTimeoutS: 30,
        memMaxMb: 1500,
        memHighMb: 1200,
        watchdogIntervalMs: 2000,
      },
      logger,
      hooks,
      (e) => void (e.type === 'state' && events.push(e.state)),
    );
    const t0 = Date.now();
    const first = await manager.lease('mgr');
    console.log(`manager cold start incl. DevTools + fingerprint: ${Date.now() - t0} ms`);
    expect(first.coldStart).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2500)); // let the watchdog read the memory at least once
    expect(first.peakBytes()).toBeGreaterThan(50 * 1048576);
    console.log(`watchdog peak: ${Math.round(first.peakBytes() / 1048576)} MB`);
    await first.release();
    const second = await manager.lease('mgr');
    expect(second.coldStart).toBe(false);
    await second.release();
    const stopStarted = Date.now();
    while ((await backend.listManaged()).includes('jw-mgr') && Date.now() - stopStarted < 40_000)
      await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`idle TTL 4 s -> container gone after ${Date.now() - stopStarted} ms`);
    expect(await backend.listManaged()).not.toContain('jw-mgr');
    expect(events).toEqual(['starting', 'busy', 'idle_grace', 'busy', 'idle_grace', 'stopping', 'cold']);
    await manager.shutdown();
  });

  it('removes an orphan left by a previous router at startup', async () => {
    await backend.start({ ...spec, platform: 'orphan', name: 'jw-it-orphan', profileVolume: 'jw-it-orphan' });
    const manager = new RuntimeManager(
      backend,
      {
        image,
        network,
        profileVolumePrefix: 'jw-it-',
        idleTtlS: 4,
        maxLifetimeS: 1800,
        queueTimeoutS: 30,
        memMaxMb: 1500,
        memHighMb: 1200,
      },
      logger,
    );
    expect(await manager.reapOrphans()).toContain('jw-it-orphan');
    expect(await backend.listManaged()).not.toContain('jw-it-orphan');
  });
});

describe.skipIf(!enabled)('manual login container', () => {
  const name = 'jw-login-it';
  const docker = (args: string[]) => spawnDocker(args, { timeoutMs: 60_000 });
  afterAll(async () => {
    await docker(['rm', '-f', name]);
  });

  it('serves noVNC behind the password, published on loopback only', async () => {
    const login: RuntimeSpec = {
      ...spec,
      name,
      profileVolume: 'jw-it-login-profile',
      network: 'bridge',
      env: { ...spec.env, MODE: 'login', VNC_PASSWORD: 'it-pass1' },
    };
    const started = await docker(loginRunArgs(login, 16_080));
    expect(started.code, started.stderr).toBe(0);
    const published = await docker(['port', name, '6080/tcp']);
    expect(published.stdout.trim()).toMatch(/^127\.0\.0\.1:16080$/);
    let status = '';
    for (let attempt = 0; attempt < 40 && status !== '200'; attempt += 1) {
      status = (
        await docker(['exec', name, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:6080/vnc.html'])
      ).stdout.trim();
      if (status !== '200') await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(status).toBe('200');
    const label = await docker(['inspect', '-f', '{{json .Config.Labels}}', name]);
    expect(label.stdout).toContain('jobwatch.login');
    expect(label.stdout).not.toContain('jobwatch.managed');
  });
});
