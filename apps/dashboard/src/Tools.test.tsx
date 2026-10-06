import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { NOW, me, mockApi, renderApp } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

/** Open the settings menu of a card, and pick an action. */
async function pick(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, action: string | RegExp) {
  await user.click(within(card).getByRole('button', { name: /^Settings of / }));
  await user.click(within(card).getByRole('menuitem', { name: action }));
}

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
  budget: {
    hourly: { value: 600, source: 'default', default: 600, envVar: 'TEAMTAILOR_BUDGET_HOURLY' },
    daily: { value: 3000, source: 'default', default: 3000, envVar: 'TEAMTAILOR_BUDGET_DAILY' },
  },
  boards: [{ board: 'bsport', rateHour: { used: 19, limit: 20 }, rateDay: { used: 30, limit: 100 } }],
  breaker: null,
  session: null,
  ...over,
});
const utility = (over: Record<string, unknown> = {}) =>
  adapter({
    id: 'ats-discovery',
    displayName: 'ATS discovery',
    platform: 'ats-discovery',
    role: 'utility',
    hosts: ['api.example.com'],
    tools: [],
    rateHour: null,
    rateDay: null,
    boards: [],
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

  it('enables an adapter from its settings menu, says what was added and that the connector must reconnect', async () => {
    const seen = mockApi({ '/me': me, '/tools': tools(adapter(), linkedin), '/adapters/linkedin': toggled });
    renderApp('/tools');
    const user = userEvent.setup();
    await pick(user, await screen.findByLabelText('LinkedIn'), 'Enable');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'LinkedIn enabled. Tools added: linkedin_search, linkedin_job. Reconnect the Claude connector to see the new tool list.',
    );
    const put = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/adapters/linkedin'));
    expect(put?.[1]).toMatchObject({ method: 'PUT', body: '{"enabled":true}' });
    expect((put?.[1]?.headers as Record<string, string>)['x-jw-csrf']).toBe('1');
    expect(seen.filter((url) => url.endsWith('/tools')).length).toBeGreaterThan(1); // the list is read again
  });

  /** The enable / disable item of a card, with its menu opened. */
  const toggleItem = async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => {
    await user.click(within(card).getByRole('button', { name: /^Settings of / }));
    return within(card).getByRole('menuitem', { name: /^(Enable|Disable)$/ });
  };

  it('warns once at the top, and disables enable / disable in the menus, when ADAPTERS pins the adapters', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter({ pinned: true }), utility()) });
    renderApp('/tools');
    const user = userEvent.setup();
    expect(await toggleItem(user, await screen.findByLabelText('Teamtailor'))).toHaveAttribute('aria-disabled', 'true');
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(
      'ADAPTERS is set in the environment, so the adapters cannot be enabled or disabled here. Unset ADAPTERS',
    );
    expect(await toggleItem(user, screen.getByLabelText('ATS discovery'))).not.toHaveAttribute('aria-disabled'); // UTILITIES is not set
    expect(screen.queryByText(/is set by ADAPTERS/)).not.toBeInTheDocument(); // nothing on the cards any more
  });

  it('warns about UTILITIES the same way', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter(), utility({ pinned: true })) });
    renderApp('/tools');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'UTILITIES is set in the environment, so the utilities cannot be enabled or disabled here',
    );
    const user = userEvent.setup();
    expect(await toggleItem(user, screen.getByLabelText('Teamtailor'))).not.toHaveAttribute('aria-disabled');
    expect(await toggleItem(user, screen.getByLabelText('ATS discovery'))).toHaveAttribute('aria-disabled', 'true');
  });

  it('lists both warnings when both variables are set', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter({ pinned: true }), utility({ pinned: true })) });
    renderApp('/tools');
    await screen.findAllByRole('alert');
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      expect.stringContaining('ADAPTERS is set'),
      expect.stringContaining('UTILITIES is set'),
    ]);
  });

  it('shows no warning when nothing is pinned', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter(), utility()) });
    renderApp('/tools');
    await screen.findByLabelText('Teamtailor');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('puts the kind and the state tags next to the name', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    const card = await screen.findByLabelText('Teamtailor');
    const header = within(card).getByText('Teamtailor').parentElement as HTMLElement;
    expect(within(header).getByText('HTTP')).toBeInTheDocument();
    expect(within(header).getByText('enabled')).toBeInTheDocument();
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
    await pick(user, await screen.findByLabelText('LinkedIn'), 'Enable');
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
    await pick(user, await screen.findByLabelText('LinkedIn'), 'Enable');
    const banner = await screen.findByText('Changes need a recent sign-in. Sign in again to continue.');
    expect(toLogin).not.toHaveBeenCalled();
    await user.click(within(banner.parentElement as HTMLElement).getByRole('button', { name: 'Sign in again' }));
    expect(toReauth).toHaveBeenCalledOnce();
  });
});

