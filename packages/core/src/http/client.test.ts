import { AdapterBroken, HostNotAllowedError, JobwatchError, UpstreamError, z } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from './client';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A scripted fetch: answers by call index, records what was sent. */
function script(...responses: (Response | Error | ((seen: Seen) => Response))[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const record: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
    };
    seen.push(record);
    const next = responses[seen.length - 1] ?? new Response('{}');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(record) : next;
  }) as typeof fetch;
  return { fetch: fn, seen };
}
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const hosts = ['api.example.com', 'www.example.com'];
const client = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) =>
  createHttpClient({ allowedHosts: hosts, fetch: fetchFn, minHostIntervalMs: 0, ...extra });

describe('requests', () => {
  it('GETs and POSTs JSON, with an honest user agent and no cookies', async () => {
    const s = script(json({ a: 1 }), json({ b: 2 }));
    const http = client(s.fetch);
    expect((await http.get('https://api.example.com/x')).status).toBe(200);
    const posted = await http.postJson('https://api.example.com/search', { q: 'react' });
    expect(posted.json(z.object({ b: z.number() }))).toEqual({ b: 2 });
    expect(s.seen[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: { 'user-agent': expect.stringContaining('jobwatch-mcp') },
    });
    expect(s.seen[1]).toMatchObject({ method: 'POST', body: '{"q":"react"}', headers: { 'content-type': 'application/json' } });
    expect(Object.keys(s.seen[0]?.headers ?? {})).not.toContain('cookie');
  });

  it('returns non-2xx responses to the adapter (it decides), with ok false', async () => {
    const response = await client(script(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })).fetch).get(
      'https://api.example.com/x',
    );
    expect(response).toMatchObject({ status: 429, ok: false, text: 'slow down', headers: { 'retry-after': '30' } });
  });

  it('lets an adapter add harmless headers, lower-cased', async () => {
    const s = script(json({}));
    await client(s.fetch).get('https://api.example.com/x', { headers: { 'X-Api-Version': '2' } });
    expect(s.seen[0]?.headers['x-api-version']).toBe('2');
  });
});

describe('host allowlist', () => {
  it('refuses a host that is not allowed, before any network call', async () => {
    const s = script();
    for (const url of [
      'https://evil.example/x',
      'http://api.example.com/x',
      'https://api.example.com.evil.com/x',
      'https://user@api.example.com/x',
      'https://api.example.com:8443/x',
      'https://127.0.0.1/x',
      'not a url',
    ]) {
      await expect(client(s.fetch).get(url), url).rejects.toBeInstanceOf(HostNotAllowedError);
    }
    expect(s.seen).toEqual([]);
  });

  it('follows a redirect inside the allowlist', async () => {
    const s = script(redirect('https://www.example.com/final'), json({ ok: true }));
    const response = await client(s.fetch).get('https://api.example.com/start');
    expect(response.status).toBe(200);
    expect(s.seen.map((x) => x.url)).toEqual(['https://api.example.com/start', 'https://www.example.com/final']);
  });

  it('resolves a relative redirect against the current URL', async () => {
    const s = script(redirect('/moved'), json({}));
    await client(s.fetch).get('https://api.example.com/start');
    expect(s.seen[1]?.url).toBe('https://api.example.com/moved');
  });

  it('REFUSES a redirect that leaves the allowlist, without requesting it', async () => {
    for (const target of [
      'https://evil.example/steal',
      'http://api.example.com/downgrade',
      'https://api.example.com.evil.com/',
      '//evil.example/x',
    ]) {
      const s = script(redirect(target));
      await expect(client(s.fetch).get('https://api.example.com/start'), target).rejects.toBeInstanceOf(HostNotAllowedError);
      expect(s.seen).toHaveLength(1);
    }
  });

  it('stops after too many redirects', async () => {
    const s = script(...Array.from({ length: 10 }, () => redirect('https://api.example.com/again')));
    await expect(client(s.fetch, { maxRedirects: 3 }).get('https://api.example.com/start')).rejects.toBeInstanceOf(UpstreamError);
    expect(s.seen).toHaveLength(4);
  });

  it('turns a POST into a GET on 302 (no body re-sent) but keeps it on 307', async () => {
    const a = script(redirect('https://api.example.com/next', 302), json({}));
    await client(a.fetch).postJson('https://api.example.com/x', { secret: 1 });
    expect(a.seen[1]).toMatchObject({ method: 'GET', body: undefined });
    expect(a.seen[1]?.headers['content-type']).toBeUndefined();
    const b = script(redirect('https://api.example.com/next', 307), json({}));
    await client(b.fetch).postJson('https://api.example.com/x', { secret: 1 });
    expect(b.seen[1]).toMatchObject({ method: 'POST', body: '{"secret":1}' });
  });
});

