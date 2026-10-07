import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, badSearchRow, me, mockApi, renderApp, searchRow, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const job = (over: Record<string, unknown> = {}) => ({
  source: 'linkedin',
  id: '1000001',
  board: null,
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Paris',
  url: 'https://example.com/jobs/1000001',
  firstSeen: NOW,
  fetchedAt: NOW,
  lastSeen: NOW,
  descriptionChars: 4200,
  salary: { min: 72_000, max: 115_000, currency: 'EUR', variable: null },
  foundBy: [{ keywords: ['react'] }, { keywords: ['frontend', 'react'] }],
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...job(),
  description: 'About us.\n\nWhat you will do\n- Build things with React',
  summary: 'Build things with React.',
  summaryKind: 'sections',
  outline: [{ part: 'role', chars: 120 }],
  hints: { years: [5], remote: ['hybrid'], salary: '60-70k€' },
  ...over,
});

const page = (jobs: unknown[], total = jobs.length) => ({ jobs, total, page: 1, pageSize: 25 });
const common = { '/me': me, '/tools': tools };
const rowsLoaded = async (count: number) => {
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(count));
  return screen.getAllByRole('row');
};
const at = <T,>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`nothing at position ${index}`);
  return item;
};

describe('jobs table', () => {
  it('lists the stored jobs without their text, with source, board, keywords and size', async () => {
    mockApi({
      ...common,
      '/jobs': page([
        job(),
        job({ id: '2', source: 'teamtailor', board: 'bsport', title: 'VP Engineering', foundBy: [], descriptionChars: 900 }),
      ]),
    });
    renderApp('/jobs');
    const rows = await rowsLoaded(3);
    const first = within(at(rows, 1));
    expect(first.getByText('Senior Frontend Engineer')).toBeInTheDocument();
    expect(first.getByText('linkedin')).toBeInTheDocument();
    expect(first.getAllByText('react')).toHaveLength(2); // one badge for each search that found it
    expect(first.getByText('4.2k')).toBeInTheDocument();
    expect(within(at(rows, 2)).getByText('bsport')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/Build things/)).not.toBeInTheDocument();
  });

  it('sends the filters of the URL to the server: tool tab, text, keyword, dates and page', async () => {
    const seen = mockApi({ ...common, '/jobs': page([job()], 80) });
    renderApp('/jobs?tool=linkedin&q=react&found_by=react&from=2026-10-01&to=2026-10-09&page=2&pageSize=10&sort=title&dir=asc&board=acme');
    await rowsLoaded(2);
    const call = seen.find((url) => url.startsWith('/dashboard/api/v1/jobs?')) ?? '';
    const query = new URLSearchParams(call.split('?')[1]);
    expect(Object.fromEntries(query)).toMatchObject({
      source: 'linkedin',
      q: 'react',
      found_by: 'react',
      from: '2026-10-01',
      to: '2026-10-09',
      page: '2',
      pageSize: '10',
      sort: 'title',
      dir: 'asc',
      board: 'acme',
    });
  });

  it('sorts on the server when a header is clicked, and shows the direction', async () => {
    const seen = mockApi({ ...common, '/jobs': page([job()]) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    await user.click(screen.getByRole('button', { name: /^Title/ }));
    await waitFor(() => expect(seen.some((url) => url.includes('sort=title') && url.includes('dir='))).toBe(true));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: /Title/ })).toHaveAttribute('aria-sort'));
  });

  it('pages: next and previous change the page, and the first page has no previous', async () => {
    const seen = mockApi({ ...common, '/jobs': page([job()], 60) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(seen.some((url) => url.includes('page=2'))).toBe(true));
  });

  it('searches after the typist stops, not on every key', async () => {
    const seen = mockApi({ ...common, '/jobs': page([job()]) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    await user.type(screen.getByLabelText('Search jobs'), 'react');
    await waitFor(() => expect(seen.some((url) => url.includes('q=react'))).toBe(true));
    expect(seen.filter((url) => /q=r(e|ea|eac)?(&|$)/.test(url))).toHaveLength(0);
  });

  it('hides a column from the menu', async () => {
    mockApi({ ...common, '/jobs': page([job()]) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeInTheDocument();
    await user.click(screen.getByText('Columns'));
    await user.click(screen.getByLabelText('Location'));
    expect(screen.queryByRole('columnheader', { name: 'Location' })).not.toBeInTheDocument();
  });

  it('links to the posting only when the address is https, and opens it safely', async () => {
    mockApi({
      ...common,
      '/jobs': page([
        job(),
        job({ id: '2', title: 'Bad link', url: 'javascript:alert(1)' }),
        job({ id: '3', title: 'Plain http', url: 'http://example.com/x' }),
      ]),
    });
    renderApp('/jobs');
    await rowsLoaded(4);
    const links = screen.getAllByRole('link', { name: /on the site/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/jobs/1000001');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(links[0]).toHaveAttribute('target', '_blank');
  });

  it('moves between rows with the arrow keys and opens one with Enter', async () => {
    mockApi({
      ...common,
      '/jobs': page([job(), job({ id: '2', title: 'Second' })]),
      '/jobs/linkedin/2': detail({ id: '2', title: 'Second' }),
    });
    renderApp('/jobs');
    const user = userEvent.setup();
    const rows = await rowsLoaded(3);
    at(rows, 1).focus();
    await user.keyboard('{ArrowDown}');
    expect(at(rows, 2)).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(at(rows, 1)).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('complementary', { name: 'Second' })).toBeInTheDocument();
  });

  it('has an empty state that says what to change', async () => {
    mockApi({ ...common, '/jobs': page([]) });
    renderApp('/jobs');
    expect(await screen.findByText(/No stored job matches/)).toBeInTheDocument();
    expect(screen.getByText('0–0 of 0')).toBeInTheDocument();
  });
});

describe('job detail', () => {
  it('opens on the right with the description, summary, hints, keywords and the link', async () => {
    mockApi({ ...common, '/jobs': page([job()]), '/jobs/linkedin/1000001': detail() });
    renderApp('/jobs');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(2), 1));
    const panel = await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' });
    expect(within(panel).getByLabelText('Description').textContent).toContain('Build things with React');
    expect(within(panel).getByText('Build things with React.')).toBeInTheDocument();
    expect(within(panel).getAllByText('react').length).toBeGreaterThan(0); // the keyword that found it
    expect(within(panel).getByText('5+ years')).toBeInTheDocument();
    expect(within(panel).getByText('60-70k€')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Open on the site/ })).toHaveAttribute('href', 'https://example.com/jobs/1000001');
    expect(within(panel).getByRole('button', { name: 'Copy the description' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('shows a description as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script> **bold**';
    mockApi({
      ...common,
      '/jobs': page([job()]),
      '/jobs/linkedin/1000001': detail({ description: hostile, summary: hostile, title: '<b>Title</b>' }),
    });
    renderApp('/jobs/linkedin/1000001');
    const description = await screen.findByLabelText('Description');
    expect(description.textContent).toBe(hostile);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('says when the job is no longer stored', async () => {
    mockApi({ ...common, '/jobs': page([]) });
    renderApp('/jobs/linkedin/9');
    expect(await screen.findByText('That job is no longer stored.')).toBeInTheDocument();
  });
});

describe('searches', () => {
  const searches = {
    searches: [
      searchRow(),
      searchRow({ keywords: ['vue'], runs: 2, jobsFound: 10, jobsReturned: 0, jobsExcluded: 0, jobsNew: 0 }),
      searchRow({ source: 'wttj', keywords: [], runs: 1, jobsFound: 12, jobsReturned: 12, jobsExcluded: 0, jobsNew: 12 }),
      badSearchRow(),
      searchRow({ keywords: ['react', 'vue', 'svelte'], runs: 1 }),
    ],
  };
  const searchDetail = (over: Record<string, unknown> = {}) => ({
    ...searchRow(),
    jobs: [
      {
        id: '1000001',
        title: 'Senior Frontend Engineer',
        company: 'Acme',
        location: 'Paris',
        url: null,
        lastSeen: NOW,
        outcome: 'returned',
        timesListed: 3,
      },
      { id: '1000002', title: 'Intern', company: 'Beta', location: null, url: null, lastSeen: NOW, outcome: 'excluded', timesListed: 1 },
      { id: '1000003', title: null, company: null, location: null, url: null, lastSeen: null, outcome: 'other', timesListed: 1 },
    ],
    jobsTruncated: false,
    ...over,
  });

  it('shows each search with one badge per keyword, its health, and the jobs discarded by the terms', async () => {
    mockApi({ ...common, '/searches': searches });
    renderApp('/searches');
    const rows = await rowsLoaded(6);
    const react = within(at(rows, 1));
    expect(react.getByText('react engineer')).toBeInTheDocument();
    expect(react.getByText('healthy')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('(no keywords)')).toBeInTheDocument();
    const several = within(at(rows, 5));
    for (const keyword of ['react', 'vue', 'svelte']) expect(several.getByText(keyword)).toBeInTheDocument(); // one badge each
    expect(within(at(rows, 4)).getByText('90% discarded')).toBeInTheDocument(); // a search that wastes calls stands out
  });

  it('makes every row clickable, the one without keywords too', async () => {
    mockApi({ ...common, '/searches': searches, '/searches/wttj': searchDetail({ source: 'wttj', keywords: [] }) });
    renderApp('/searches');
    const user = userEvent.setup();
    const rows = await rowsLoaded(6);
    for (const row of rows.slice(1)) expect(row).toHaveClass('cursor-pointer');
    await user.click(at(rows, 3));
    expect(await screen.findByRole('complementary', { name: 'wttj: no keywords' })).toBeInTheDocument();
  });

  it('opens the detail of the search, with its health and its jobs, instead of going to the job list', async () => {
    const seen = mockApi({ ...common, '/searches': searches, '/searches/linkedin': searchDetail() });
    renderApp('/searches');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(6), 1));
    const panel = await screen.findByRole('complementary', { name: 'linkedin: react engineer' });
    expect(screen.queryByLabelText('Found by keywords')).not.toBeInTheDocument(); // still on the Searches page
    const health = within(panel).getByRole('region', { name: 'Health' });
    expect(within(health).getByText('healthy')).toBeInTheDocument();
    expect(within(health).getByRole('img', { name: '70 of 80 jobs matched, 10 discarded' })).toBeInTheDocument();
    expect(health).toHaveTextContent('Jobs found80');
    expect(health).toHaveTextContent('Matched70');
    expect(health).toHaveTextContent('Discarded10');
    const list = within(panel).getByRole('list', { name: 'Jobs of this search' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('returned')).toBeInTheDocument();
    expect(within(list).getByText('discarded')).toBeInTheDocument();
    expect(within(list).getByText('Job no longer stored')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Senior Frontend Engineer' })).toHaveAttribute('href', '/jobs/linkedin/1000001');
    const asked = seen.find((url) => url.startsWith('/dashboard/api/v1/searches/linkedin')) ?? '';
    expect(new URLSearchParams(asked.split('?')[1]).getAll('keywords')).toEqual(['react engineer']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('links from the detail to the list of the jobs the search found, with its keywords', async () => {
    mockApi({ ...common, '/searches': searches, '/searches/linkedin': searchDetail({ keywords: ['react', 'vue'] }) });
    renderApp('/searches/linkedin?k=react&k=vue&days=7');
    const link = await screen.findByRole('link', { name: /See all the jobs this search found/ });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/jobs');
    expect(href.searchParams.getAll('found_by')).toEqual(['react', 'vue']);
    expect(href.searchParams.get('tool')).toBe('linkedin');
  });

  it('links a search without keywords to the jobs found by no keyword', async () => {
    mockApi({ ...common, '/searches': searches, '/searches/wttj': searchDetail({ source: 'wttj', keywords: [] }) });
    renderApp('/searches/wttj?days=7');
    const link = await screen.findByRole('link', { name: /See all the jobs this search found/ });
    expect(new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get('no_keywords')).toBe('1');
  });

  it('explains a search in bad health, and lists the discarded jobs as such', async () => {
    mockApi({
      ...common,
      '/searches': searches,
      '/searches/linkedin': searchDetail({ ...badSearchRow(), jobs: [], jobsTruncated: true }),
    });
    renderApp('/searches/linkedin?k=intern&days=7');
    const health = await screen.findByRole('region', { name: 'Health' });
    expect(within(health).getByText('90% discarded')).toBeInTheDocument();
    expect(health).toHaveTextContent('Most of the jobs it finds are dropped by the disallowed terms or the salary floor.');
    expect(screen.getByText(/Only the first jobs are listed here/)).toBeInTheDocument();
  });

  it('says when the search did not run in the window', async () => {
    mockApi({ ...common, '/searches': searches });
    renderApp('/searches/linkedin?k=ghost&days=7');
    expect(await screen.findByText(/did not run in the last 7 days/)).toBeInTheDocument();
  });

  it('asks only for the selected tool and says what an empty list means', async () => {
    const seen = mockApi({ ...common, '/searches': { searches: [] } });
    renderApp('/searches?tool=wttj');
    expect(await screen.findByText(/No search recorded in this window/)).toBeInTheDocument();
    expect(seen.some((url) => url.startsWith('/dashboard/api/v1/searches') && url.includes('source=wttj'))).toBe(true);
  });

  it('links from a job to the search that found it, and shows a keyword that is too long inside its badge', async () => {
    const long = 'a very long keyword '.repeat(8).trim();
    mockApi({
      ...common,
      '/jobs': page([job({ foundBy: [{ keywords: ['react'] }, { keywords: [long] }] })]),
      '/jobs/linkedin/1000001': detail({ foundBy: [{ keywords: ['react', 'vue'] }, { keywords: [] }] }),
    });
    renderApp('/jobs');
    const user = userEvent.setup();
    const rows = await rowsLoaded(2);
    const badge = within(at(rows, 1)).getByTitle(long);
    expect(badge).toHaveClass('max-w-full', 'overflow-hidden', 'text-ellipsis'); // it cannot grow out of the column
    await user.click(at(rows, 1));
    const panel = await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' });
    const links = within(panel).getAllByRole('link', { name: /Open the search/ });
    expect(links).toHaveLength(2);
    const first = new URL(links[0]?.getAttribute('href') ?? '', 'http://x');
    expect(first.pathname).toBe('/searches/linkedin');
    expect(first.searchParams.getAll('k')).toEqual(['react', 'vue']);
    expect(within(panel).getByText('(no keywords)')).toBeInTheDocument();
  });
});

describe('salary column', () => {
  const fixed = { min: 65_000, max: 65_000, currency: 'EUR', variable: null };

  it('shows a range as a range, a fixed amount as one value, and a dash when the text states none', async () => {
    mockApi({
      ...common,
      '/jobs': page([job(), job({ id: '2', title: 'Fixed', salary: fixed }), job({ id: '3', title: 'Unstated', salary: null })]),
    });
    renderApp('/jobs');
    const rows = await rowsLoaded(4);
    expect(within(at(rows, 1)).getByText(/72\D?000.*115\D?000/)).toBeInTheDocument(); // the browser's own number format
    expect(within(at(rows, 2)).getByText(/65\D?000/)).toBeInTheDocument();
    expect(within(at(rows, 3)).queryByText(/€|EUR/)).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Salary/ })).toBeInTheDocument();
  });

  it('sorts on the server by salary', async () => {
    const seen = mockApi({ ...common, '/jobs': page([job()]) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    await user.click(screen.getByRole('button', { name: /^Salary/ }));
    await waitFor(() => expect(seen.some((url) => url.includes('sort=salary'))).toBe(true));
  });

  it('shows it in the detail too', async () => {
    mockApi({ ...common, '/jobs': page([job()]), '/jobs/linkedin/1000001': detail() });
    renderApp('/jobs');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(2), 1));
    const panel = await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' });
    expect(within(panel).getByText('Salary (yearly)')).toBeInTheDocument();
  });
});
