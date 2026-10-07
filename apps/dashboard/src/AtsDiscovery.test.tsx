import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const match = (over: Record<string, unknown> = {}) => ({
  ats: 'greenhouse',
  handle: 'acme',
  jobs: 4,
  boardUrl: 'https://boards.greenhouse.io/acme',
  mapped: false,
  ...over,
});
const lookup = (over: Record<string, unknown> = {}) => ({ id: 1, at: NOW, company: 'Acme', tried: ['acme'], matches: [match()], ...over });
const board = (over: Record<string, unknown> = {}) => ({
  id: 7,
  company: 'Société Générale',
  ats: 'lever',
  handle: 'sg',
  createdAt: NOW,
  ...over,
});
const common = { '/me': me, '/tools': tools };

describe('ATS discovery page', () => {
  it('lists the past lookups, and offers to assign a board only where the company has none on that ATS', async () => {
    mockApi({
      ...common,
      '/ats-lookups': {
        items: [
          lookup({ matches: [match(), match({ ats: 'lever', handle: 'acme', mapped: true })] }),
          lookup({ id: 2, company: 'Ghost', tried: ['ghost'], matches: [] }),
        ],
        total: 2,
      },
    });
    renderApp('/ats-discovery');
    const acme = (await screen.findByText('Acme')).closest('tr') as HTMLElement;
    expect(within(acme).getByRole('button', { name: 'Assign greenhouse acme to Acme' })).toBeInTheDocument();
    expect(within(acme).queryByRole('button', { name: /lever/ })).not.toBeInTheDocument();
    expect(within(acme).getByText('Mapped')).toBeInTheDocument();
    expect(within(acme).getAllByRole('link', { name: /acme/ })[0]).toHaveAttribute('href', 'https://boards.greenhouse.io/acme');
    expect(within(screen.getByText('Ghost').closest('tr') as HTMLElement).getByText('No board found')).toBeInTheDocument();
  });

  it('assigns the board of a lookup, and says so', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    mockApi({
      ...common,
      '/ats-lookups': { items: [lookup()], total: 1 },
      '/company-boards': (url: URL) =>
        url.search === '' ? board({ company: 'Acme', ats: 'greenhouse', handle: 'acme' }) : { items: [], total: 0 },
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') sent.push(JSON.parse(String(init.body)));
      return real(input, init);
    });
    renderApp('/ats-discovery');
    await user.click(await screen.findByRole('button', { name: 'Assign greenhouse acme to Acme' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Acme is now mapped to greenhouse/acme.');
    expect(sent).toEqual([{ company: 'Acme', ats: 'greenhouse', handle: 'acme' }]);
  });

  it('lists the mappings, searches them by company or board, and creates one by hand', async () => {
    const user = userEvent.setup();
    const seen = mockApi({
      ...common,
      '/company-boards': (url: URL) =>
        url.searchParams.get('q') === 'sg'
          ? { items: [board()], total: 1 }
          : { items: [board(), board({ id: 8, company: 'Acme', ats: 'ashby', handle: 'acme' })], total: 2 },
    });
    renderApp('/ats-discovery?view=mapping');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    await user.type(screen.getByLabelText('Search companies'), 'sg');
    await waitFor(() => expect(seen.some((url) => url.includes('q=sg'))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.getByText('Société Générale')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Add mapping' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Company'), 'Acme');
    await user.type(within(dialog).getByLabelText('Board handle'), '../x');
    expect(submit).toBeDisabled(); // not a handle
    await user.clear(within(dialog).getByLabelText('Board handle'));
    await user.type(within(dialog).getByLabelText('Board handle'), 'acme');
    expect(submit).toBeEnabled();
  });

  it('shows the refusal when the company already has a board on that ATS', async () => {
    const user = userEvent.setup();
    mockApi({
      ...common,
      '/ats-lookups': { items: [lookup()], total: 1 },
      '/company-boards': new Response(JSON.stringify({ error: 'exists', message: 'Acme already has a greenhouse board.' }), {
        status: 409,
      }),
    });
    renderApp('/ats-discovery');
    await user.click(await screen.findByRole('button', { name: 'Assign greenhouse acme to Acme' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Acme already has a greenhouse board.');
  });
});