describe('clear stored data', () => {
  it('is an item of the settings menu, and asks in a dialog before it clears', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()), '/adapters/teamtailor/data': { id: 'teamtailor', jobs: 12, searches: 1 } });
    renderApp('/tools');
    const user = userEvent.setup();
    const call = () => vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/adapters/teamtailor/data'));
    const card = await screen.findByLabelText('Teamtailor');
    await pick(user, card, 'Clear stored data…');
    const dialog = await screen.findByRole('dialog', { name: 'Clear the stored data of Teamtailor?' });
    expect(dialog).toHaveTextContent('cannot be undone');
    expect(call()).toBeUndefined(); // one click is only the question
    await user.click(within(dialog).getByRole('button', { name: 'Clear data' }));
    expect(await screen.findByRole('status')).toHaveTextContent('12 stored jobs and 1 search removed. Its budget and history are kept.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(call()?.[1]).toMatchObject({ method: 'DELETE' });
    expect((call()?.[1]?.headers as Record<string, string>)['x-jw-csrf']).toBe('1');
  });

  it('can be cancelled, and is not offered on a utility', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter(), utility()) });
    renderApp('/tools');
    const user = userEvent.setup();
    const card = await screen.findByLabelText('Teamtailor');
    await pick(user, card, 'Clear stored data…');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await pick(user, card, 'Clear stored data…');
    await user.keyboard('{Escape}'); // Escape closes it too
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const utilityCard = screen.getByLabelText('ATS discovery');
    await user.click(within(utilityCard).getByRole('button', { name: /^Settings of / }));
    expect(within(utilityCard).queryByRole('menuitem', { name: /Clear stored data/ })).not.toBeInTheDocument(); // none on a utility
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/data'))).toBe(false);
  });
});

const value = (over: Record<string, unknown>) => ({ value: 600, source: 'default', default: 600, envVar: 'X', ...over });
const withBudget = (hourly: Record<string, unknown>, daily: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  adapter({
    budget: {
      hourly: value({ envVar: 'TEAMTAILOR_BUDGET_HOURLY', ...hourly }),
      daily: value({ value: 3000, default: 3000, envVar: 'TEAMTAILOR_BUDGET_DAILY', ...daily }),
    },
    ...over,
  });
const saved = (hourly = 600, daily = 3000) => ({
  id: 'teamtailor',
  budget: { hourly: value({ value: hourly, source: 'config' }), daily: value({ value: daily, default: 3000, source: 'config' }) },
});

describe('the settings menu', () => {
  it('replaces the switch and the delete button with one button that lists enable or disable, the budget and the delete', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter(), linkedin) });
    renderApp('/tools');
    const user = userEvent.setup();
    const card = await screen.findByLabelText('Teamtailor');
    expect(within(card).queryByRole('switch')).not.toBeInTheDocument();
    const button = within(card).getByRole('button', { name: 'Settings of Teamtailor' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(card)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Disable', 'Budget…', 'Clear stored data…']);
    // a disabled adapter offers Enable
    await user.click(within(await screen.findByLabelText('LinkedIn')).getByRole('button', { name: 'Settings of LinkedIn' }));
    expect(within(screen.getByLabelText('LinkedIn')).getByRole('menuitem', { name: 'Enable' })).toBeInTheDocument();
  });

  it('moves with the arrow keys, closes with Escape and gives the focus back, and closes on a click outside', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    const user = userEvent.setup();
    const card = await screen.findByLabelText('Teamtailor');
    const button = within(card).getByRole('button', { name: 'Settings of Teamtailor' });
    await user.click(button);
    const [first, second, third] = within(card).getAllByRole('menuitem');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await user.keyboard('{End}');
    expect(third).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(first).toHaveFocus(); // wraps
    await user.keyboard('{ArrowUp}');
    expect(third).toHaveFocus();
    await user.keyboard('{Home}');
    expect(first).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(within(card).queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(document.body);
    expect(within(card).queryByRole('menu')).not.toBeInTheDocument();
  });

  it('skips a disabled action with the arrow keys, and picking it does nothing', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter({ pinned: true })) });
    renderApp('/tools');
    const user = userEvent.setup();
    const card = await screen.findByLabelText('Teamtailor');
    await user.click(within(card).getByRole('button', { name: 'Settings of Teamtailor' }));
    const disable = within(card).getByRole('menuitem', { name: 'Disable' });
    expect(disable).toHaveAttribute('aria-disabled', 'true');
    expect(disable).toHaveAttribute('title', 'Set by ADAPTERS');
    expect(within(card).getByRole('menuitem', { name: 'Budget…' })).toHaveFocus(); // the first one that can be picked
    await user.click(disable);
    expect(within(card).getByRole('menu')).toBeInTheDocument(); // still open
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/adapters/'))).toBe(false);
  });
});

