import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const param = (over: Record<string, unknown>) => ({
  name: 'p',
  type: 'string',
  required: false,
  default: null,
  enum: null,
  min: null,
  max: null,
  description: '',
  ...over,
});

const searchTool = {
  name: 'linkedin_search',
  title: 'Search jobs (read-only)',
  description: 'Scans search results and returns the jobs. Read-only, no side effects.',
  annotations: { readOnly: true, idempotent: true, openWorld: true },
  needsBrowser: true,
  costMax: 60,
  params: [
    param({ name: 'keywords', required: true, max: 120, description: 'What to search for.' }),
    param({ name: 'detail', type: 'string', enum: ['summary', 'full', 'none'], default: 'summary', description: 'How much text.' }),
    param({ name: 'max_results', type: 'integer', default: 50, min: 1, max: 200 }),
  ],
  sampleInput: { keywords: '<keywords>' },
  examples: [
    {
      title: 'Jobs from the last day',
      prompt: 'Search LinkedIn for <job title> jobs in <place> posted in the last 24 hours.',
      input: { keywords: '<job title>', geo: '<place>', posted_within: 'last_24_hours' },
    },
  ],
};
const module = (over: Record<string, unknown> = {}) => ({
  id: 'linkedin',
  displayName: 'LinkedIn',
  description: 'Search and read LinkedIn jobs.',
  role: 'adapter',
  kind: 'browser',
  enabled: true,
  allowedHosts: ['www.linkedin.com'],
  openHttps: false,
  tools: [searchTool],
  ...over,
});
const docs = {
  modules: [
    module(),
    module({ id: 'wttj', displayName: 'WTTJ', enabled: false, tools: [] }),
    module({
      id: 'ats-discovery',
      displayName: 'ATS discovery',
      role: 'utility',
      kind: 'http',
      enabled: true,
      openHttps: true,
      tools: [{ ...searchTool, name: 'ats_find', title: 'Find the ATS', needsBrowser: false, examples: [], params: [] }],
    }),
  ],
};

describe('docs', () => {
  it('lists the adapters with whether each is enabled, and the utilities on their own tab', async () => {
    mockApi({ '/me': me, '/tools': tools, '/docs': docs });
    renderApp('/docs');
    const user = userEvent.setup();
    const linkedin = await screen.findByLabelText('LinkedIn');
    expect(within(linkedin).getByText('enabled')).toBeInTheDocument();
    expect(within(screen.getByLabelText('WTTJ')).getByText('disabled')).toBeInTheDocument();
    expect(screen.queryByLabelText('ATS discovery')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Utilities' }));
    expect(await screen.findByLabelText('ATS discovery')).toBeInTheDocument();
    expect(screen.queryByLabelText('LinkedIn')).not.toBeInTheDocument();
  });

  it('opens a tool to show its hints, hosts and a parameter table read from the schema', async () => {
    mockApi({ '/me': me, '/tools': tools, '/docs': docs });
    renderApp('/docs');
    const user = userEvent.setup();
    expect(screen.queryByRole('table', { name: 'Parameters' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Show linkedin_search' }));
    expect(screen.getByRole('button', { name: 'Hide linkedin_search' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0);
    expect(screen.getAllByText('idempotent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('open-world').length).toBeGreaterThan(0);
    expect(screen.getByText(/Reaches: www.linkedin.com · reserves up to 60 budget units per call/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Parameters' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['keywords', 'string', 'yes', '—', '—', '—', '120', 'What to search for.']);
    expect(rows[2]).toHaveTextContent('summary | full | none');
    expect(rows[3]).toHaveTextContent('integer');
    expect(rows[3]).toHaveTextContent('1');
    expect(rows[3]).toHaveTextContent('200');
    await user.click(screen.getByRole('button', { name: 'Hide linkedin_search' }));
    expect(screen.queryByRole('table', { name: 'Parameters' })).not.toBeInTheDocument();
  });

  it('copies an example prompt and its input, and the smallest input, and says so', async () => {
    mockApi({ '/me': me, '/tools': tools, '/docs': docs });
    renderApp('/docs');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show linkedin_search' }));
    await user.click(screen.getByRole('button', { name: 'Copy the prompt: Jobs from the last day' }));
    expect(await navigator.clipboard.readText()).toBe('Search LinkedIn for <job title> jobs in <place> posted in the last 24 hours.');
    expect(screen.getByRole('button', { name: 'Copy the prompt: Jobs from the last day' })).toHaveTextContent('Copied');
    await user.click(screen.getByRole('button', { name: 'Copy the input: Jobs from the last day' }));
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual({
      keywords: '<job title>',
      geo: '<place>',
      posted_within: 'last_24_hours',
    });
    await user.click(screen.getByRole('button', { name: 'Copy the smallest input of linkedin_search' }));
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual({ keywords: '<keywords>' });
    expect(screen.getByText(/Replace the values in <angle brackets>/)).toBeInTheDocument();
  });

  it('says so when the clipboard refuses', async () => {
    mockApi({ '/me': me, '/tools': tools, '/docs': docs });
    renderApp('/docs');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show linkedin_search' }));
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy the smallest input of linkedin_search' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('says a tool takes no arguments, and that an open HTTP module reaches any public host', async () => {
    mockApi({ '/me': me, '/tools': tools, '/docs': docs });
    renderApp('/docs?kind=utilities');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show ats_find' }));
    expect(screen.getByText('This tool takes no arguments.')).toBeInTheDocument();
    expect(screen.getByText(/any public https host/)).toBeInTheDocument();
  });

  it('shows an error when the documentation cannot load', async () => {
    mockApi({ '/me': me, '/tools': tools });
    renderApp('/docs');
    expect(await screen.findByText('Could not load the documentation.')).toBeInTheDocument();
  });
});
