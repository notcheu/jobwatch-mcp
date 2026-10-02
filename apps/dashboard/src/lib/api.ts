import {
  API_PREFIX,
  adapterToggleSchema,
  callDetailSchema,
  callsPageSchema,
  jobDetailSchema,
  jobsPageSchema,
  meSchema,
  overviewSchema,
  restartSchema,
  searchesSchema,
  toolsSchema,
  usageSchemaResponse,
  type AdapterToggle,
  type CallDetail,
  type CallsPage,
  type JobDetail,
  type JobsPage,
  type Me,
  type Overview,
  type Restart,
  type Searches,
  type Tools,
  type Usage,
} from '@jobwatch/dashboard-api';
import type { z } from 'zod';

/** The server said no: `status` 401 sends the browser to the sign-in page, anything else is shown. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where to send the browser when its session is gone, or when a change needs a fresh sign-in. A function so tests can replace it. */
export const navigation = {
  toReauth: (): void => {
    window.location.assign(`/dashboard/auth/login?reauth=1&next=${encodeURIComponent(window.location.pathname)}`);
  },
  toLogin: (): void => {
    window.location.assign(`/dashboard/login?next=${encodeURIComponent(window.location.pathname)}`);
  },
};

async function request<T>(schema: z.ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.method && init.method !== 'GET' ? { 'x-jw-csrf': '1', 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    if (body.error !== 'reauth_required') navigation.toLogin();
    throw new ApiError(401, body.error ?? 'unauthorized', body.message ?? 'Sign in to use the dashboard.');
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = body as { error?: string; message?: string };
    throw new ApiError(response.status, failure.error ?? 'error', failure.message ?? `The request failed (${response.status}).`);
  }
  return schema.parse(body);
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const api = {
  me: (): Promise<Me> => request(meSchema, '/me'),
  overview: (): Promise<Overview> => request(overviewSchema, '/overview'),
  calls: (params: { tool?: string; platform?: string; code?: string; before?: number; limit?: number }): Promise<CallsPage> =>
    request(callsPageSchema, `/calls${query(params)}`),
  call: (id: number): Promise<CallDetail> => request(callDetailSchema, `/calls/${id}`),
  jobs: (params: Record<string, string | number | undefined>): Promise<JobsPage> => request(jobsPageSchema, `/jobs${query(params)}`),
  job: (source: string, id: string): Promise<JobDetail> =>
    request(jobDetailSchema, `/jobs/${encodeURIComponent(source)}/${encodeURIComponent(id)}`),
  searches: (params: { since?: string; until?: string; source?: string }): Promise<Searches> =>
    request(searchesSchema, `/searches${query(params)}`),
  tools: (): Promise<Tools> => request(toolsSchema, '/tools'),
  usage: (params: { tool?: string; platform?: string }): Promise<Usage> => request(usageSchemaResponse, `/usage${query(params)}`),
  setAdapter: (id: string, enabled: boolean): Promise<AdapterToggle> =>
    request(adapterToggleSchema, `/adapters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  restart: (force: boolean): Promise<Restart> =>
    request(restartSchema, '/router/restart', { method: 'POST', body: JSON.stringify({ force }) }),
};
