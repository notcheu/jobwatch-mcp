import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const hit = (over: Record<string, unknown> = {}) => ({ id: '103035651', label: 'Berlin, Germany', saved: 'none', ...over });
const lookup = (over: Record<string, unknown> = {}) => ({ id: 1, at: NOW, query: 'Berlin', source: 'search', hits: [hit()], ...over });
const place = (over: Record<string, unknown> = {}) => ({ alias: 'home', id: '555000', label: 'Home town', savedBy: 'operator', ...over });
const common = { '/me': me, '/tools': tools };

describe('LinkedIn places page', () => {
  it('lists the lookups, and offers a place only where the name is not already saved as it', async () => {
    mockApi({
      ...common,
      '/place-lookups': {
        items: [
          lookup({ hits: [hit({ saved: 'same' }), hit({ id: '90009712', label: 'Berlin Metropolitan Area', saved: 'other' })] }),
          lookup({ id: 2, query: 'Nowhere', source: 'tool', hits: [] }),
          lookup({ id: 3, query: 'Lisbon', hits: [hit({ id: '100364837', label: 'Lisbon, Portugal' })] }),
        ],
        total: 3,
      },
    });
    renderApp('/linkedin-places');
    const berlin = (await screen.findByText('Berlin')).closest('tr') as HTMLElement;
    expect(within(berlin).getByText('Saved')).toBeInTheDocument();
    expect(within(berlin).getByRole('button', { name: 'Use Berlin Metropolitan Area for Berlin' })).toHaveTextContent('Use instead');
    expect(within(berlin).queryByRole('button', { name: /Berlin, Germany/ })).not.toBeInTheDocument();
    expect(within(screen.getByText('Nowhere').closest('tr') as HTMLElement).getByText('LinkedIn suggested nothing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign Lisbon, Portugal for Lisbon' })).toBeInTheDocument();
  });

  it('assigns a candidate to the name that was looked up, and says so', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    mockApi({
      ...common,
      '/place-lookups': { items: [lookup()], total: 1 },
      '/places': place({ alias: 'berlin', id: '103035651', label: 'Berlin, Germany' }),
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') sent.push(JSON.parse(String(init.body)));
      return real(input, init);
    });
    renderApp('/linkedin-places');
    await user.click(await screen.findByRole('button', { name: 'Assign Berlin, Germany for Berlin' }));
    expect(await screen.findByRole('status')).toHaveTextContent('"berlin" now means Berlin, Germany (geoId 103035651).');
    expect(sent).toEqual([{ alias: 'Berlin', id: '103035651', label: 'Berlin, Germany' }]);
  });

  it('lists the saved places, searches them, validates the form of a new one, and forgets one', async () => {
    const user = userEvent.setup();
    const seen = mockApi({
      ...common,
      '/places': (url: URL) =>
        url.searchParams.get('q') === 'town'
          ? { items: [place()], total: 1 }
          : { items: [place(), place({ alias: 'berlin', id: '103035651', label: 'Berlin, Germany', savedBy: 'auto' })], total: 2 },
    });
    renderApp('/linkedin-places?view=places');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(screen.getByText('A search')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search places'), 'town');
    await waitFor(() => expect(seen.some((url) => url.includes('q=town'))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Add place' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Save place' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'work');
    await user.type(within(dialog).getByLabelText('LinkedIn geoId'), 'berlin');
    expect(submit).toBeDisabled(); // not a geoId
    await user.clear(within(dialog).getByLabelText('LinkedIn geoId'));
    await user.type(within(dialog).getByLabelText('LinkedIn geoId'), '103035651');
    expect(submit).toBeEnabled();
  });

  it('says when the linkedin-geo utility is not enabled', async () => {
    const first = tools.adapters[0] as Record<string, unknown>;
    const off = {
      ...tools,
      adapters: [{ ...first, id: 'linkedin-geo', platform: 'linkedin-geo', role: 'utility', kind: 'http', enabled: false }],
    };
    mockApi({ '/me': me, '/tools': off, '/place-lookups': { items: [], total: 0 } });
    renderApp('/linkedin-places');
    expect(await screen.findByRole('note')).toHaveTextContent('linkedin-geo utility is not enabled');
  });
});
