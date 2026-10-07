import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, navigation } from '@/lib/api';
import { NOW, badSearchRow, callRow, me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const overview = {
  version: '1.2.3',
  uptimeS: 7260,
  health: { completed: 40, failed: 2, rateLimited: 1, active: 1 },
  tokensReturned: 12_345,
  callsInMemory: 44,
  callBufferSize: 2000,
  storedJobs: 321,
  runtimeState: 'idle_grace',
  enabledAdapters: 3,
  badSearches: { count: 0, items: [] },
};

describe('the shell', () => {
  it('shows the sections in a sidebar and the signed-in account', async () => {
    mockApi({ '/me': me, '/tools': tools, '/overview': overview });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    for (const label of ['Overview', 'Analytics', 'Runs', 'Jobs', 'Searches', 'ATS discovery', 'Docs', 'Settings'])
      expect(within(nav).getByText(label)).toBeInTheDocument();
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('shows tabs for the enabled tools only, on the sections that filter by tool', async () => {
    mockApi({ '/me': me, '/tools': tools, '/calls': { calls: [], total: 0, next: null } });
    renderApp('/runs');
    const list = await screen.findByRole('tablist', { name: 'Tool' });
    await waitFor(() => expect(within(list).getByRole('tab', { name: 'linkedin' })).toBeInTheDocument());
    expect(
      within(list)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['All', 'linkedin', 'apec']); // wttj is disabled
  });

  it('puts the pages of the utilities under a Tools menu item that folds and unfolds, open at first', async () => {
    mockApi({ '/me': me, '/tools': tools, '/overview': overview });
    renderApp('/');
    const user = userEvent.setup();
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const group = within(nav).getByRole('button', { name: 'Tools' });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'ATS discovery' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'LinkedIn places' })).toBeInTheDocument();
    expect(within(nav).queryByText('Tools & status')).not.toBeInTheDocument();
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'ATS discovery' })).not.toBeInTheDocument();
    await user.click(group);
    expect(within(nav).getByRole('link', { name: 'ATS discovery' })).toBeInTheDocument();
  });

  it('offers one Utility tab on Runs and Analytics, only when a utility is enabled, and sends role=utility', async () => {
    const first = tools.adapters[0] as Record<string, unknown>;
    const utility = (id: string, enabled = true) => ({ ...first, id, platform: id, role: 'utility', kind: 'http', enabled });
    const withUtilities = { ...tools, adapters: [...tools.adapters, utility('ats-discovery'), utility('linkedin-geo')] };
    const seen = mockApi({ '/me': me, '/tools': withUtilities, '/calls': { calls: [], total: 0, next: null } });
    renderApp('/runs?tool=utility');
    const list = await screen.findByRole('tablist', { name: 'Tool' });
    await waitFor(() => expect(within(list).getByRole('tab', { name: 'Utility' })).toHaveAttribute('data-state', 'active'));
    expect(
      within(list)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['All', 'linkedin', 'apec', 'Utility']);
    await waitFor(() => expect(seen.some((url) => url.startsWith('/dashboard/api/v1/calls?') && url.includes('role=utility'))).toBe(true));
    expect(seen.some((url) => url.includes('platform=utility'))).toBe(false);
  });

  it('has no Utility tab when no utility is enabled, nor on Jobs', async () => {
    const first = tools.adapters[0] as Record<string, unknown>;
    const off = {
      ...tools,
      adapters: [
        ...tools.adapters,
        { ...first, id: 'ats-discovery', platform: 'ats-discovery', role: 'utility', kind: 'http', enabled: false },
      ],
    };
    mockApi({ '/me': me, '/tools': off, '/calls': { calls: [], total: 0, next: null } });
    renderApp('/runs');
    const list = await screen.findByRole('tablist', { name: 'Tool' });
    await waitFor(() => expect(within(list).getByRole('tab', { name: 'linkedin' })).toBeInTheDocument());
    expect(within(list).queryByRole('tab', { name: 'Utility' })).not.toBeInTheDocument();
  });

  it('gives no tab to a utility: it fetches no jobs', async () => {
    const first = tools.adapters[0] as Record<string, unknown>;
    const withUtility = {
      ...tools,
      adapters: [...tools.adapters, { ...first, id: 'ats-discovery', platform: 'ats-discovery', role: 'utility', kind: 'http' }],
    };
    mockApi({ '/me': me, '/tools': withUtility, '/calls': { calls: [], total: 0, next: null } });
    renderApp('/runs');
    const list = await screen.findByRole('tablist', { name: 'Tool' });
    await waitFor(() => expect(within(list).getByRole('tab', { name: 'linkedin' })).toBeInTheDocument());
    expect(within(list).queryByRole('tab', { name: 'ats-discovery' })).not.toBeInTheDocument();
  });

  it('has no tabs on the overview', async () => {
    mockApi({ '/me': me, '/tools': tools, '/overview': overview });
    renderApp('/');
    await screen.findByText('Request health');
    expect(screen.queryByRole('tablist', { name: 'Tool' })).not.toBeInTheDocument();
  });

  it('says in the local mode that there is no sign-in', async () => {
    mockApi({ '/me': { ...me, mode: 'local', email: null }, '/tools': tools, '/overview': overview });
    renderApp('/');
    expect(await screen.findByText('Local development')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});

describe('overview', () => {
  it('shows the health, the live activity and the headline numbers', async () => {
    mockApi({ '/me': me, '/tools': tools, '/overview': overview });
    renderApp('/');
    expect(await screen.findByText('Request health')).toBeInTheDocument();
    expect(screen.getByText('~12k')).toBeInTheDocument();
    expect(screen.getByText('321')).toBeInTheDocument();
    expect(screen.getByText('idle_grace')).toBeInTheDocument();
    expect(screen.getByText('2 h 1 min')).toBeInTheDocument();
  });

  it('has a card for the searches in bad health, and says so when there are none', async () => {
    mockApi({ '/me': me, '/tools': tools, '/overview': overview });
    renderApp('/');
    const card = await screen.findByLabelText('Searches in bad health');
    expect(within(card).getByText('Every search brought jobs in and kept most of them.')).toBeInTheDocument();
  });

  it('lists the searches in bad health with a link to each one, and how many more there are', async () => {
    const bad = badSearchRow();
    mockApi({
      '/me': me,
      '/tools': tools,
      '/overview': {
        ...overview,
        badSearches: {
          count: 3,
          items: [
            bad,
            badSearchRow({
              source: 'apec',
              keywords: ['ghost', 'spectre'],
              jobsFound: 0,
              health: { status: 'bad', issues: ['no_results'], discardedShare: 0 },
            }),
          ],
        },
      },
    });
    renderApp('/');
    const card = await screen.findByLabelText('Searches in bad health');
    expect(within(card).getByText('intern')).toBeInTheDocument();
    expect(within(card).getByText('90% discarded')).toBeInTheDocument();
    expect(within(card).getByText('9 of 10 discarded')).toBeInTheDocument();
    expect(within(card).getByText('no results')).toBeInTheDocument();
    expect(within(card).getByText('ghost')).toBeInTheDocument(); // one badge per keyword
    expect(within(card).getByText('spectre')).toBeInTheDocument();
    expect(within(card).getByText('and 1 more')).toBeInTheDocument();
    const link = within(card).getByRole('link', { name: /intern/ });
    expect(new URL(link.getAttribute('href') ?? '', 'http://x').pathname).toBe('/searches/linkedin');
  });
});

/** The element at a position, or a failure that names it (no `!`). */
const at = <T,>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`nothing at position ${index}`);
  return item;
};

