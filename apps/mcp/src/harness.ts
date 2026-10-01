import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { InstalledAdapters } from '@jobwatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, type RunningServer } from './server';
import { fakeContexts, other, probe } from './fixtures';

export const installedFixtures: InstalledAdapters = { probe: async () => probe, other: async () => other };

export interface TestServer {
  running: RunningServer;
  url: URL;
  metricsUrl: URL | undefined;
  logs: () => string;
  stop: () => Promise<void>;
}

/** Start the real server on free ports with the fixture adapters. `env` overrides the defaults (loopback, no auth). */
export async function startTestServer(env: Record<string, string> = {}, enabled: string[] = ['probe', 'other']): Promise<TestServer> {
  let buffer = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      buffer += String(chunk);
      done();
    },
  });
  const merged = {
    JW_BASE_URL: 'http://127.0.0.1:18999',
    JW_AUTH: 'none',
    JW_LISTEN_HOST: '127.0.0.1',
    JW_ADAPTERS: enabled.join(','),
    JW_DATA_DIR: '/nonexistent-never-read',
    ...env,
  };
  const running = await start({
    env: merged,
    version: 'test',
    installed: installedFixtures,
    contexts: fakeContexts,
    logDestination: sink,
    port: 0,
    metricsPort: 0,
  });
  const address = running.mcp.address() as AddressInfo;
  const metricsAddress = running.metrics?.address() as AddressInfo | null | undefined;
  return {
    running,
    // The URL host must match JW_BASE_URL's hostname for JW_AUTH=none (Host header guard), so use the same literal.
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    metricsUrl: metricsAddress ? new URL(`http://127.0.0.1:${metricsAddress.port}/metrics`) : undefined,
    logs: () => buffer,
    stop: () => running.close(1000),
  };
}

export async function connectClient(url: URL, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}
