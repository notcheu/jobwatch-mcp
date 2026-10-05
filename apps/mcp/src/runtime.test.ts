import { FakeBackend } from '@jobwatch/core';
import { SDK_API_VERSION, defineAdapter, defineBrowserTool, z, type AdapterModule } from '@jobwatch/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { installedFixtures, startTestServer, type TestServer } from './harness';

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;
const browserAdapter: AdapterModule = defineAdapter({
  id: 'browsery',
  displayName: 'Browsery',
  description: 'A browser adapter for the wiring tests.',
  sdkApi: SDK_API_VERSION,
  platform: 'browsery',
  kind: 'browser',
  allowedHosts: ['www.browsery.example.com'],
  tools: [
    defineBrowserTool({
      name: 'browsery_open',
      title: 'Open (read-only)',
      description: 'Opens a page. Read-only, no side effects.',
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }),
      annotations,
      limits: { timeoutS: 5, cost: 1, outputMaxBytes: 2048 },
      handler: async () => ({ data: { ok: true }, warnings: [] }),
    }),
  ],
});
/** No DevTools exists behind the fake backend's addresses, so tests that lease a browser replace the readiness hooks. */
const noHooks = { runtimeHooks: {} } as const;
const installed = { ...installedFixtures, browsery: async () => browserAdapter };

let server: TestServer;
afterEach(async () => {
  await server?.stop();
});

describe('browser runtime wiring', () => {
  it('does not create a runtime, or touch docker, when only HTTP adapters are enabled', async () => {
    const backend = new FakeBackend();
    server = await startTestServer({}, ['probe'], { installed, runtimeBackend: backend, ...noHooks });
    expect(server.running.runtime).toBeUndefined();
    expect(backend.calls).toEqual([]);
  });

  it('creates the runtime when a browser adapter is enabled, and removes orphans of a previous router at startup', async () => {
    const backend = new FakeBackend();
    backend.containers.set('jw-linkedin', { spec: {} as never, running: true, oomKilled: false });
    server = await startTestServer({}, ['browsery'], { installed, runtimeBackend: backend, ...noHooks });
    expect(server.running.runtime).toBeDefined();
    expect(backend.calls).toContain('remove:jw-linkedin');
    expect(backend.containers.size).toBe(0);
    expect(server.logs()).toContain('orphans_reaped');
    expect(server.running.runtime?.status()).toEqual({ current: undefined, waiting: 0 });
  });

  it('starts nothing at startup: tools/list stays free of containers', async () => {
    const backend = new FakeBackend();
    server = await startTestServer({}, ['browsery'], { installed, runtimeBackend: backend, ...noHooks });
    expect(backend.calls.filter((c) => c.startsWith('start'))).toEqual([]);
  });

  it('stops the running browser on shutdown', async () => {
    const backend = new FakeBackend();
    server = await startTestServer({}, ['browsery'], { installed, runtimeBackend: backend, ...noHooks });
    const lease = await server.running.runtime?.lease('browsery');
    expect(backend.running).toEqual(['jw-browsery']);
    await server.stop();
    expect(backend.running).toEqual([]);
    await lease?.release();
  });

  it('comes up even when docker is unreachable, logging the problem', async () => {
    const broken = new FakeBackend();
    broken.listManaged = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
    server = await startTestServer({}, ['browsery'], { installed, runtimeBackend: broken });
    expect(server.logs()).toContain('orphan_reap_failed');
    expect((await fetch(new URL('/healthz', server.url))).status).toBe(200);
  });

  it('passes the configured image, network and seccomp profile to the runtime', async () => {
    const backend = new FakeBackend();
    server = await startTestServer(
      {
        BROWSER_IMAGE: 'registry.example.com/jobwatch-browser:154',
        BROWSER_NETWORK: 'my-net',
        BROWSER_SECCOMP: '/etc/jobwatch/seccomp.json',
        BROWSER_PROFILE_VOLUME_PREFIX: 'prof-',
      },
      ['browsery'],
      { installed, runtimeBackend: backend, ...noHooks },
    );
    await (await server.running.runtime?.lease('browsery'))?.release();
    expect(backend.containers.get('jw-browsery')?.spec).toMatchObject({
      image: 'registry.example.com/jobwatch-browser:154',
      network: 'my-net',
      seccompProfile: '/etc/jobwatch/seccomp.json',
      profileVolume: 'prof-browsery',
      memoryMb: 1500,
    });
  });

  it('feeds runtime events into the metrics', async () => {
    const backend = new FakeBackend();
    server = await startTestServer({ METRICS_ENABLED: 'true' }, ['browsery'], { installed, runtimeBackend: backend, ...noHooks });
    const lease = await server.running.runtime?.lease('browsery');
    let text = await (await fetch(server.metricsUrl as URL)).text();
    expect(text).toContain('jw_runtime_state{platform="browsery",state="busy"} 1');
    expect(text).toContain('jw_runtime_cold_starts_total{platform="browsery"} 1');
    await lease?.release();
    text = await (await fetch(server.metricsUrl as URL)).text();
    expect(text).toContain('jw_runtime_state{platform="browsery",state="idle_grace"} 1');
  });
});

describe('browser tools end to end through the real provider (fake CDP)', () => {
  it('runs a browser tool: lease, connect by IP, handler, park, release; recorded and counted', async () => {
    const backend = new FakeBackend();
    const steps: string[] = [];
    const connection = {
      session: {
        goto: async () => undefined,
        evaluate: (async () => undefined) as never,
        waitForSelector: async () => true,
        text: async () => null,
        url: () => 'about:blank',
        maxTabs: 1,
        openTab: async () => Promise.reject(new Error('one tab')),
      },
      park: async () => void steps.push('park'),
      keepSessionCookies: async () => 0,
      shedMemory: async () => undefined,
      quit: async () => undefined,
      disconnect: async () => void steps.push('disconnect'),
    };
    const seen: string[] = [];
    server = await startTestServer({ METRICS_ENABLED: 'true' }, ['browsery'], {
      installed,
      runtimeBackend: backend,
      ...noHooks,
      contexts: undefined, // use the real provider; only the CDP connection is faked
      connectBrowser: async (address, hosts) => (seen.push(`${address} ${hosts.join(',')}`), connection),
    });
    const { connectClient } = await import('./harness');
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'browsery_open', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(seen).toEqual([expect.stringMatching(/^172\.18\.0\.\d+ www\.browsery\.example\.com$/)]);
    expect(steps).toEqual(['park', 'disconnect']);
    expect(server.running.runtime?.status().current?.state).toBe('idle_grace');
    expect(server.running.store.recentCalls(1)[0]).toMatchObject({ tool: 'browsery_open', outcome: 'ok', platform: 'browsery' });
    expect(await (await fetch(server.metricsUrl as URL)).text()).toContain(
      'jw_tool_calls_total{tool="browsery_open",platform="browsery",result="ok"} 1',
    );
    await client.close();
  });

  it('passes the browser language settings to the container and the fingerprint expectation', async () => {
    const backend = new FakeBackend();
    server = await startTestServer({ BROWSER_LANG: 'sv-SE', BROWSER_ACCEPT_LANGS: 'fr-FR,en-GB,sv-SE' }, ['browsery'], {
      installed,
      runtimeBackend: backend,
      ...noHooks,
    });
    await (await server.running.runtime?.lease('browsery'))?.release();
    expect(backend.containers.get('jw-browsery')?.spec.env).toEqual({ CHROME_LANG: 'sv-SE', ACCEPT_LANGS: 'fr-FR,en-GB,sv-SE' });
  });
});