/** The header row is there at once; the call rows come with the answer. */
const rowsLoaded = async (count: number) => {
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(count));
  return screen.getAllByRole('row');
};

describe('runs', () => {
  const calls = {
    calls: [
      callRow({ id: 3, state: 'running', code: null, durationMs: null, tool: 'apec_search', platform: 'apec', keywords: null }),
      callRow({ id: 2, code: 'rate_limited', tool: 'linkedin_search', keywords: ['vue'] }),
      callRow({ id: 1 }),
    ],
    total: 3,
    next: null,
  };

  it('lists the calls with their outcome, units, size and estimated tokens', async () => {
    mockApi({ '/me': me, '/tools': tools, '/calls': calls });
    renderApp('/runs');
    const rows = await rowsLoaded(4);
    expect(within(at(rows, 1)).getByText('running')).toBeInTheDocument();
    expect(within(at(rows, 2)).getByText('rate limited')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('ok')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('react engineer')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('3 / 5')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('585')).toBeInTheDocument();
  });

  it('asks the server for the calls of the selected tool', async () => {
    const seen = mockApi({ '/me': me, '/tools': tools, '/calls': calls });
    renderApp('/runs?tool=linkedin');
    await rowsLoaded(4);
    expect(seen.some((url) => url.startsWith('/dashboard/api/v1/calls') && url.includes('platform=linkedin'))).toBe(true);
  });

  it('opens the detail on the right when a row is clicked, with the parameters as formatted JSON', async () => {
    mockApi({
      '/me': me,
      '/tools': tools,
      '/calls': calls,
      '/calls/1': {
        ...callRow({ id: 1 }),
        adapter: 'linkedin',
        argsHash: 'abc123abc123',
        params: { keywords: 'react engineer', geo: 'france', skip_ids: ['1', '2'] },
        paramsTruncated: false,
        paramsDropped: false,
        jobText: { available: 8000, returned: 700 },
      },
    });
    renderApp('/runs');
    const user = userEvent.setup();
    const row = at(await rowsLoaded(4), 3);
    await user.click(row);
    const panel = await screen.findByRole('complementary', { name: 'linkedin_search' });
    const params = within(panel).getByLabelText('Parameters of the call');
    expect(JSON.parse(params.textContent ?? '')).toEqual({ keywords: 'react engineer', geo: 'france', skip_ids: ['1', '2'] });
    expect(within(panel).getByText('700 / 8.0k characters')).toBeInTheDocument();
    expect(within(panel).getByText('abc123abc123')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Copy Parameters of the call' })).toBeInTheDocument();
  });

  it('opens the detail with Enter on a focused row and closes it with Escape', async () => {
    mockApi({
      '/me': me,
      '/tools': tools,
      '/calls': calls,
      '/calls/1': {
        ...callRow({ id: 1 }),
        adapter: 'linkedin',
        argsHash: null,
        params: { keywords: 'x' },
        paramsTruncated: false,
        paramsDropped: false,
        jobText: null,
      },
    });
    renderApp('/runs');
    const user = userEvent.setup();
    const row = at(await rowsLoaded(4), 3);
    row.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('complementary')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('shows text from a call as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    mockApi({
      '/me': me,
      '/tools': tools,
      '/calls': { calls: [callRow({ id: 1, keywords: [hostile] })], total: 1, next: null },
      '/calls/1': {
        ...callRow({ id: 1, keywords: [hostile] }),
        adapter: 'linkedin',
        argsHash: null,
        params: { keywords: [hostile] },
        paramsTruncated: false,
        paramsDropped: false,
        jobText: null,
      },
    });
    renderApp('/runs/1');
    const params = await screen.findByLabelText('Parameters of the call');
    expect(params.textContent).toContain('<img src=x');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('says why when the parameters are gone, and when the call left memory', async () => {
    mockApi({
      '/me': me,
      '/tools': tools,
      '/calls': calls,
      '/calls/1': {
        ...callRow({ id: 1 }),
        adapter: 'linkedin',
        argsHash: null,
        params: null,
        paramsTruncated: false,
        paramsDropped: true,
        jobText: null,
      },
    });
    const { unmount } = renderApp('/runs/1');
    expect(await screen.findByText('Dropped to keep the memory bounded.')).toBeInTheDocument();
    unmount();
    renderApp('/runs/99');
    expect(await screen.findByText(/no longer in the call log/)).toBeInTheDocument();
  });

  it('has an empty state that says what to do', async () => {
    mockApi({ '/me': me, '/tools': tools, '/calls': { calls: [], total: 0, next: null } });
    renderApp('/runs');
    expect(await screen.findByText(/No calls yet\. Run a search from Claude/)).toBeInTheDocument();
  });

  it('filters to the failed calls on the client', async () => {
    mockApi({ '/me': me, '/tools': tools, '/calls': calls });
    renderApp('/runs');
    const user = userEvent.setup();
    await rowsLoaded(4);
    await user.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.getByText('rate limited')).toBeInTheDocument();
  });
});

describe('the API client', () => {
  it('sends the browser to the sign-in page when the session is gone', async () => {
    mockApi({
      '/overview': new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in to use the dashboard.' }), { status: 401 }),
    });
    const toLogin = vi.spyOn(navigation, 'toLogin').mockImplementation(() => undefined);
    await expect(api.overview()).rejects.toBeInstanceOf(ApiError);
    expect(toLogin).toHaveBeenCalledOnce();
  });

  it('does not leave the page for a "sign in again" answer: the caller handles it', async () => {
    mockApi({
      '/overview': new Response(JSON.stringify({ error: 'reauth_required', message: 'Sign in again to make this change.' }), {
        status: 401,
      }),
    });
    const toLogin = vi.spyOn(navigation, 'toLogin').mockImplementation(() => undefined);
    await expect(api.overview()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(toLogin).not.toHaveBeenCalled();
  });

  it('refuses an answer whose shape is not the documented one', async () => {
    mockApi({ '/overview': { version: 'x' } });
    await expect(api.overview()).rejects.toThrow();
  });

  it('reports a server error with its message', async () => {
    mockApi({ '/overview': new Response(JSON.stringify({ error: 'internal', message: 'Something went wrong.' }), { status: 500 }) });
    await expect(api.overview()).rejects.toMatchObject({ status: 500, message: 'Something went wrong.' });
  });
});

describe('formatting', () => {
  it('uses the time of the call', () => {
    expect(NOW).toBe('2026-10-09T12:00:00.000Z');
  });
});
