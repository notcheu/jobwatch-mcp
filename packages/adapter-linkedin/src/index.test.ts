import { AdapterBroken, Checkpoint, SessionInvalid } from '@jobwatch/sdk';
import { createBrowserTestContext, describeAdapterContract, type FakePage } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter, { createLinkedinAdapter, createLinkedinTools } from './index';
import { classicLayout } from './layouts/classic';

const tools = createLinkedinTools(classicLayout);
const SEARCH_URL = 'https://www.linkedin.com/jobs/search/';
const jobUrl = (id: string): string => `https://www.linkedin.com/jobs/view/${id}/`;

const cards = [
  { id: '4000000001', lines: ['Senior Frontend Engineer', 'Acme', 'Paris (Hybrid)', '1 hour ago'] },
  { id: '4000000002', lines: ['Software Intern', 'Beta', 'Paris', '2 hours ago'] },
  { id: '4000000003', lines: ['Staff Engineer', 'Gamma', 'France (Remote)', '3 hours ago'] },
  { id: '4000000004', lines: ['Principal Engineer', 'Delta', 'Paris', '4 hours ago'] },
];
const IDS = cards.map((card) => card.id);

function searchPage(overrides: Partial<{ cards: unknown[]; noResults: boolean; loginForm: boolean }> = {}): FakePage {
  return {
    present: ['li[data-occludable-job-id]'],
    evaluate: () => ({ classic: 4, ai: 0, cards, noResults: false, loginForm: false, ...overrides }),
  };
}

function jobPage(description: string | null, extra: { closed?: boolean; title?: string } = {}): FakePage {
  return {
    present: ['#job-details'],
    evaluate: () => ({ description, closed: extra.closed ?? false, title: extra.title ?? 'Role | Company | LinkedIn', loginForm: false }),
  };
}

/** A context whose search page lists the four cards and whose job pages say `descriptions[id]` (default: a plain text). */
function context(descriptions: Record<string, FakePage | string> = {}) {
  const pages: Record<string, FakePage> = { [SEARCH_URL]: searchPage() };
  for (const id of IDS) {
    const entry = descriptions[id] ?? `Description of ${id}. We use React and TypeScript.`;
    pages[jobUrl(id)] = typeof entry === 'string' ? jobPage(entry) : entry;
  }
  return createBrowserTestContext({ allowedHosts: adapter.allowedHosts, pages });
}

const visitedJobs = (visited: string[]): string[] =>
  visited.filter((url) => url.includes('/jobs/view/')).map((url) => url.split('/')[5] ?? '');
const read = (over: object = {}) => tools.searchAndRead.input.parse({ keywords: 'full stack', ...over });

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    linkedin_search: {
      args: { keywords: 'frontend' },
      run: (args) => tools.search.handler(tools.search.input.parse(args), context().ctx),
    },
    linkedin_job: {
      args: { ids: ['4000000001'] },
      run: (args) => tools.job.handler(tools.job.input.parse(args), context().ctx),
    },
    linkedin_search_and_read: {
      args: { keywords: 'frontend' },
      run: (args) => tools.searchAndRead.handler(tools.searchAndRead.input.parse(args), context().ctx),
    },
  },
});

