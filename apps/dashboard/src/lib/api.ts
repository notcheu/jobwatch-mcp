import {
  API_PREFIX,
  customAdapterDetailSchema,
  customAdapterRemovedSchema,
  customAdapterSampleSchema,
  customAdapterSchema,
  customAdaptersSchema,
  placeLookupsSchema,
  savedPlaceRemovedSchema,
  savedPlaceSchema,
  savedPlacesSchema,
  atsLookupsSchema,
  companyBoardRemovedSchema,
  companyBoardSchema,
  companyBoardsSchema,
  adapterToggleSchema,
  budgetUpdatedSchema,
  dataClearedSchema,
  docsSchema,
  callDetailSchema,
  callsPageSchema,
  jobDetailSchema,
  jobsPageSchema,
  meSchema,
  overviewSchema,
  restartSchema,
  searchDetailSchema,
  searchesSchema,
  settingsSchema,
  toolsSchema,
  usageSchemaResponse,
  type AdapterToggle,
  type AtsLookups,
  type CustomAdapter,
  type CustomAdapterDetail,
  type CustomAdapterSample,
  type CustomAdapters,
  type PlaceLookups,
  type SavedPlace,
  type SavedPlaces,
  type CompanyBoard,
  type CompanyBoards,
  type BudgetUpdated,
  type DataCleared,
  type Docs,
  type CallDetail,
  type CallsPage,
  type JobDetail,
  type JobsPage,
  type Me,
  type Overview,
  type Restart,
  type SearchDetailInfo,
  type Searches,
  type Settings,
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

const query = (params: Record<string, string | number | readonly string[] | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'object')
      for (const item of value) search.append(key, item); // a list is one entry per item
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const api = {
  me: (): Promise<Me> => request(meSchema, '/me'),
  overview: (): Promise<Overview> => request(overviewSchema, '/overview'),
  calls: (params: {
    tool?: string;
    platform?: string;
    role?: 'utility';
    code?: string;
    before?: number;
    limit?: number;
  }): Promise<CallsPage> => request(callsPageSchema, `/calls${query(params)}`),
  call: (id: number): Promise<CallDetail> => request(callDetailSchema, `/calls/${id}`),
  jobs: (params: Record<string, string | number | readonly string[] | undefined>): Promise<JobsPage> =>
    request(jobsPageSchema, `/jobs${query(params)}`),
  job: (source: string, id: string): Promise<JobDetail> =>
    request(jobDetailSchema, `/jobs/${encodeURIComponent(source)}/${encodeURIComponent(id)}`),
  searches: (params: { since?: string; until?: string; source?: string }): Promise<Searches> =>
    request(searchesSchema, `/searches${query(params)}`),
  search: (
    source: string,
    params: { keywords: readonly string[]; disallowed: readonly string[]; since?: string; until?: string },
  ): Promise<SearchDetailInfo> => request(searchDetailSchema, `/searches/${encodeURIComponent(source)}${query(params)}`),
  atsLookups: (params: { page?: number; pageSize?: number }): Promise<AtsLookups> =>
    request(atsLookupsSchema, `/ats-lookups${query(params)}`),
  companyBoards: (params: { q?: string; ats?: string; page?: number; pageSize?: number }): Promise<CompanyBoards> =>
    request(companyBoardsSchema, `/company-boards${query(params)}`),
  addCompanyBoard: (entry: { company: string; ats: string; handle: string }): Promise<CompanyBoard> =>
    request(companyBoardSchema, '/company-boards', { method: 'POST', body: JSON.stringify(entry) }),
  removeCompanyBoard: (id: number): Promise<{ id: number }> =>
    request(companyBoardRemovedSchema, `/company-boards/${id}`, { method: 'DELETE' }),
  placeLookups: (params: { page?: number; pageSize?: number }): Promise<PlaceLookups> =>
    request(placeLookupsSchema, `/place-lookups${query(params)}`),
  places: (params: { q?: string; page?: number; pageSize?: number }): Promise<SavedPlaces> =>
    request(savedPlacesSchema, `/places${query(params)}`),
  savePlace: (entry: { alias: string; id: string; label?: string }): Promise<SavedPlace> =>
    request(savedPlaceSchema, '/places', { method: 'POST', body: JSON.stringify(entry) }),
  forgetPlace: (alias: string): Promise<{ alias: string }> =>
    request(savedPlaceRemovedSchema, `/places/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  customAdapters: (): Promise<CustomAdapters> => request(customAdaptersSchema, '/custom-adapters'),
  customAdapter: (handle: string): Promise<CustomAdapterDetail> =>
    request(customAdapterDetailSchema, `/custom-adapters/${encodeURIComponent(handle)}`),
  customAdapterSample: (kind: 'http' | 'browser'): Promise<CustomAdapterSample> =>
    request(customAdapterSampleSchema, `/custom-adapters/sample/${kind}`),
  createCustomAdapter: (entry: {
    handle: string;
    name: string;
    kind: 'http' | 'browser';
    url: string;
    script: string;
  }): Promise<CustomAdapterDetail> =>
    request(customAdapterDetailSchema, '/custom-adapters', { method: 'POST', body: JSON.stringify(entry) }),
  updateCustomAdapter: (
    handle: string,
    entry: { name: string; kind: 'http' | 'browser'; url: string; script: string },
  ): Promise<CustomAdapterDetail> =>
    request(customAdapterDetailSchema, `/custom-adapters/${encodeURIComponent(handle)}`, { method: 'PUT', body: JSON.stringify(entry) }),
  setCustomAdapterEnabled: (handle: string, enabled: boolean): Promise<CustomAdapter> =>
    request(customAdapterSchema, `/custom-adapters/${encodeURIComponent(handle)}/enabled`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deleteCustomAdapter: (handle: string): Promise<{ handle: string }> =>
    request(customAdapterRemovedSchema, `/custom-adapters/${encodeURIComponent(handle)}`, { method: 'DELETE' }),
  docs: (): Promise<Docs> => request(docsSchema, '/docs'),
  tools: (): Promise<Tools> => request(toolsSchema, '/tools'),
  settings: (): Promise<Settings> => request(settingsSchema, '/settings'),
  usage: (params: {
    scope?: 'session' | 'lifetime' | 'historical';
    from?: string;
    to?: string;
    tool?: string;
    platform?: string;
    role?: 'utility';
  }): Promise<Usage> => request(usageSchemaResponse, `/usage${query(params)}`),
  setAdapter: (id: string, enabled: boolean): Promise<AdapterToggle> =>
    request(adapterToggleSchema, `/adapters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  setBudget: (id: string, budget: { hourly?: number; daily?: number }): Promise<BudgetUpdated> =>
    request(budgetUpdatedSchema, `/adapters/${encodeURIComponent(id)}/budget`, { method: 'PUT', body: JSON.stringify(budget) }),
  clearData: (id: string): Promise<DataCleared> =>
    request(dataClearedSchema, `/adapters/${encodeURIComponent(id)}/data`, { method: 'DELETE' }),
  restart: (force: boolean): Promise<Restart> =>
    request(restartSchema, '/router/restart', { method: 'POST', body: JSON.stringify({ force }) }),
};
