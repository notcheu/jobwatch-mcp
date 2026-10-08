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

/** Human-like pause between page loads, drawn uniformly from [minMs, maxMs] (docs/plans/07-adapter-linkedin.md: 2.5 to 5 s). */
export interface Pacing {
  minMs: number;
  maxMs: number;
}

/** What every module that adds MCP tools declares, whatever it does with them: an adapter or a utility. */
export interface ModuleBase {
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
  /**
   * Budget for this platform. Omit to get the engine default for the adapter kind (browser: 120/hour, 300/day; http: 600/hour, 3000/day).
   * The installed modules do not set it: their budget is in `packages/mcp-modules/src/budgets.json`, and the operator can change it
   * from the dashboard or with `<ID>_BUDGET_HOURLY` and `<ID>_BUDGET_DAILY`, both of which win over this.
   */
  rate?: RatePolicy;
  /**
   * Budget of ONE company board (a key a tool names in `limits.keys`), separate from `rate`: `rate` caps the whole platform,
   * `keyRate` caps each board, so one company is never hit harder than its own limit. Required when a tool declares `keys`.
   */
  keyRate?: RatePolicy;
  /** Pause `ctx.pace()` waits. Omit for the engine default (browser: 2500 to 5000 ms, http: none; HTTP is paced per host by the client). */
  pacing?: Pacing;
  /**
   * Makes this module a gateway: it fetches nothing itself (`allowedHosts` empty) and reads through the tools of the modules in `to`,
   * with `ctx.callTool`. Each delegated call goes through the engine like any client call, so the budget is charged to the module
   * that owns the tool, never to the gateway. A gateway is enabled by the engine while one of `to` is (`managedModules` in
   * `@jobwatch/mcp-modules`), and an operator cannot enable or disable it by hand.
   */
  delegates?: { to: readonly string[] };
}

/** An adapter that needs the leased, single-tab Chrome of its platform. */
export interface BrowserAdapter extends ModuleBase {
  /** Adapters fetch jobs; this is the default and need not be written. */
  role?: 'adapter';
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
export interface HttpAdapter extends ModuleBase {
  role?: 'adapter';
  kind: 'http';
  /**
   * Also reach ANY public https host, for ATS boards on a company's own domain (`careers.bsport.io`). Off unless set, shown in
   * the catalog (`open_https`), and guarded by the HTTP client: GET and POST to https port 443 only, names that cannot be public
   * are refused, and every address the name resolves to must be public, on every redirect hop (`docs/plans/09-security.md`).
   * Declare it only when a tool takes a URL from the caller; `allowedHosts` still lists the ATS's own hosts.
   */
  openHttps?: boolean;
  tools: readonly ErasedTool<HttpAdapterContext>[];
}

/** An adapter: a module that FETCHES JOBS from a platform (LinkedIn, Apec, WTTJ, an ATS). Stores what it reads. */
export type AdapterModule = BrowserAdapter | HttpAdapter;

/**
 * A utility: a module of helper tools that fetch no jobs (finding a LinkedIn geoId, finding the ATS of a company). HTTP only: no
 * browser, no login. It has a platform budget (`rate`) and a host allowlist like an adapter, and is enabled with
 * `jobwatch utilities enable <id>`.
 */
export interface UtilityModule extends ModuleBase {
  role: 'utility';
  kind: 'http';
  openHttps?: undefined;
  tools: readonly ErasedTool<HttpAdapterContext>[];
}

/** Anything the router can plug in: the one interface the registry, the budgets, the catalog and the listing work with. */
export type McpModule = AdapterModule | UtilityModule;
export type AdapterKind = McpModule['kind'];
export type ModuleRole = 'adapter' | 'utility';

/** The role of a module: `utility` only when it says so. */
export const roleOf = (module: McpModule): ModuleRole => (module.role === 'utility' ? 'utility' : 'adapter');

/** Declare an adapter. Identity function: it exists so the compiler checks the whole shape at the definition site. */
export function defineAdapter<A extends AdapterModule>(adapter: A): A {
  return adapter;
}

/** Declare a utility. Identity function, like `defineAdapter`. */
export function defineUtility<U extends Omit<UtilityModule, 'role' | 'kind'>>(utility: U): U & { role: 'utility'; kind: 'http' } {
  return { ...utility, role: 'utility', kind: 'http' };
}

interface SummaryBase {
  id: string;
  displayName: string;
  description: string;
  platform: string;
  kind: AdapterKind;
  allowedHosts: readonly string[];
  openHttps: boolean;
  tools: readonly { name: string; title: string }[];
}

/** What `jobwatch adapters list` shows: metadata only, no handlers. */
export interface AdapterSummary extends SummaryBase {
  role: 'adapter';
}

/** What `jobwatch utilities list` shows. */
export interface UtilitySummary extends SummaryBase {
  role: 'utility';
  kind: 'http';
}

/** Either, for the code that handles both (the dashboard, the registry). */
export type ModuleSummary = AdapterSummary | UtilitySummary;

const summaryOf = (module: McpModule): SummaryBase => ({
  id: module.id,
  displayName: module.displayName,
  description: module.description,
  platform: module.platform,
  kind: module.kind,
  allowedHosts: module.allowedHosts,
  openHttps: module.kind === 'http' && module.openHttps === true,
  tools: module.tools.map((tool) => ({ name: tool.name, title: tool.title })),
});

export function summarizeAdapter(adapter: AdapterModule): AdapterSummary {
  return { ...summaryOf(adapter), role: 'adapter' };
}

export function summarizeUtility(utility: UtilityModule): UtilitySummary {
  return { ...summaryOf(utility), role: 'utility', kind: 'http' };
}

/** Summarise a module of either kind. */
export function summarizeModule(module: McpModule): ModuleSummary {
  return module.role === 'utility' ? summarizeUtility(module) : summarizeAdapter(module);
}