describe('headers adapters may not set', () => {
  it.each([
    'Cookie',
    'Authorization',
    'Host',
    'Proxy-Authorization',
    'Origin',
    'Content-Length',
    'Sec-Fetch-Mode',
    'Proxy-Connection',
    'Connection',
  ])('%s', async (name) => {
    const s = script();
    await expect(client(s.fetch).get('https://api.example.com/x', { headers: { [name]: 'x' } })).rejects.toMatchObject({
      code: 'internal',
    });
    expect(s.seen).toEqual([]);
  });

  it('refuses header injection through line breaks', async () => {
    await expect(
      client(script().fetch).get('https://api.example.com/x', { headers: { 'x-a': 'v\r\nCookie: stolen' } }),
    ).rejects.toBeInstanceOf(JobwatchError);
  });
});

describe('responses', () => {
  it('never exposes Set-Cookie', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'session=SECRET; HttpOnly');
    const response = await client(script(new Response('{}', { headers })).fetch).get('https://api.example.com/x');
    expect(JSON.stringify(response.headers)).not.toContain('SECRET');
    expect(Object.keys(response.headers)).not.toContain('set-cookie');
  });

  it('caps the body, both by declared length and by streaming', async () => {
    await expect(
      client(script(new Response('x', { headers: { 'content-length': '999999999' } })).fetch, { maxBodyBytes: 1000 }).get(
        'https://api.example.com/x',
      ),
    ).rejects.toBeInstanceOf(UpstreamError);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(400));
      },
    });
    await expect(client(script(new Response(stream)).fetch, { maxBodyBytes: 1000 }).get('https://api.example.com/x')).rejects.toThrow(
      /larger than/,
    );
  });

  it('accepts a body exactly at the cap', async () => {
    const response = await client(script(new Response('x'.repeat(1000))).fetch, { maxBodyBytes: 1000 }).get('https://api.example.com/x');
    expect(response.text).toHaveLength(1000);
  });

  it('json(): a changed shape or a non-JSON body is AdapterBroken, never an empty result', async () => {
    const shape = await client(script(json({ other: 1 })).fetch).get('https://api.example.com/x');
    expect(() => shape.json(z.object({ jobs: z.array(z.string()) }))).toThrow(AdapterBroken);
    const html = await client(script(new Response('<html>blocked</html>')).fetch).get('https://api.example.com/x');
    expect(() => html.json(z.unknown())).toThrow(AdapterBroken);
  });
});

