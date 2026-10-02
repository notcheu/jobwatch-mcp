import {
  AdapterBroken,
  HostNotAllowedError,
  JobwatchError,
  UpstreamError,
  assertUrlAllowed,
  classifyUrl,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
  type z,
} from '@jobwatch/sdk';
import { Semaphore } from '../runtime/semaphore';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicAddress } from './addresses';

export interface HttpClientOptions {
  allowedHosts: readonly string[];
  /** Also reach any public https host (an adapter that declares `openHttps`). Such hosts get the address checks below. */
  openHttps?: boolean;
  /** Resolve a name to all its addresses. Injected in tests; the default asks the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Told the host (never the path or query) of every request to a host that is not in `allowedHosts`, for the audit log. */
  onOpenHost?: (hostname: string) => void;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Hard cap on a response body (default 8 MB: the biggest public job boards, such as Pennylane's on Ashby, are 4 MB of JSON). */
  maxBodyBytes?: number;
  defaultTimeoutMs?: number;
  maxRedirects?: number;
  /** Minimum gap between two requests to the same host (politeness). */
  minHostIntervalMs?: number;
  /** At most this many requests at once for this client. */
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Headers an adapter may not set: they would carry identity or change where the request goes. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'authorization',
  'proxy-authorization',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'origin',
]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `HttpClient` adapters receive (03-router-spec.md). It enforces, for every request AND every redirect hop:
 * the host allowlist (https only, exact host), a timeout, a response size cap, a politeness gap per host and a concurrency
 * limit. It never sends or stores cookies, never exposes `Set-Cookie`, and forbids adapters from setting identity headers.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetch ?? fetch;
  const maxBody = options.maxBodyBytes ?? 8_000_000;
  const defaultTimeout = options.defaultTimeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const hostGap = options.minHostIntervalMs ?? 500;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent ?? 'jobwatch-mcp (personal read-only job search)';
  const slots = new Semaphore(options.concurrency ?? 4);
  const resolve = options.resolve ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address));
  const nextSlotAt = new Map<string, number>();

  /** Reserve the next time slot for a host, synchronously, so concurrent requests queue behind each other. */
  async function pace(host: string): Promise<void> {
    const at = Math.max(now(), nextSlotAt.get(host) ?? 0);
    nextSlotAt.set(host, at + hostGap);
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  }

  function headersFor(extra: Record<string, string> | undefined, json: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'user-agent': userAgent, accept: 'application/json, text/plain;q=0.8, */*;q=0.5' };
    if (json) headers['content-type'] = 'application/json';
    for (const [name, value] of Object.entries(extra ?? {})) {
      const key = name.toLowerCase();
      if (FORBIDDEN_REQUEST_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) {
        throw new JobwatchError('internal', `An adapter tried to set the forbidden request header "${key}".`);
      }
      if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value))
        throw new JobwatchError('internal', 'An adapter tried to set a header containing a line break.');
      headers[key] = value;
    }
    return headers;
  }

  async function readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBody) {
      await response.body?.cancel();
      throw new UpstreamError(`The response is larger than the ${maxBody} byte limit.`);
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel();
        throw new UpstreamError(`The response is larger than the ${maxBody} byte limit.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * A host reached only because the adapter is open: every address its name resolves to must be public. Checked on the first
   * request and on every redirect hop. The answer is not reused for the connection itself (the resolver may answer differently a
   * moment later), which is acceptable here because the request is https with certificate validation on port 443: a service on
   * the home network cannot present a valid certificate for a name the caller chose.
   */
  async function assertPublicHost(hostname: string): Promise<void> {
    let addresses: string[];
    try {
      addresses = await resolve(hostname);
    } catch (cause) {
      throw new UpstreamError(`Could not resolve ${hostname}.`, { cause });
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new HostNotAllowedError(hostname);
    }
  }

  async function send(method: 'GET' | 'POST', url: string, body: unknown, request: HttpRequestOptions | undefined): Promise<HttpResponse> {
    const timeoutMs = request?.timeoutMs ?? defaultTimeout;
    const headers = headersFor(request?.headers, method === 'POST');
    let payload: string | undefined = method === 'POST' ? JSON.stringify(body) : undefined;
    let currentMethod = method;
    let currentUrl = url;
    const release = await slots.acquire(timeoutMs, 1);
    try {
      for (let hop = 0; ; hop += 1) {
        const target = assertUrlAllowed(currentUrl, options.allowedHosts, options.openHttps === true);
        if (classifyUrl(currentUrl, options.allowedHosts, options.openHttps === true) === 'open') {
          options.onOpenHost?.(target.hostname);
          await assertPublicHost(target.hostname);
        }
        await pace(target.hostname);
        let response: Response;
        try {
          response = await doFetch(target, {
            method: currentMethod,
            headers,
            redirect: 'manual',
            ...(payload === undefined ? {} : { body: payload }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new JobwatchError('timeout', `The request to ${target.hostname} timed out.`, { cause: error });
          }
          throw new UpstreamError(`The request to ${target.hostname} failed.`, { cause: error });
        }
        const location = response.headers.get('location');
        if (REDIRECT.has(response.status) && location !== null) {
          await response.body?.cancel();
          if (hop >= maxRedirects) throw new UpstreamError(`Too many redirects from ${target.hostname}.`);
          currentUrl = new URL(location, target).toString(); // validated by assertUrlAllowed on the next turn
          if (response.status !== 307 && response.status !== 308) {
            currentMethod = 'GET';
            payload = undefined;
            delete headers['content-type'];
          }
          continue;
        }
        const text = await readBody(response);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (name !== 'set-cookie' && name !== 'set-cookie2') responseHeaders[name] = value;
        });
        return {
          status: response.status,
          ok: response.ok,
          headers: responseHeaders,
          text,
          json<T>(schema: z.ZodType<T>): T {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (cause) {
              throw new AdapterBroken('Response body is not valid JSON.', { cause });
            }
            const result = schema.safeParse(parsed);
            if (!result.success) throw new AdapterBroken('Response does not match the expected shape.', { cause: result.error });
            return result.data;
          },
        };
      }
    } finally {
      release();
    }
  }

  return {
    get: (url, request) => send('GET', url, undefined, request),
    postJson: (url, body, request) => send('POST', url, body, request),
  };
}
