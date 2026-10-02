import { request } from 'node:http';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runs } from './fixtures';
import { connectClient, startTestServer, type TestServer } from './harness';

let server: TestServer;
beforeEach(() => {
  runs.count = 0;
});
afterEach(async () => {
  await server?.stop();
});

const SECRET = 'AQEDAR-SUPER-SECRET';
const post = (url: URL, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Raw request, to control the Host header (fetch forbids it). */
const rawRequest = (url: URL, headers: Record<string, string | undefined>, body = '{}'): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('health and surface', () => {
  it('answers /healthz with only {"ok":true}', async () => {
    server = await startTestServer();
    const res = await fetch(new URL('/healthz', server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves nothing else: unknown paths are 404 and /metrics is not on the MCP port', async () => {
    server = await startTestServer({ JW_METRICS_ENABLED: 'true' });
    for (const path of ['/', '/metrics', '/admin', '/.env', '/mcp/extra']) {
      expect((await fetch(new URL(path, server.url))).status, path).toBe(404);
    }
  });

  it('does not advertise the framework', async () => {
    server = await startTestServer();
    expect((await fetch(new URL('/healthz', server.url))).headers.get('x-powered-by')).toBeNull();
  });

  it('refuses GET and DELETE on /mcp (stateless: no stream, no session to end)', async () => {
    server = await startTestServer();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(server.url, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('request hygiene', () => {
  it('answers malformed JSON with a JSON-RPC parse error, not a stack trace', async () => {
    server = await startTestServer();
    const res = await post(server.url, '{oops');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  });

  it('rejects a body over 256 KB', async () => {
    server = await startTestServer();
    const res = await post(
      server.url,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(300_000) } }),
    );
    expect(res.status).toBe(413);
  });

  it('is stateless: no session id is ever issued, and independent clients do not share anything', async () => {
    server = await startTestServer();
    const res = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
    expect((await a.listTools()).tools).toHaveLength(9); // 4 fixture tools + 5 built-in ops tools
    expect((await b.listTools()).tools).toHaveLength(9);
    await a.close();
    await b.close();
  });
});

describe('tools/list', () => {
  it('lists exactly the enabled adapters tools with strict schemas and read-only annotations', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'session_status',
      'memory_report',
      'stored_jobs',
      'stored_searches',
      'stored_job_texts',
      'probe_echo',
      'probe_login',
      'probe_crash',
      'other_ping',
    ]); // built-ins first
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(tools.find((tool) => tool.name === 'probe_echo')?.inputSchema).toMatchObject({
      properties: { word: { type: 'string', maxLength: 30 } },
      required: ['word'],
    });
    await client.close();
  });

  it('exposes nothing about hosts, platforms or limits', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    // the ops tools legitimately talk about platforms in their own schema; the fixture adapters' tools must not leak anything
    const text = JSON.stringify(
      (await client.listTools()).tools.filter(
        (tool) => !['session_status', 'memory_report', 'stored_jobs', 'stored_searches', 'stored_job_texts'].includes(tool.name),
      ),
    );
    for (const secret of ['api.probe.example.com', 'allowedHosts', 'platform', 'timeoutS', 'outputMaxBytes'])
      expect(text).not.toContain(secret);
    await client.close();
  });

  it('hides a disabled adapter completely', async () => {
    server = await startTestServer({}, ['other']);
    const client = await connectClient(server.url);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'session_status',
      'memory_report',
      'stored_jobs',
      'stored_searches',
      'stored_job_texts',
      'other_ping',
    ]);
    await expect(client.callTool({ name: 'probe_echo', arguments: { word: 'x' } })).rejects.toBeInstanceOf(McpError);
    await client.close();
  });

  it('is empty when nothing is enabled', async () => {
    server = await startTestServer({}, []);
    const client = await connectClient(server.url);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'session_status',
      'memory_report',
      'stored_jobs',
      'stored_searches',
      'stored_job_texts',
    ]); // only the built-in ops tools
    await client.close();
  });

  it('never runs a handler', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    await client.listTools();
    await client.listTools();
    expect(runs.count).toBe(0);
    await client.close();
  });
});