describe('linkedin_search', () => {
  const args = (over: object = {}) => tools.search.input.parse({ keywords: 'x', geo: 'france', posted_within: 'any', ...over });

  it('returns normalized cards and flags the ones already stored', async () => {
    const { ctx, jobs } = context();
    await jobs.put({
      id: '4000000003',
      title: 'Staff Engineer',
      company: 'Gamma',
      location: null,
      url: jobUrl('4000000003'),
      description: 'd',
    });
    const result = await tools.search.handler(args(), ctx);
    expect(result.data.cards).toHaveLength(4);
    expect(result.data.cards.map((c) => [c.id, c.known])).toEqual([
      ['4000000001', false],
      ['4000000002', false],
      ['4000000003', true],
      ['4000000004', false],
    ]);
  });

  it('post-filters on remote and says so', async () => {
    const result = await tools.search.handler(args({ remote_only: true }), context().ctx);
    expect(result.data.cards.map((c) => c.id)).toEqual(['4000000003']);
    expect(result.warnings.join(' ')).toMatch(/post-filtered/);
  });

  it('reports an honest empty result only when the page says there are no results', async () => {
    const empty = (noResults: boolean) =>
      createBrowserTestContext({ allowedHosts: adapter.allowedHosts, pages: { [SEARCH_URL]: searchPage({ cards: [], noResults }) } }).ctx;
    expect((await tools.search.handler(args(), empty(true))).data.cards).toEqual([]);
    await expect(tools.search.handler(args(), empty(false))).rejects.toBeInstanceOf(AdapterBroken);
  });

  it('turns a login form into SessionInvalid and a checkpoint url into Checkpoint', async () => {
    const login = createBrowserTestContext({
      allowedHosts: adapter.allowedHosts,
      pages: { [SEARCH_URL]: searchPage({ cards: [], loginForm: true }) },
    }).ctx;
    await expect(tools.search.handler(args(), login)).rejects.toBeInstanceOf(SessionInvalid);
    const { ctx, session } = createBrowserTestContext({
      allowedHosts: adapter.allowedHosts,
      pages: { [SEARCH_URL]: searchPage(), 'https://www.linkedin.com/checkpoint/challenge/1': searchPage() },
    });
    const goto = session.goto.bind(session);
    session.goto = async (_url, options) => goto('https://www.linkedin.com/checkpoint/challenge/1', options);
    await expect(tools.search.handler(args(), ctx)).rejects.toBeInstanceOf(Checkpoint);
  });

  it('rejects arguments that could change the url', () => {
    const input = tools.search.input;
    expect(input.safeParse({ keywords: 'x', geo: 'x&f_AL=true' }).success).toBe(false);
    expect(input.safeParse({ keywords: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('linkedin_job', () => {
  const run = (ctx: ReturnType<typeof context>['ctx'], over: object) =>
    tools.job.handler(tools.job.input.parse({ ids: ['4000000001'], ...over }), ctx);

  it('opens, stores and returns a job, truncating what it returns but not what it stores', async () => {
    const c = context({ '4000000001': 'A'.repeat(4000) });
    const result = await run(c.ctx, { description_max_chars: 500 });
    expect(result.data.jobs[0]).toMatchObject({ id: '4000000001', source: 'fetched', description_truncated: true });
    expect(result.data.jobs[0]?.description).toHaveLength(500);
    expect((await c.jobs.get('4000000001'))?.description).toHaveLength(4000);
    expect(visitedJobs(c.session.visited)).toEqual(['4000000001']);
  });

  it('serves a stored job from memory without visiting LinkedIn, unless refresh is set', async () => {
    const c = context({ '4000000001': 'Original text' });
    await run(c.ctx, {});
    c.session.visited.length = 0;
    const again = await run(c.ctx, {});
    expect(again.data.jobs[0]).toMatchObject({ source: 'stored', description: 'Original text' });
    expect(c.session.visited).toEqual([]);
    await run(c.ctx, { refresh: true });
    expect(visitedJobs(c.session.visited)).toEqual(['4000000001']);
  });

  it('does not store a closed or unloaded page, and reports it as failed', async () => {
    const c = context({ '4000000001': jobPage(null), '4000000002': jobPage('Role', { closed: true }) });
    const result = await run(c.ctx, { ids: ['4000000001', '4000000002'] });
    expect(result.data.failed).toEqual([
      { id: '4000000001', status: 'not_loaded' },
      { id: '4000000002', status: 'closed' },
    ]);
    expect(c.jobs.jobs.size).toBe(0);
  });

  it('applies the caller disallowed terms and stores nothing for a rejected job', async () => {
    const c = context({
      '4000000001': jobPage('We use Angular', { title: 'Backend Engineer | Acme | LinkedIn' }),
      '4000000002': jobPage('Fine', { title: 'Frontend Engineer | Beta | LinkedIn' }),
    });
    const byDescription = await run(c.ctx, {
      ids: ['4000000001'],
      disallowed_terms: ['Angular'],
      disallowed_scope: 'title_then_description',
    });
    expect(byDescription.data.excluded).toEqual([{ id: '4000000001', title: 'Backend Engineer', reason: 'description', term: 'Angular' }]);
    const byTitle = await run(c.ctx, { ids: ['4000000002'], disallowed_terms: ['frontend'] });
    expect(byTitle.data.excluded[0]).toMatchObject({ id: '4000000002', reason: 'title', term: 'frontend' });
    expect(c.jobs.jobs.size).toBe(0);
    const titleOnly = await run(c.ctx, { ids: ['4000000001'], disallowed_terms: ['Angular'] });
    expect(titleOnly.data.jobs).toHaveLength(1);
  });
});

describe('linkedin_search_and_read', () => {
  it('"full stack, ignore frontend": drops excluded titles without opening them, opens and stores the rest', async () => {
    const c = context();
    const result = await tools.searchAndRead.handler(read({ disallowed_terms: ['frontend', 'intern'] }), c.ctx);
    expect(result.data.excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      ['4000000001', 'title', 'frontend'],
      ['4000000002', 'title', 'intern'],
    ]);
    expect(result.data.jobs.map((j) => j.id)).toEqual(['4000000003', '4000000004']);
    expect(visitedJobs(c.session.visited)).toEqual(['4000000003', '4000000004']);
    expect([...c.jobs.jobs.keys()].sort()).toEqual(['4000000003', '4000000004']);
    expect(result.data.jobs[0]).toMatchObject({ company: 'Gamma', location: 'France (Remote)', source: 'fetched' });
  });

  it('never opens a stored job again, in a later call or another search', async () => {
    const c = context();
    await tools.searchAndRead.handler(read({ disallowed_terms: ['frontend', 'intern'] }), c.ctx);
    c.session.visited.length = 0;
    const second = await tools.searchAndRead.handler(read({ disallowed_terms: ['frontend', 'intern'] }), c.ctx);
    expect(second.data.known_ids).toEqual(['4000000003', '4000000004']);
    expect(second.data.jobs).toEqual([]);
    expect(visitedJobs(c.session.visited)).toEqual([]);
    // "backend, ignore fullstack": a different list. The title the first search rejected is not remembered as rejected.
    const backend = await tools.searchAndRead.handler(read({ keywords: 'backend', disallowed_terms: ['intern', 'staff'] }), c.ctx);
    expect(backend.data.jobs.map((j) => j.id)).toEqual(['4000000001']);
    expect(backend.data.known_ids).toEqual(['4000000003', '4000000004']);
    expect(backend.data.excluded.map((e) => e.id)).toEqual(['4000000002']);
  });

  it('has no built-in disallowed terms: without any, an Intern title is opened', async () => {
    const c = context();
    const result = await tools.searchAndRead.handler(read(), c.ctx);
    expect(result.data.jobs.map((j) => j.id)).toEqual(IDS);
    expect(result.data.excluded).toEqual([]);
  });

  it('honours skip_ids on top of the store', async () => {
    const c = context();
    const result = await tools.searchAndRead.handler(read({ skip_ids: ['4000000001', '4000000002'] }), c.ctx);
    expect(result.data.known_ids).toEqual(['4000000001', '4000000002']);
    expect(visitedJobs(c.session.visited)).toEqual(['4000000003', '4000000004']);
  });

  it('is resumable: max_jobs stops early, reports remaining_ids and the next call continues', async () => {
    const c = context();
    const first = await tools.searchAndRead.handler(read({ max_jobs: 3 }), c.ctx);
    expect(first.data.jobs).toHaveLength(3);
    expect(first.data.remaining_ids).toEqual(['4000000004']);
    expect(first.warnings.join(' ')).toMatch(/call again/);
    const second = await tools.searchAndRead.handler(read({ max_jobs: 3 }), c.ctx);
    expect(second.data.jobs.map((j) => j.id)).toEqual(['4000000004']);
    expect(second.data.known_ids).toEqual(['4000000001', '4000000002', '4000000003']);
    expect(second.data.remaining_ids).toEqual([]);
  });

  it('max_jobs=0 only classifies: nothing is opened or stored', async () => {
    const c = context();
    const result = await tools.searchAndRead.handler(read({ max_jobs: 0, disallowed_terms: ['frontend'] }), c.ctx);
    expect(result.data.remaining_ids).toEqual(['4000000002', '4000000003', '4000000004']);
    expect(result.data.excluded.map((e) => e.id)).toEqual(['4000000001']);
    expect(visitedJobs(c.session.visited)).toEqual([]);
    expect(c.jobs.jobs.size).toBe(0);
  });

  it('with title_then_description a rejected description is not stored, so it is opened again next time', async () => {
    const c = context({ '4000000003': 'Our stack is Angular and Java.' });
    const input = read({
      disallowed_terms: ['angular'],
      disallowed_scope: 'title_then_description',
      skip_ids: ['4000000001', '4000000002'],
    });
    const first = await tools.searchAndRead.handler(input, c.ctx);
    expect(first.data.excluded).toEqual([{ id: '4000000003', title: 'Staff Engineer', reason: 'description', term: 'angular' }]);
    expect(first.data.jobs.map((j) => j.id)).toEqual(['4000000004']);
    expect(c.jobs.jobs.has('4000000003')).toBe(false);
    c.session.visited.length = 0;
    await tools.searchAndRead.handler(input, c.ctx);
    expect(visitedJobs(c.session.visited)).toEqual(['4000000003']);
  });

  it('keeps going after an unusable page, which is reported and not stored', async () => {
    const c = context({ '4000000001': jobPage(null) });
    const result = await tools.searchAndRead.handler(read(), c.ctx);
    expect(result.data.failed).toEqual([{ id: '4000000001', status: 'not_loaded' }]);
    expect(result.data.jobs).toHaveLength(3);
    expect(c.jobs.jobs.has('4000000001')).toBe(false);
  });

  it('rejects out-of-range arguments', () => {
    const input = tools.searchAndRead.input;
    expect(input.safeParse({ keywords: 'x', max_jobs: 26 }).success).toBe(false);
    expect(input.safeParse({ keywords: 'x', disallowed_terms: Array.from({ length: 61 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(input.safeParse({ keywords: 'x', disallowed_scope: 'everywhere' }).success).toBe(false);
  });
});

describe('layouts and session check', () => {
  it('can be built for the AI layout', () => {
    expect(createLinkedinAdapter({ layout: 'ai' }).tools).toHaveLength(3);
  });

  it('reports the session state', async () => {
    const check = adapter.sessionCheck;
    if (check === undefined) throw new Error('no sessionCheck');
    const page = (state: object): FakePage => ({ evaluate: () => state });
    const run = (p: FakePage) =>
      check(createBrowserTestContext({ allowedHosts: adapter.allowedHosts, pages: { 'https://www.linkedin.com/jobs/': p } }).session);
    expect((await run(page({ loginForm: false, nav: true, title: '' }))).state).toBe('ok');
    expect((await run(page({ loginForm: true, nav: true, title: '' }))).state).toBe('needs_login');
    expect((await run(page({ loginForm: false, nav: false, title: '' }))).state).toBe('unknown');
  });
});

describe('max_results and several pages', () => {
  const fullCard = (n: number) => ({ id: String(5_000_000_000 + n), lines: [`Engineer ${n}`, 'Co', 'Paris', '1 hour ago'] });
  /** A search that serves `perPage[i]` cards on its i-th load (25 = a full page), then an empty "no results" page. */
  function paged(perPage: number[], extraPages: Record<string, FakePage> = {}) {
    let load = 0;
    let offset = 0;
    const page: FakePage = {
      present: ['li[data-occludable-job-id]'],
      evaluate: () => {
        const count = perPage[load] ?? 0;
        const batch = Array.from({ length: count }, (_, i) => fullCard(offset + i));
        load += 1;
        offset += count;
        return { classic: count, ai: 0, cards: batch, noResults: count === 0, loginForm: false };
      },
    };
    const made = createBrowserTestContext({ allowedHosts: adapter.allowedHosts, pages: { [SEARCH_URL]: page, ...extraPages } });
    return { ...made, loads: () => load };
  }
  const search = (over: object = {}) => tools.search.input.parse({ keywords: 'x', posted_within: 'any', ...over });

  it('50 results loads pages 1 and 2 and reports what the budget really spent', async () => {
    const c = paged([25, 25, 25]);
    const result = await tools.search.handler(search({ max_results: 50 }), c.ctx);
    expect(result.data.cards).toHaveLength(50);
    expect(result.data).toMatchObject({ page: 1, pages_loaded: 2, truncated: false, has_more: true });
    expect(result.cost).toBe(2);
    expect(c.loads()).toBe(2);
  });

  it('the default is one page, and 30 results examines two pages but returns 30', async () => {
    const one = paged([25, 25]);
    expect((await tools.search.handler(search(), one.ctx)).data.pages_loaded).toBe(1);
    const thirty = paged([25, 25]);
    const result = await tools.search.handler(search({ max_results: 30 }), thirty.ctx);
    expect(result.data.cards).toHaveLength(30);
    expect(result.data.truncated).toBe(true);
    expect(result.data.pages_loaded).toBe(2);
  });

  it('stops at the end of the results: a page that is not full is the last one', async () => {
    const c = paged([25, 10, 25]);
    const result = await tools.search.handler(search({ max_results: 250 }), c.ctx);
    expect(result.data.cards).toHaveLength(35);
    expect(result.data).toMatchObject({ pages_loaded: 2, has_more: false });
    expect(c.loads()).toBe(2);
  });

  it('treats an empty later page as the end instead of failing the call', async () => {
    const c = paged([25, 0]);
    const result = await tools.search.handler(search({ max_results: 100 }), c.ctx);
    expect(result.data.cards).toHaveLength(25);
    expect(result.data.pages_loaded).toBe(2);
  });

  it('never goes past page 10 and says so', async () => {
    const c = paged([25, 25, 25]);
    const result = await tools.search.handler(search({ page: 9, max_results: 100 }), c.ctx);
    expect(result.data.pages_loaded).toBe(2);
    expect(result.warnings.join(' ')).toMatch(/up to 10/);
    expect(tools.search.input.safeParse({ keywords: 'x', page: 11 }).success).toBe(false);
    expect(tools.search.input.safeParse({ keywords: 'x', max_results: 251 }).success).toBe(false);
  });

  it('search_and_read scans the pages, skips known and excluded jobs, caps the visits and charges pages plus visits', async () => {
    const jobPages = Object.fromEntries(
      Array.from({ length: 50 }, (_, n) => [jobUrl(String(5_000_000_000 + n)), jobPage(`Text ${n}`)] as const),
    );
    const c = paged([25, 25], jobPages);
    await c.jobs.put({
      id: '5000000002',
      title: 'Engineer 2',
      company: 'Co',
      location: null,
      url: jobUrl('5000000002'),
      description: 'stored',
    });
    const input = tools.searchAndRead.input.parse({ keywords: 'x', max_results: 50, disallowed_terms: ['Engineer 1'] });
    const result = await tools.searchAndRead.handler(input, c.ctx);
    expect(result.data).toMatchObject({ pages_loaded: 2, scanned: 50, known_ids: ['5000000002'] });
    expect(result.data.excluded.map((e) => e.id)).toEqual(['5000000001']);
    expect(result.data.jobs).toHaveLength(25);
    expect(result.data.remaining_ids).toHaveLength(50 - 1 - 1 - 25);
    expect(result.cost).toBe(2 + 25);
    expect(c.jobs.jobs.size).toBe(26);
  });
});

describe('cost reporting', () => {
  it('linkedin_job charges the pages it visited: 0 for a stored job, 1 per opened one', async () => {
    const c = context();
    expect((await tools.job.handler(tools.job.input.parse({ ids: ['4000000001', '4000000002'] }), c.ctx)).cost).toBe(2);
    expect((await tools.job.handler(tools.job.input.parse({ ids: ['4000000001', '4000000002'] }), c.ctx)).cost).toBe(0);
  });

  it('the adapter declares the approved budget and every tool fits in it', () => {
    expect(adapter.rate).toEqual({ perHour: 200, perDay: 400 });
    for (const tool of adapter.tools) expect(tool.limits.cost).toBeLessThanOrEqual(200);
  });
});
