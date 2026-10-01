import type { BrowserAdapterContext, BrowserSession, HttpAdapterContext, SessionStatus } from './context';
import type { ErasedTool } from './tool';

interface AdapterBase {
  /** The name used by `jobwatch adapters enable <id>` and in adapters.json, e.g. `linkedin`. Lowercase, digits, hyphens. */
  id: string;
  displayName: string;
  description: string;
  /** The `SDK_API_VERSION` this adapter was written against. */
  sdkApi: number;
  /** Profile name and key of the rate limiter and the circuit breaker. */
  platform: string;
  /** Bare hostnames this adapter may reach (exact match, https only). Enforced by `BrowserSession` and `HttpClient`. */
  allowedHosts: readonly string[];
}

/** An adapter that needs the leased, single-tab Chrome of its platform. */
export interface BrowserAdapter extends AdapterBase {
  kind: 'browser';
  /** Reports whether the platform session is usable. Used by `session_status` and before the first call. */
  sessionCheck?: (session: BrowserSession) => Promise<SessionStatus>;
  tools: readonly ErasedTool<BrowserAdapterContext>[];
}

/** An adapter that only talks HTTP: no container, no semaphore. */
export interface HttpAdapter extends AdapterBase {
  kind: 'http';
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
    tools: adapter.tools.map((tool) => ({ name: tool.name, title: tool.title })),
  };
}