describe('tools/call over HTTP', () => {
  it('returns structured content that satisfies the output schema (validated by the real client)', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    await client.listTools(); // the client caches output schemas and validates structuredContent against them
    const result = await client.callTool({ name: 'probe_echo', arguments: { word: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ echoed: 'hello' });
    expect(result.content).toEqual([{ type: 'text', text: '{"echoed":"hello"}\n\nWarnings:\n- example warning' }]);
    expect(result._meta).toMatchObject({ jobwatch: { adapter: 'probe', warnings: ['example warning'] } });
    await client.close();
  });

  it('reports invalid arguments as a tool error without echoing the values', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'probe_echo', arguments: { word: 'x'.repeat(31), extra: SECRET } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as { code: string };
    expect(body.code).toBe('invalid_arguments');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(runs.count).toBe(0);
    await client.close();
  });

  it('answers an unknown tool with a protocol error', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    await expect(client.callTool({ name: 'does_not_exist', arguments: {} })).rejects.toThrow(/Unknown tool: does_not_exist/);
    await client.close();
  });

  it('maps an adapter session error to needs_login', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'probe_login', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}')).toMatchObject({ code: 'needs_login' });
    await client.close();
  });

  it('never leaks the message of an unexpected error, but logs it', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'probe_crash', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('linkedin');
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}')).toMatchObject({
      code: 'internal',
      message: 'Internal error.',
    });
    expect(server.logs()).toContain('tool_call_failed');
    await client.close();
  });

  it('logs calls with an argument hash but never the arguments', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    await client.callTool({ name: 'probe_echo', arguments: { word: 'sensitive-keyword' } });
    expect(server.logs()).toContain('"msg":"tool_call"');
    expect(server.logs()).toMatch(/"args_hash":"[0-9a-f]{12}"/);
    expect(server.logs()).not.toContain('sensitive-keyword');
    await client.close();
  });
});

