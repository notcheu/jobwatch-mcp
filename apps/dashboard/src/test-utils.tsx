import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AppRoutes } from '@/App';

export const NOW = '2026-10-09T12:00:00.000Z';

export const me = {
  mode: 'google',
  email: 'me@example.com',
  signedInAt: NOW,
  expiresAt: NOW,
  idleStopAt: NOW,
  writableUntil: NOW,
  version: '1.2.3',
};
export const tools = {
  adapters: [
    {
      id: 'linkedin',
      displayName: 'LinkedIn',
      platform: 'linkedin',
      kind: 'browser',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      boards: [],
      breaker: null,
    },
    {
      id: 'apec',
      displayName: 'Apec',
      platform: 'apec',
      kind: 'browser',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      boards: [],
      breaker: null,
    },
    {
      id: 'wttj',
      displayName: 'WTTJ',
      platform: 'wttj',
      kind: 'browser',
      enabled: false,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      boards: [],
      breaker: null,
    },
  ],
  runtime: { enabled: true, state: 'cold', platform: null, peakMb: null, waiting: 0 },
};

export const callRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  requestId: 'req-1',
  tool: 'linkedin_search',
  platform: 'linkedin',
  state: 'done',
  code: 'ok',
  startedAt: NOW,
  durationMs: 1500,
  unitsReserved: 5,
  unitsSpent: 3,
  responseBytes: 2048,
  estimatedTokens: 585,
  warnings: 0,
  keywords: 'react engineer',
  ...over,
});

type Routes = Record<string, unknown | ((url: URL) => unknown)>;

/** Replace fetch with canned answers keyed by path; an unknown path is a 404. Returns the calls made. */
export function mockApi(routes: Routes) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      seen.push(`${url.pathname}${url.search}`);
      const key = Object.keys(routes).find((path) => url.pathname === `/dashboard/api/v1${path}`);
      if (key === undefined) return new Response(JSON.stringify({ error: 'not_found', message: 'No such endpoint.' }), { status: 404 });
      const answer = routes[key];
      const body = typeof answer === 'function' ? (answer as (u: URL) => unknown)(url) : answer;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

export function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
