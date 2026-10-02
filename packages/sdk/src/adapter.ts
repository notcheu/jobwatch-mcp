import type { BrowserAdapterContext, BrowserSession, HttpAdapterContext, SessionStatus } from './context';
import type { ErasedTool } from './tool';

/**
 * How much of a platform the router may use. The unit is a "cost point": each tool declares the `cost` of one call
 * (limits.cost), taken from these budgets before the call runs, so the budget is counted per platform across all tools.
 * Sliding windows of one hour and 24 hours.
 */
export interface RatePolicy {
  perHour: number;
  perDay: number;
}

/** Human-like pause between page loads, drawn uniformly from [minMs, maxMs] (07-adapter-linkedin.md: 2.5 to 5 s). */
export interface Pacing {
  minMs: number;
  maxMs: number;
}

interface AdapterBase {
  /** The name used by `jobwatch adapters enable <id>` and in adapters.json, e.g. `linkedin`. Lowercase, digits, hyphens. */
  id: string;
  displayName: string;
  description: string;
  /** The `SDK_API_VERSION` this adapter was written against. */
  sdkApi: number;
  /** Profile name and key of the rate limiter and the circuit breaker. */
  platform: string;
  /**
   * Hosts this adapter may reach, https only: bare hostnames (exact match) and one-label wildcards (`*.teamtailor.com`, which
   * matches `bsport.teamtailor.com` but not `a.b.teamtailor.com` or the bare domain). Enforced by `BrowserSession` and `HttpClient`.
   */
  allowedHosts: readonly string[];
  /** Budget for this platform. Omit to get the engine default for the adapter kind (browser: 120/hour, 300/day; http: 600/hour, 3000/day). */
  rate?: RatePolicy;
  /**
   * Budget of ONE company board (a key a tool names in `limits.keys`), separate from `rate`: `rate` caps the whole platform,
   * `keyRate` caps each board, so one company is never hit harder than its own limit. Required when a tool declares `keys`.
   */
  keyRate?: RatePolicy;
  /** Pause `ctx.pace()` waits. Omit for the engine default (browser: 2500 to 5000 ms, http: none; HTTP is paced per host by the client). */
  pacing?: Pacing;
}

/** An adapter that needs the leased, single-tab Chrome of its platform. */
export interface BrowserAdapter extends AdapterBase {
  kind: 'browser';
  /** Reports whether the platform session is usable. Used by `session_status` and before the first call. */
  sessionCheck?: (session: BrowserSession) => Promise<SessionStatus>;
  /**
   * The site signs you in with session cookies (no expiry), which Chrome drops when it restarts. When set, the engine gives the
   * site's session cookies a 30 day expiry as each call ends, so a login survives the idle stop of the browser. Only the cookies
   * of this adapter's `allowedHosts` are touched; their values are never read by the engine's logs.
   */
  keepSessionCookies?: boolean;
  tools: readonly ErasedTool<BrowserAdapterContext>[];
}

/** An adapter that only talks HTTP: no container, no semaphore. */
export interface HttpAdapter extends AdapterBase {
  kind: 'http';
  /**
   * Also reach ANY public https host, for ATS boards on a company's own domain (`careers.bsport.io`). Off unless set, shown in
   * the catalog (`open_https`), and guarded by the HTTP client: GET and POST to https port 443 only, names that cannot be public
   * are refused, and every address the name resolves to must be public, on every redirect hop (`09-security.md`).
   * Declare it only when a tool takes a URL from the caller; `allowedHosts` still lists the ATS's own hosts.
   */
  openHttps?: boolean;
  tools: readonly ErasedTool<HttpAdapterContext>[];
}

export type AdapterModule = BrowserAdapter | HttpAdapter;
export type AdapterKind = AdapterModule['kind'];

/** Declare an adapter. Identity function: it exists so the compiler checks the whole shape at the definition site. */
export function defineAdapter<A extends AdapterModule>(adapter: A): A {
  return adapter;
}

/** What `jobwatch adapters list` shows: metadata only, no handlers. */
export interface AdapterSummary {
  id: string;
  displayName: string;
  description: string;
  platform: string;
  kind: AdapterKind;
  allowedHosts: readonly string[];
  openHttps: boolean;
  tools: readonly { name: string; title: string }[];
}

export function summarizeAdapter(adapter: AdapterModule): AdapterSummary {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    description: adapter.description,
    platform: adapter.platform,
    kind: adapter.kind,
    allowedHosts: adapter.allowedHosts,
    openHttps: adapter.kind === 'http' && adapter.openHttps === true,
    tools: adapter.tools.map((tool) => ({ name: tool.name, title: tool.title })),
  };
}
