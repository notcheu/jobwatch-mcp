import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, badSearchRow, jobSearch, me, mockApi, renderApp, searchRef, searchRow, tools } from './test-utils';

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
  foundBy: [searchRef(['react']), searchRef(['frontend', 'react'])],
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...job(),
  description: 'About us.\n\nWhat you will do\n- Build things with React',
  summary: 'Build things with React.',
  summaryKind: 'sections',
  outline: [{ part: 'role', chars: 120 }],
  hints: { years: [5], remote: ['hybrid'], salary: '60-70k€' },
  foundBy: [jobSearch()],
  ...over,
});

const page = (jobs: unknown[], total = jobs.length) => ({ jobs, total, page: 1, pageSize: 25 });
const common = { '/me': me, '/tools': tools };
const rowsLoaded = async (count: number) => {
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(count));
  return screen.getAllByRole('row');
};
/** Found by is off by default: turn it on from the Columns menu. */
const showFoundBy = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText('Columns'));
  await user.click(screen.getByLabelText('Found by'));
  await user.keyboard('{Escape}');
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
    const user = userEvent.setup();
    expect(await screen.findByText('Senior Frontend Engineer')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Found by' })).not.toBeInTheDocument(); // off by default
    await showFoundBy(user);
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
    // the searches that found it are in a section that stays closed until it is asked for
    expect(within(panel).getByRole('button', { name: 'Found by 1 search' })).toHaveAttribute('aria-expanded', 'false');
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
      searchRow({ disallowed: ['intern', 'senior'] }), // sorted, as the router sends them
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
        excludedBy: null,
        timesListed: 3,
      },
      {
        id: '1000002',
        title: 'Intern',
        company: 'Beta',
        location: null,
        url: null,
        lastSeen: NOW,
        outcome: 'excluded',
        excludedBy: { reason: 'title', term: 'intern' },
        timesListed: 1,
      },
      {
        id: '1000003',
        title: null,
        company: null,
        location: null,
        url: null,
        lastSeen: null,
        outcome: 'other',
        excludedBy: null,
        timesListed: 1,
      },
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
    // its disallowed terms are in a column of their own, one badge each, so two searches with the same keywords can be told apart
    expect(screen.getByRole('columnheader', { name: 'Disallowed terms' })).toBeInTheDocument();
    const terms = within(at(rows, 1));
    expect(terms.getByText('senior')).toBeInTheDocument();
    expect(terms.getByText('intern')).toBeInTheDocument();
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
    const seen = mockApi({ ...common, '/searches': searches, '/searches/linkedin': searchDetail({ disallowed: ['intern', 'senior'] }) });
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
    const asking = new URLSearchParams(asked.split('?')[1]);
    expect(asking.getAll('keywords')).toEqual(['react engineer']);
    expect(asking.getAll('disallowed')).toEqual(['intern', 'senior']); // the search is its keywords and its terms
    const without = within(within(panel).getByText(/^without/));
    expect(without.getByText('intern')).toBeInTheDocument(); // its terms, one badge each, in their own colour
    expect(without.getByText('senior')).toBeInTheDocument();
    expect(within(panel).getByText('Dropped: “intern” in the title')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('links from the detail to the list of the jobs the search found, with its keywords', async () => {
    mockApi({ ...common, '/searches': searches, '/searches/linkedin': searchDetail({ keywords: ['react', 'vue'], disallowed: [] }) });
    renderApp('/searches/linkedin?k=react&k=vue&days=7');
    const link = await screen.findByRole('link', { name: /See all the jobs this search found/ });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/jobs');
    expect(href.searchParams.getAll('found_by')).toEqual(['react', 'vue']);
    expect(href.searchParams.get('no_disallowed')).toBe('1'); // exactly this search: it had no disallowed terms
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

  it('links the search with its disallowed terms to exactly the jobs it found', async () => {
    mockApi({
      ...common,
      '/searches': searches,
      '/searches/linkedin': searchDetail({ keywords: ['react'], disallowed: ['intern', 'senior'] }),
    });
    renderApp('/searches/linkedin?k=react&d=intern&d=senior&days=7');
    const link = await screen.findByRole('link', { name: /See all the jobs this search found/ });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.searchParams.getAll('disallowed')).toEqual(['intern', 'senior']);
    expect(href.searchParams.get('no_disallowed')).toBeNull();
  });

  it('cuts a keyword that is too long inside its badge, and puts the searches that differ by terms on one line of the job table', async () => {
    const long = 'a very long keyword '.repeat(8).trim();
    mockApi({
      ...common,
      '/jobs': page([job({ foundBy: [searchRef([long]), searchRef(['react'], ['senior']), searchRef(['react'], ['intern'])] })]),
    });
    renderApp('/jobs');
    const user = userEvent.setup();
    await rowsLoaded(2);
    await showFoundBy(user);
    const rows = await rowsLoaded(2);
    const badge = within(at(rows, 1)).getByTitle(long);
    expect(badge).toHaveClass('max-w-full', 'overflow-hidden', 'text-ellipsis'); // it cannot grow out of the column
    // the same keywords with two sets of terms is one line, with the terms in its tooltip
    expect(within(at(rows, 1)).getAllByText('react')).toHaveLength(1);
    expect(within(at(rows, 1)).getByTitle('Without: senior, intern')).toBeInTheDocument();
  });
});

