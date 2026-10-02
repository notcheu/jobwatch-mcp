import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, me, mockApi, renderApp, tools } from './test-utils';

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
  foundBy: ['react', 'frontend'],
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...job(),
  description: 'About us.\n\nWhat you will do\n- Build things with React',
  summary: 'Build things with React.',
  summaryKind: 'sections',
  outline: [{ part: 'role', chars: 120 }],
  hints: { stack: ['react'], years: [5], remote: ['hybrid'], salary: '60-70k€' },
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
    expect(first.getByText('react')).toBeInTheDocument();
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
    expect(within(panel).getAllByText('react')).toHaveLength(2); // as a stack hint and as the keyword that found it
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
      { source: 'linkedin', query: 'react engineer', runs: 4, lastRun: NOW, jobsFound: 80, jobsReturned: 30, jobsNew: 20 },
      { source: 'linkedin', query: 'vue', runs: 2, lastRun: NOW, jobsFound: 10, jobsReturned: 0, jobsNew: 0 },
      { source: 'wttj', query: '', runs: 1, lastRun: NOW, jobsFound: 12, jobsReturned: 12, jobsNew: 12 },
    ],
  };

  it('shows each keyword with its runs, jobs found, returned and new, and the share that was new', async () => {
    mockApi({ ...common, '/searches': searches });
    renderApp('/searches');
    const rows = await rowsLoaded(4);
    const react = within(at(rows, 1));
    expect(react.getByText('react engineer')).toBeInTheDocument();
    expect(react.getByText('25%')).toBeInTheDocument();
    expect(within(at(rows, 2)).getByText('0%')).toBeInTheDocument(); // a keyword that brings nothing new stands out
    expect(within(at(rows, 3)).getByText('(no keywords)')).toBeInTheDocument();
  });

  it('opens the jobs of a keyword when its row is clicked', async () => {
    const seen = mockApi({ ...common, '/searches': searches, '/jobs': page([job()]) });
    renderApp('/searches');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(4), 1));
    expect(await screen.findByLabelText('Found by keyword')).toHaveValue('react engineer');
    await waitFor(() =>
      expect(seen.some((url) => url.startsWith('/dashboard/api/v1/jobs') && url.includes('found_by=react+engineer'))).toBe(true),
    );
  });

  it('asks only for the selected tool and says what an empty list means', async () => {
    const seen = mockApi({ ...common, '/searches': { searches: [] } });
    renderApp('/searches?tool=wttj');
    expect(await screen.findByText(/No search recorded in this window/)).toBeInTheDocument();
    expect(seen.some((url) => url.startsWith('/dashboard/api/v1/searches') && url.includes('source=wttj'))).toBe(true);
  });
});
