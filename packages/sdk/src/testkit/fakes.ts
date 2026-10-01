import type { z } from 'zod';
import { AdapterBroken } from '../errors';
import { assertUrlAllowed, redactUrl } from '../hosts';
import type {
  BrowserAdapterContext,
  BrowserSession,
  GotoOptions,
  HttpAdapterContext,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  Logger,
  PaceKind,
} from '../context';

/** A canned page. Real DOM behaviour is not simulated: tests give the fake what the page would have produced. */
export interface FakePage {
  /** Selectors that exist on the page (for `waitForSelector`). */
  present?: readonly string[];
  /** `textContent` by selector (also counts as present). */
  texts?: Readonly<Record<string, string>>;
  /** Called by `evaluate`; receives the script source (or function source) and the argument. */
  evaluate?: (script: string, arg: unknown) => unknown;
}

/**
 * Replays canned pages for adapter tests. It enforces the same host allowlist as the real session
 * (`assertUrlAllowed`), so a test fails when an adapter builds a URL outside its `allowedHosts`.
 * Pages are looked up by exact URL, then by URL without query string.
 */
export class FakeBrowserSession implements BrowserSession {
  /** Every navigation, redacted (no query string). */
  readonly visited: string[] = [];
  private current = 'about:blank';

  constructor(
    private readonly allowedHosts: readonly string[],
    private readonly pages: Readonly<Record<string, FakePage>> = {},
  ) {}

  private page(): FakePage {
    const withoutQuery = this.current.split('?')[0] ?? this.current;
    return this.pages[this.current] ?? this.pages[withoutQuery] ?? {};
  }

  async goto(url: string, _options: GotoOptions): Promise<void> {
    assertUrlAllowed(url, this.allowedHosts);
    this.visited.push(redactUrl(url));
    this.current = url;
  }

  evaluate<T, A = undefined>(script: string | ((arg: A) => T), arg?: A): Promise<T> {
    const handler = this.page().evaluate;
    if (!handler) return Promise.reject(new Error(`FakeBrowserSession: no evaluate handler for ${redactUrl(this.current)}`));
    return Promise.resolve(handler(typeof script === 'string' ? script : script.toString(), arg) as T);
  }

  waitForSelector(selector: string, _timeoutMs: number): Promise<boolean> {
    const page = this.page();
    return Promise.resolve((page.present?.includes(selector) ?? false) || page.texts?.[selector] !== undefined);
  }

  text(selector: string): Promise<string | null> {
    return Promise.resolve(this.page().texts?.[selector] ?? null);
  }

  url(): string {
    return this.current;
  }
}

export interface FakeHttpRoute {
  method?: 'GET' | 'POST';
  /** Exact URL or a pattern tested against the full URL. */
  url: string | RegExp;
  status?: number;
  /** JSON-serialisable value (stringified) or a raw string. */
  body: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: 'GET' | 'POST';
  /** Redacted: no query string. */
  url: string;
  body?: unknown;
}

/** Canned HTTP for adapter tests. Enforces the host allowlist; unknown requests fail the test loudly. */
export class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly allowedHosts: readonly string[],
    private readonly routes: readonly FakeHttpRoute[] = [],
  ) {}

  get(url: string, _options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('GET', url, undefined);
  }

  postJson(url: string, body: unknown, _options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('POST', url, body);
  }

  private async send(method: 'GET' | 'POST', url: string, body: unknown): Promise<HttpResponse> {
    assertUrlAllowed(url, this.allowedHosts);
    this.requests.push({ method, url: redactUrl(url), ...(body === undefined ? {} : { body }) });
    const route = this.routes.find((r) => (r.method ?? method) === method && (typeof r.url === 'string' ? r.url === url : r.url.test(url)));
    if (!route) throw new Error(`FakeHttpClient: no route for ${method} ${redactUrl(url)}`);
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    const status = route.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: route.headers ?? {},
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
}

export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

export interface TestContextOptions {
  allowedHosts: readonly string[];
  pages?: Readonly<Record<string, FakePage>>;
  routes?: readonly FakeHttpRoute[];
}

export interface TestContext<C> {
  ctx: C;
  http: FakeHttpClient;
  logs: CapturedLog[];
  /** `pace` calls, in order. */
  paced: PaceKind[];
}

function baseParts(options: TestContextOptions): {
  http: FakeHttpClient;
  log: Logger;
  logs: CapturedLog[];
  paced: PaceKind[];
  pace: (k: PaceKind) => Promise<void>;
} {
  const logs: CapturedLog[] = [];
  const paced: PaceKind[] = [];
  const push = (level: CapturedLog['level']) => (message: string, fields?: Record<string, unknown>) => {
    logs.push({ level, message, ...(fields ? { fields } : {}) });
  };
  return {
    http: new FakeHttpClient(options.allowedHosts, options.routes),
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    logs,
    paced,
    pace: (kind) => {
      paced.push(kind);
      return Promise.resolve();
    },
  };
}

/** Context for testing a `kind: "http"` adapter. */
export function createHttpTestContext(options: TestContextOptions): TestContext<HttpAdapterContext> {
  const { http, log, logs, paced, pace } = baseParts(options);
  return { ctx: { http, log, pace }, http, logs, paced };
}

/** Context for testing a `kind: "browser"` adapter. Also returns the fake session for assertions. */
export function createBrowserTestContext(
  options: TestContextOptions,
): TestContext<BrowserAdapterContext> & { session: FakeBrowserSession } {
  const { http, log, logs, paced, pace } = baseParts(options);
  const session = new FakeBrowserSession(options.allowedHosts, options.pages);
  return { ctx: { http, log, pace, session }, http, logs, paced, session };
}