describe('the searches that found a job', () => {
  const found = [
    jobSearch({ keywords: ['react', 'vue'], disallowed: ['senior'], outcome: 'returned' }),
    jobSearch({
      keywords: ['react'],
      disallowed: ['intern', 'manager'],
      outcome: 'excluded',
      excludedBy: { reason: 'title', term: 'manager' },
      health: { status: 'bad', issues: ['mostly_discarded'], discardedShare: 0.9 },
      jobsFound: 10,
      jobsExcluded: 9,
    }),
    jobSearch({ keywords: [], disallowed: [], outcome: 'other', source: undefined }),
  ];
  const open = async () => {
    mockApi({ ...common, '/jobs': page([job()]), '/jobs/linkedin/1000001': detail({ foundBy: found }) });
    renderApp('/jobs');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(2), 1));
    return { user, panel: await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' }) };
  };

  it('is a closed section by default: only its title shows, with how many searches there are', async () => {
    const { panel } = await open();
    const toggle = within(panel).getByRole('button', { name: 'Found by 3 searches' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel).queryByRole('table', { name: 'Searches that found this job' })).not.toBeInTheDocument();
    expect(within(panel).queryByText('manager')).not.toBeInTheDocument();
  });

  it('opens into a short table of the searches: keywords and terms, what each did with this job, and health', async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole('button', { name: 'Found by 3 searches' }));
    const table = within(panel).getByRole('table', { name: 'Searches that found this job' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(heads).toEqual(['Search', 'This job · health', 'Open']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    const first = within(at(rows, 1));
    expect(first.getByText('react')).toBeInTheDocument();
    expect(first.getByText('vue')).toBeInTheDocument(); // one badge per keyword
    expect(first.getByText('senior')).toBeInTheDocument(); // and per disallowed term
    expect(first.getByText('without')).toBeInTheDocument(); // under the keywords, in their own colour
    expect(first.getByText('returned')).toBeInTheDocument();
    expect(first.getByText('healthy')).toBeInTheDocument();
    const second = within(at(rows, 2));
    expect(second.getByText('dropped')).toBeInTheDocument();
    expect(second.getByText('by “manager”')).toBeInTheDocument(); // the term that dropped it, on its own line
    expect(second.getByTitle('Dropped: “manager” in the title')).toBeInTheDocument();
    expect(second.getByText('90% discarded')).toBeInTheDocument();
    expect(within(at(rows, 3)).queryByText('without')).not.toBeInTheDocument(); // a search with no terms has no such line
    expect(within(at(rows, 3)).getByText('(no keywords)')).toBeInTheDocument();
    expect(within(at(rows, 3)).getByText('not returned')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Found by 3 searches' }));
    expect(within(panel).queryByRole('table', { name: 'Searches that found this job' })).not.toBeInTheDocument(); // and closes again
  });

  it('links each row to its search, terms included, and says when a salary dropped the job', async () => {
    mockApi({
      ...common,
      '/jobs': page([job()]),
      '/jobs/linkedin/1000001': detail({
        foundBy: [
          jobSearch({
            keywords: ['react'],
            disallowed: ['intern'],
            outcome: 'excluded',
            excludedBy: { reason: 'salary', term: '40000-45000 EUR' },
          }),
        ],
      }),
    });
    renderApp('/jobs');
    const user = userEvent.setup();
    await user.click(at(await rowsLoaded(2), 1));
    const panel = await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' });
    await user.click(within(panel).getByRole('button', { name: 'Found by 1 search' }));
    expect(within(panel).getByText('by its salary')).toBeInTheDocument();
    expect(within(panel).getByTitle('Dropped: its salary (40000-45000 EUR) is under the floor')).toBeInTheDocument();
    const link = within(panel).getByRole('link', { name: 'Open the search react' });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/searches/linkedin');
    expect(href.searchParams.getAll('k')).toEqual(['react']);
    expect(href.searchParams.getAll('d')).toEqual(['intern']);
  });

  it('has no section for a job that no search listed', async () => {
    mockApi({ ...common, '/jobs': page([job()]), '/jobs/linkedin/1000001': detail({ foundBy: [] }) });
    renderApp('/jobs');
    await userEvent.setup().click(at(await rowsLoaded(2), 1));
    const panel = await screen.findByRole('complementary', { name: 'Senior Frontend Engineer' });
    expect(within(panel).queryByRole('button', { name: /^Found by/ })).not.toBeInTheDocument();
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
