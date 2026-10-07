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
      role: 'adapter',
      kind: 'browser',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      budget: {
        hourly: { value: 600, source: 'default', default: 600, envVar: 'X_BUDGET_HOURLY' },
        daily: { value: 3000, source: 'default', default: 3000, envVar: 'X_BUDGET_DAILY' },
      },
      boards: [],
      breaker: null,
      session: null,
    },
    {
      id: 'apec',
      displayName: 'Apec',
      platform: 'apec',
      role: 'adapter',
      kind: 'browser',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      budget: {
        hourly: { value: 600, source: 'default', default: 600, envVar: 'X_BUDGET_HOURLY' },
        daily: { value: 3000, source: 'default', default: 3000, envVar: 'X_BUDGET_DAILY' },
      },
      boards: [],
      breaker: null,
      session: null,
    },
    {
      id: 'wttj',
      displayName: 'WTTJ',
      platform: 'wttj',
      role: 'adapter',
      kind: 'browser',
      enabled: false,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: null,
      rateDay: null,
      budget: {
        hourly: { value: 600, source: 'default', default: 600, envVar: 'X_BUDGET_HOURLY' },
        daily: { value: 3000, source: 'default', default: 3000, envVar: 'X_BUDGET_DAILY' },
      },
      boards: [],
      breaker: null,
      session: null,
    },
  ],
  runtime: { enabled: true, state: 'cold', platform: null, peakMb: null, waiting: 0 },
};

/** One row of the Searches list: a search that is healthy unless the test says otherwise. */
export const searchRow = (over: Record<string, unknown> = {}) => ({
  source: 'linkedin',
  keywords: ['react engineer'],
  disallowed: [],
  runs: 4,
  firstRun: NOW,
  lastRun: NOW,
  jobsFound: 80,
  jobsReturned: 30,
  jobsExcluded: 10,
  jobsNew: 20,
  health: { status: 'good', issues: [], discardedShare: 0.125 },
  ...over,
});

/** A search in bad health: most of what it lists is dropped. */
export const badSearchRow = (over: Record<string, unknown> = {}) =>
  searchRow({
    keywords: ['intern'],
    jobsFound: 10,
    jobsReturned: 1,
    jobsExcluded: 9,
    jobsNew: 1,
    health: { status: 'bad', issues: ['mostly_discarded'], discardedShare: 0.9 },
    ...over,
  });

/** A search as it appears in a job's `foundBy` list on the Jobs table. */
export const searchRef = (keywords: string[], disallowed: string[] = []) => ({ keywords, disallowed });

/** A search that listed one job, as the job detail gets it: its counts and health, and what it did with that job. */
export const jobSearch = (over: Record<string, unknown> = {}) => ({
  keywords: ['react'],
  disallowed: [],
  runs: 3,
  lastRun: NOW,
  jobsFound: 20,
  jobsReturned: 15,
  jobsExcluded: 2,
  health: { status: 'good', issues: [], discardedShare: 0.1 },
  outcome: 'returned',
  excludedBy: null,
  ...over,
});

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
  keywords: ['react engineer'],
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
