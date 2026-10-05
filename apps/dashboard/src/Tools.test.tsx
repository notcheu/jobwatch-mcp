import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { NOW, me, mockApi, renderApp } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const adapter = (over: Record<string, unknown> = {}) => ({
  id: 'teamtailor',
  displayName: 'Teamtailor',
  platform: 'teamtailor',
  role: 'adapter',
  kind: 'http',
  enabled: true,
  pinned: false,
  hosts: ['*.teamtailor.com'],
  tools: [{ name: 'teamtailor_jobs', title: 'Teamtailor jobs', costMax: 10, params: ['boards', 'title_any'] }],
  rateHour: { used: 4, limit: 600 },
  rateDay: { used: 40, limit: 3000 },
  boards: [{ board: 'bsport', rateHour: { used: 19, limit: 20 }, rateDay: { used: 30, limit: 100 } }],
  breaker: null,
  session: null,
  ...over,
});
const runtime = { enabled: true, state: 'idle_grace', platform: 'linkedin', peakMb: 812, waiting: 0 };
const linkedin = adapter({
  id: 'linkedin',
  displayName: 'LinkedIn',
  platform: 'linkedin',
  role: 'adapter',
  kind: 'browser',
  enabled: false,
  hosts: ['www.linkedin.com'],
  tools: [],
  rateHour: null,
  rateDay: null,
  boards: [],
});
const tools = (...adapters: unknown[]) => ({ adapters, runtime });
const toggled = {
  id: 'linkedin',
  enabled: true,
  enabledAdapters: ['linkedin', 'teamtailor'],
  addedTools: ['linkedin_search', 'linkedin_job'],
  removedTools: [],
  reconnectNeeded: true,
};