describe('the budget', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await pick(user, await screen.findByLabelText('Teamtailor'), 'Budget…');
    return screen.findByRole('dialog', { name: 'Budget of Teamtailor' });
  };

  it('opens a dialog with the hourly and daily budget, and the default of each', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    const dialog = await open(userEvent.setup());
    const hourly = within(dialog).getByLabelText('Hourly budget');
    const daily = within(dialog).getByLabelText('Daily budget');
    expect(hourly).toHaveValue(600);
    expect(daily).toHaveValue(3000);
    for (const input of [hourly, daily]) {
      expect(input).toHaveAttribute('min', '0');
      expect(input).toHaveAttribute('max', '1000000');
      expect(input).toBeEnabled();
    }
    expect(dialog).toHaveTextContent('Default 600');
    expect(dialog).toHaveTextContent('Default 3,000');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument(); // nothing is set by the environment
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled(); // nothing changed yet
  });

  it('saves both numbers, says so, and reads the list again', async () => {
    const seen = mockApi({ '/me': me, '/tools': tools(adapter()), '/adapters/teamtailor/budget': saved(100, 900) });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.clear(within(dialog).getByLabelText('Hourly budget'));
    await user.type(within(dialog).getByLabelText('Hourly budget'), '100');
    await user.clear(within(dialog).getByLabelText('Daily budget'));
    await user.type(within(dialog).getByLabelText('Daily budget'), '900');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Budget of Teamtailor saved: 100 per hour, 900 per day.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const put = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/adapters/teamtailor/budget'));
    expect(put?.[1]).toMatchObject({ method: 'PUT', body: '{"hourly":100,"daily":900}' });
    expect((put?.[1]?.headers as Record<string, string>)['x-jw-csrf']).toBe('1');
    expect(seen.filter((url) => url.endsWith('/tools')).length).toBeGreaterThan(1);
  });

  it('accepts 0 and 1000000, and refuses anything else with a message and no request', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()), '/adapters/teamtailor/budget': saved(0, 1_000_000) });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    const hourly = within(dialog).getByLabelText('Hourly budget');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    for (const bad of ['', '-1', '1000001', '1.5']) {
      await user.clear(hourly);
      if (bad !== '') await user.type(hourly, bad);
      expect(save, `"${bad}"`).toBeDisabled();
      expect(hourly).toHaveAttribute('aria-invalid', 'true');
    }
    expect(dialog).toHaveTextContent('A whole number from 0 to 1,000,000.');
    await user.clear(hourly);
    await user.type(hourly, '0');
    await user.clear(within(dialog).getByLabelText('Daily budget'));
    await user.type(within(dialog).getByLabelText('Daily budget'), '1000000');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByRole('status')).toHaveTextContent('0 per hour, 1000000 per day');
  });

  it('warns, without blocking, when the hourly budget is above the daily one', async () => {
    mockApi({ '/me': me, '/tools': tools(adapter()) });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.clear(within(dialog).getByLabelText('Hourly budget'));
    await user.type(within(dialog).getByLabelText('Hourly budget'), '5000');
    expect(dialog).toHaveTextContent('The hourly budget is above the daily one');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('puts the defaults back in the fields without saving, and a saved value shows next to its default', async () => {
    mockApi({ '/me': me, '/tools': tools(withBudget({ value: 100, source: 'config' }, { value: 900, source: 'config' })) });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(within(dialog).getByLabelText('Hourly budget')).toHaveValue(100);
    expect(dialog).toHaveTextContent('Default 600, saved 100');
    await user.click(within(dialog).getByRole('button', { name: 'Use the defaults' }));
    expect(within(dialog).getByLabelText('Hourly budget')).toHaveValue(600);
    expect(within(dialog).getByLabelText('Daily budget')).toHaveValue(3000);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/budget'))).toBe(false); // only the fields moved
  });

  it('when the environment sets the hourly budget: warns, shows its value, locks it, and still saves the daily one alone', async () => {
    mockApi({
      '/me': me,
      '/tools': tools(withBudget({ value: 150, source: 'env' }, {})),
      '/adapters/teamtailor/budget': {
        id: 'teamtailor',
        budget: { hourly: value({ value: 150, source: 'env' }), daily: value({ value: 900, source: 'config' }) },
      },
    });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    const warning = within(dialog).getByRole('alert');
    expect(warning).toHaveTextContent(
      'The environment sets one budget, and it overrides the saved configuration. It cannot be changed here.',
    );
    expect(warning).toHaveTextContent('TEAMTAILOR_BUDGET_HOURLY = 150 per hour');
    expect(warning).not.toHaveTextContent('TEAMTAILOR_BUDGET_DAILY');
    expect(within(dialog).getByLabelText('Hourly budget')).toBeDisabled();
    expect(within(dialog).getByLabelText('Hourly budget')).toHaveValue(150); // the environment value, not a saved one
    expect(within(dialog).getByLabelText('Daily budget')).toBeEnabled();
    await user.clear(within(dialog).getByLabelText('Daily budget'));
    await user.type(within(dialog).getByLabelText('Daily budget'), '900');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    const put = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/budget'));
    expect(put?.[1]).toMatchObject({ body: '{"daily":900}' }); // the locked window is never sent
  });

  it('when the environment sets both: lists both, locks both and cannot be saved', async () => {
    mockApi({ '/me': me, '/tools': tools(withBudget({ value: 150, source: 'env' }, { value: 300, source: 'env' })) });
    renderApp('/tools');
    const dialog = await open(userEvent.setup());
    const warning = within(dialog).getByRole('alert');
    expect(warning).toHaveTextContent(
      'The environment sets both budgets, and it overrides the saved configuration. They cannot be changed here.',
    );
    expect(warning).toHaveTextContent('TEAMTAILOR_BUDGET_HOURLY = 150 per hour');
    expect(warning).toHaveTextContent('TEAMTAILOR_BUDGET_DAILY = 300 per day');
    expect(within(dialog).getByLabelText('Hourly budget')).toBeDisabled();
    expect(within(dialog).getByLabelText('Daily budget')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Use the defaults' })).toBeDisabled();
  });

  it("shows the router's refusal inside the dialog and keeps it open", async () => {
    mockApi({
      '/me': me,
      '/tools': tools(adapter()),
      '/adapters/teamtailor/budget': new Response(
        JSON.stringify({ error: 'env_locked', message: 'TEAMTAILOR_BUDGET_HOURLY sets it: unset it to change it here.' }),
        {
          status: 409,
        },
      ),
    });
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.clear(within(dialog).getByLabelText('Hourly budget'));
    await user.type(within(dialog).getByLabelText('Hourly budget'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('TEAMTAILOR_BUDGET_HOURLY sets it: unset it to change it here.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Budget of Teamtailor' })).toBeInTheDocument();
  });

  it('asks to sign in again, and closes, when the change needs a recent sign-in', async () => {
    mockApi({
      '/me': me,
      '/tools': tools(adapter()),
      '/adapters/teamtailor/budget': new Response(
        JSON.stringify({ error: 'reauth_required', message: 'Sign in again to make this change.' }),
        { status: 401 },
      ),
    });
    vi.spyOn(navigation, 'toLogin').mockImplementation(() => undefined);
    renderApp('/tools');
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.clear(within(dialog).getByLabelText('Hourly budget'));
    await user.type(within(dialog).getByLabelText('Hourly budget'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Changes need a recent sign-in. Sign in again to continue.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens for a disabled adapter and for a utility too', async () => {
    mockApi({ '/me': me, '/tools': tools(linkedin, utility()) });
    renderApp('/tools');
    const user = userEvent.setup();
    await pick(user, await screen.findByLabelText('LinkedIn'), 'Budget…');
    expect(await screen.findByRole('dialog', { name: 'Budget of LinkedIn' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await pick(user, screen.getByLabelText('ATS discovery'), 'Budget…');
    expect(await screen.findByRole('dialog', { name: 'Budget of ATS discovery' })).toBeInTheDocument();
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