describe('failures', () => {
  it('maps a timeout to the timeout code', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    await expect(client(script(timeout).fetch).get('https://api.example.com/x')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps a network error to upstream_error, keeping details out of the message', async () => {
    const error = await client(script(new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.5:443 token=SECRET')).fetch)
      .get('https://api.example.com/x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).toBe('The request to api.example.com failed.');
    expect(JSON.stringify((error as JobwatchError).toBody())).not.toContain('SECRET');
  });

  it('passes the timeout to fetch as an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fn = (async (_url: URL | string, init?: RequestInit) => ((signal = init?.signal ?? undefined), json({}))) as typeof fetch;
    await client(fn).get('https://api.example.com/x', { timeoutMs: 1234 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('politeness', () => {
  it('spaces requests to the same host and not to different hosts', async () => {
    let clock = 10_000;
    const slept: number[] = [];
    const http = client(script().fetch, {
      minHostIntervalMs: 500,
      now: () => clock,
      sleep: async (ms) => void (slept.push(ms), (clock += ms)),
    });
    await http.get('https://api.example.com/1');
    await http.get('https://api.example.com/2');
    await http.get('https://www.example.com/3');
    expect(slept).toEqual([500]);
  });

  it('queues concurrent requests to one host instead of bursting', async () => {
    const clock = 0;
    const slept: number[] = [];
    const http = client(script().fetch, { minHostIntervalMs: 300, now: () => clock, sleep: async (ms) => void slept.push(ms) });
    await Promise.all([1, 2, 3, 4].map((n) => http.get(`https://api.example.com/${n}`)));
    expect(slept).toEqual([300, 600, 900]);
  });

  it('limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fn = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return json({});
    }) as typeof fetch;
    const http = client(fn, { concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, (_v, n) => http.get(`https://api.example.com/${n}`)));
    expect(peak).toBe(2);
  });
});

describe('open https hosts', () => {
  const listed = ['*.teamtailor.com'];
  const resolver = (table: Record<string, string[]>) => async (hostname: string) => {
    const found = table[hostname];
    if (found === undefined) throw new Error('ENOTFOUND');
    return found;
  };
  const open = (fetchFn: typeof fetch, table: Record<string, string[]>, extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) =>
    client(fetchFn, { allowedHosts: listed, openHttps: true, resolve: resolver(table), ...extra });

  it('reaches a custom domain that resolves to public addresses, and tells the audit callback the host only', async () => {
    const s = script(json({ ok: true }));
    const seen: string[] = [];
    const response = await open(s.fetch, { 'careers.bsport.io': ['93.184.216.34'] }, { onOpenHost: (h) => seen.push(h) }).get(
      'https://careers.bsport.io/jobs?secret=1',
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(['careers.bsport.io']);
  });

  it('does not resolve or report a host that is listed (exact or wildcard)', async () => {
    const s = script(json({}));
    const seen: string[] = [];
    await open(s.fetch, {}, { onOpenHost: (h) => seen.push(h) }).get('https://bsport.teamtailor.com/jobs.rss');
    expect(seen).toEqual([]);
    expect(s.seen).toHaveLength(1);
  });

  it.each([
    ['a private address', ['192.168.1.10']],
    ['loopback', ['127.0.0.1']],
    ['the cloud metadata address', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['an IPv4-mapped private address', ['::ffff:10.0.0.5']],
    ['one public and one private address (DNS tricks)', ['93.184.216.34', '10.0.0.5']],
    ['no address at all', []],
  ])('refuses a name that resolves to %s, without sending anything', async (_name, addresses) => {
    const s = script(json({}));
    await expect(
      open(s.fetch, { 'careers.evil.example.org': addresses }).get('https://careers.evil.example.org/jobs'),
    ).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(s.seen).toHaveLength(0);
  });

  it('reports a name that does not resolve as an upstream error, not as an allowed host', async () => {
    const s = script(json({}));
    await expect(open(s.fetch, {}).get('https://nope.example.org/jobs')).rejects.toBeInstanceOf(UpstreamError);
    expect(s.seen).toHaveLength(0);
  });

  it('checks every redirect hop: a public host that redirects to a private one is refused before the second request', async () => {
    const s = script(
      new Response(null, { status: 302, headers: { location: 'https://internal.evil.example.org/admin' } }),
      json({ leaked: true }),
    );
    await expect(
      open(s.fetch, { 'careers.bsport.io': ['93.184.216.34'], 'internal.evil.example.org': ['192.168.1.1'] }).get(
        'https://careers.bsport.io/jobs',
      ),
    ).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(s.seen).toHaveLength(1);
  });

  it('refuses a redirect to a literal IP, to plain http and to another port even when open', async () => {
    for (const target of [
      'https://169.254.169.254/latest/meta-data/',
      'http://careers.bsport.io/jobs',
      'https://careers.bsport.io:8443/jobs',
    ]) {
      const s = script(new Response(null, { status: 301, headers: { location: target } }), json({}));
      await expect(
        open(s.fetch, { 'careers.bsport.io': ['93.184.216.34'] }).get('https://careers.bsport.io/jobs'),
        target,
      ).rejects.toBeInstanceOf(HostNotAllowedError);
      expect(s.seen).toHaveLength(1);
    }
  });

  it('is closed by default: a custom domain is refused when the adapter is not open', async () => {
    const s = script(json({}));
    await expect(
      client(s.fetch, { allowedHosts: listed, resolve: resolver({ 'careers.bsport.io': ['93.184.216.34'] }) }).get(
        'https://careers.bsport.io/jobs',
      ),
    ).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(s.seen).toHaveLength(0);
  });
});