describe('tools and status', () => {
  it('groups the adapters by enabled and disabled, with kind, hosts, tools and parameters', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter(), linkedin) });
    renderApp('/tools');
    await screen.findByText('Teamtailor');
    const enabled = screen.getByRole('region', { name: 'Enabled adapters' });
    const disabled = screen.getByRole('region', { name: 'Disabled adapters' });
    expect(within(enabled).getByRole('heading', { name: 'Adapters enabled (1)' })).toBeInTheDocument();
    expect(within(enabled).getByText('Teamtailor')).toBeInTheDocument();
    expect(within(enabled).getByText('HTTP')).toBeInTheDocument();
    expect(within(enabled).getByText(/teamtailor_jobs/)).toBeInTheDocument();
    expect(within(enabled).getByText('boards, title_any')).toBeInTheDocument();
    expect(within(enabled).getByText(/\*\.teamtailor\.com/)).toBeInTheDocument();
    expect(within(disabled).getByText('LinkedIn')).toBeInTheDocument();
    expect(within(disabled).getByText('browser')).toBeInTheDocument();
  });

  it('shows the rate usage of the platform and of each company board', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    await screen.findByText('Teamtailor');
    expect(screen.getByText('4 / 600')).toBeInTheDocument();
    expect(screen.getByText('40 / 3000')).toBeInTheDocument();
    expect(screen.getByText('bsport')).toBeInTheDocument();
    expect(screen.getByText('19 / 20')).toBeInTheDocument();
  });

  it('shows the browser state, the session of a browser platform and an open breaker', async () => {
    mockApi({
      '/me': me,
      '/tools': tools(
        adapter({
          id: 'linkedin',
          displayName: 'LinkedIn',
          platform: 'linkedin',
          role: 'adapter',
          kind: 'browser',
          session: { state: 'needs_login', checkedAt: NOW, note: 'LinkedIn shows the sign-in page.' },
          breaker: { reason: 'needs_login', until: null },
        }),
        adapter({ id: 'wttj', displayName: 'WTTJ', platform: 'wttj', kind: 'browser', session: null }),
      ),
    });
    renderApp('/tools');
    expect(await screen.findByText(/needs login ·/)).toBeInTheDocument();
    expect(screen.getByText('breaker open: needs_login')).toBeInTheDocument();
    expect(screen.getByText('session not checked')).toBeInTheDocument();
    expect(screen.getByText('idle_grace')).toBeInTheDocument();
    expect(screen.getByText('Peak: 812 MB')).toBeInTheDocument();
  });

  it('enables an adapter with its switch, says what was added and that the connector must reconnect', async () => {
    const seen = mockApi({ '/me': me, '/tools': tools(adapter(), linkedin), '/adapters/linkedin': toggled });
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Enable LinkedIn' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'LinkedIn enabled. Tools added: linkedin_search, linkedin_job. Reconnect the Claude connector to see the new tool list.',
    );
    const put = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/adapters/linkedin'));
    expect(put?.[1]).toMatchObject({ method: 'PUT', body: '{"enabled":true}' });
    expect((put?.[1]?.headers as Record<string, string>)['x-jw-csrf']).toBe('1');
    expect(seen.filter((url) => url.endsWith('/tools')).length).toBeGreaterThan(1); // the list is read again
  });

  it("warns that LinkedIn needs the owner's approval of its budget before it is switched on", async () => {
    mockApi({ '/me': me, '/tools': tools(linkedin) });
    renderApp('/tools');
    expect(await screen.findByText(/needs your approval/)).toBeInTheDocument();
  });

  it('disables the switch and says why when ADAPTERS pins the list', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter({ pinned: true })) });
    renderApp('/tools');
    expect(await screen.findByRole('switch', { name: 'Disable Teamtailor' })).toBeDisabled();
    expect(screen.getByText(/set by ADAPTERS/)).toBeInTheDocument();
  });

  it('shows the refusal of the router next to the adapter', async () => {
    mockApi({
      '/me': me,
      '/tools': tools(linkedin),
      '/adapters/linkedin': new Response(JSON.stringify({ error: 'not_loadable', message: 'Adapter "linkedin" failed its checks.' }), {
        status: 422,
      }),
    });
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Enable LinkedIn' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Adapter "linkedin" failed its checks.');
  });

  it('asks to sign in again when the change needs a recent sign-in, and does so on request', async () => {
    mockApi({
      '/me': me,
      '/tools': tools(linkedin),
      '/adapters/linkedin': new Response(JSON.stringify({ error: 'reauth_required', message: 'Sign in again to make this change.' }), {
        status: 401,
      }),
    });
    const toReauth = vi.spyOn(navigation, 'toReauth').mockImplementation(() => undefined);
    const toLogin = vi.spyOn(navigation, 'toLogin').mockImplementation(() => undefined);
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Enable LinkedIn' }));
    const banner = await screen.findByText('Changes need a recent sign-in. Sign in again to continue.');
    expect(toLogin).not.toHaveBeenCalled();
    await user.click(within(banner.parentElement as HTMLElement).getByRole('button', { name: 'Sign in again' }));
    expect(toReauth).toHaveBeenCalledOnce();
  });
});

describe('restart', () => {
  it('asks before it restarts, then says the page reconnects by itself', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()), '/router/restart': { restarting: true } });
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Restart router/ }));
    expect(screen.getByText(/Calls that are running are cut/)).toBeInTheDocument();
    const call = () => vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/router/restart'));
    expect(call()).toBeUndefined(); // nothing was sent yet
    await user.click(screen.getByRole('button', { name: 'Yes, restart' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The router is restarting');
    expect(call()?.[1]).toMatchObject({ method: 'POST', body: '{"force":false}' });
  });

  it('can be cancelled', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Restart router/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Restart router/ })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/router/restart'))).toBe(false);
  });

  it('is refused while calls are running, and offers to restart anyway', async () => {
    let attempts = 0;
    mockApi({
      '/me': me,
      '/tools': tools(adapter()),
      '/router/restart': () =>
        ++attempts === 1
          ? new Response(JSON.stringify({ error: 'busy', message: '1 call is still running. Restarting would cut it.' }), { status: 409 })
          : { restarting: true },
    });
    renderApp('/tools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Restart router/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, restart' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 call is still running');
    await user.click(screen.getByRole('button', { name: 'Restart anyway' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('restarting'));
    const bodies = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/router/restart'))
      .map(([, init]) => init?.body);
    expect(bodies).toEqual(['{"force":false}', '{"force":true}']);
  });
});