describe('authentication: JW_AUTH=front with a shared secret', () => {
  const SHARED = 'front-shared-secret-0123456789';
  const front = { JW_AUTH: 'front', JW_BASE_URL: 'https://mcp.example.com', JW_FRONT_SHARED_SECRET: SHARED };

  it('refuses a missing, malformed or wrong credential with 401', async () => {
    server = await startTestServer(front);
    const bad: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong-secret-of-another-length' },
      { authorization: `Bearer ${SHARED}x` },
      { authorization: SHARED },
      { authorization: `Basic ${SHARED}` },
      { authorization: 'Bearer ' },
    ];
    for (const headers of bad) {
      const res = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('accepts the right credential', async () => {
    server = await startTestServer(front);
    const client = await connectClient(server.url, { authorization: `Bearer ${SHARED}` });
    expect((await client.listTools()).tools).toHaveLength(9);
    await client.close();
  });

  it('keeps /healthz open without credentials', async () => {
    server = await startTestServer(front);
    expect((await fetch(new URL('/healthz', server.url))).status).toBe(200);
  });

  it('does not check the Host header in front mode (the front forwards its own)', async () => {
    server = await startTestServer(front);
    const res = await rawRequest(
      server.url,
      { host: 'router:8080', authorization: `Bearer ${SHARED}` },
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    );
    expect(res.status).not.toBe(403);
  });

  it('starts in front mode WITHOUT a shared secret (network isolation) and warns about it', async () => {
    server = await startTestServer({ JW_AUTH: 'front', JW_BASE_URL: 'https://mcp.example.com' });
    expect(server.logs()).toContain('JW_FRONT_SHARED_SECRET is not set');
    expect((await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  });
});

describe('authentication: JW_AUTH=none (local development)', () => {
  it('refuses a foreign Host header (DNS rebinding) and accepts the loopback host', async () => {
    server = await startTestServer();
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    for (const host of ['evil.example.com', 'evil.example.com:80', '127.0.0.1.evil.com', 'localhost']) {
      expect((await rawRequest(server.url, { host }, body)).status, host).toBe(403);
    }
    expect(
      (await rawRequest(server.url, { host: `127.0.0.1:${server.url.port}`, accept: 'application/json, text/event-stream' }, body)).status,
    ).toBe(200);
  });

  it('warns loudly at startup', async () => {
    server = await startTestServer();
    expect(server.logs()).toContain('JW_AUTH=none: no authentication');
  });
});

describe('metrics listener', () => {
  it('is off by default', async () => {
    server = await startTestServer();
    expect(server.metricsUrl).toBeUndefined();
  });

  it('serves Prometheus text on its own port and counts calls, without arguments or ids', async () => {
    server = await startTestServer({ JW_METRICS_ENABLED: 'true' });
    const client = await connectClient(server.url);
    await client.callTool({ name: 'probe_echo', arguments: { word: 'secret-word' } });
    await client.callTool({ name: 'probe_login', arguments: {} });
    await client.close();
    const res = await fetch(server.metricsUrl as URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('jw_tool_calls_total{tool="probe_echo",platform="probe",result="ok"} 1');
    expect(text).toContain('jw_tool_calls_total{tool="probe_login",platform="probe",result="needs_login"} 1');
    expect(text).toContain('jw_enabled_adapters 2');
    expect(text).not.toContain('secret-word');
  });

  it('serves only GET /metrics', async () => {
    server = await startTestServer({ JW_METRICS_ENABLED: 'true' });
    const base = server.metricsUrl as URL;
    expect((await fetch(new URL('/', base))).status).toBe(404);
    expect((await fetch(base, { method: 'POST' })).status).toBe(404);
  });
});

describe('lifecycle', () => {
  it('fails to start when an enabled adapter is not installed', async () => {
    await expect(startTestServer({}, ['probe', 'ghost'])).rejects.toThrow(/"ghost" is enabled but not installed/);
  });

  it('fails to start with an invalid configuration, listing the problem', async () => {
    await expect(startTestServer({ JW_PORT: 'abc' })).rejects.toThrow(/JW_PORT/);
  });

  it('can be closed twice (two shutdown signals) without error', async () => {
    server = await startTestServer();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stops listening on close', async () => {
    server = await startTestServer();
    const url = new URL('/healthz', server.url);
    await server.stop();
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe('built-in ops tools over MCP', () => {
  it('memory_report answers over HTTP even when no adapter is enabled, and is recorded and metered', async () => {
    server = await startTestServer({ JW_METRICS_ENABLED: 'true' }, []);
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'memory_report', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ runtime: { enabled: false, state: 'cold' }, platforms: [] });
    expect(server.running.store.recentCalls(1)[0]).toMatchObject({ tool: 'memory_report', platform: 'ops', outcome: 'ok' });
    expect(await (await fetch(server.metricsUrl as URL)).text()).toContain(
      'jw_tool_calls_total{tool="memory_report",platform="ops",result="ok"} 1',
    );
    await client.close();
  });

  it('session_status says which platforms it knows when asked for one that does not exist', async () => {
    server = await startTestServer();
    const client = await connectClient(server.url);
    const result = await client.callTool({ name: 'session_status', arguments: { platform: 'linkedin' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}')).toMatchObject({ code: 'invalid_arguments' });
    await client.close();
  });

  it('the ops tools are not counted as enabled adapters', async () => {
    server = await startTestServer({ JW_METRICS_ENABLED: 'true' }, ['probe']);
    expect(await (await fetch(server.metricsUrl as URL)).text()).toContain('jw_enabled_adapters 1');
  });
});
