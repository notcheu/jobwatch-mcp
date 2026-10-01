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

function searchPage(overrides: Partial<{ cards: unknown[]; noResults: boolean; loginForm: boolean }> = {}): FakePage {
  return {
    present: ['li[data-occludable-job-id]'],
    evaluate: () => ({ classic: 4, ai: 0, cards, noResults: false, loginForm: false, ...overrides }),
  };
}

function jobPage(description: string | null, extra: { closed?: boolean; loginForm?: boolean } = {}): FakePage {
  return {
    present: ['#job-details'],
    evaluate: () => ({ description, closed: false, title: 'Role | Company | LinkedIn', loginForm: false, ...extra }),
  };
}

function context(pages: Record<string, FakePage>) {
  return createBrowserTestContext({ allowedHosts: adapter.allowedHosts, pages });
}

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    linkedin_search: {
      args: { keywords: 'frontend' },
      run: (args) => tools.search.handler(args, context({ [SEARCH_URL]: searchPage() }).ctx),
    },
    linkedin_job: {
      args: { ids: ['4000000001'] },
      run: (args) => tools.job.handler(args, context({ [jobUrl('4000000001')]: jobPage('React and TypeScript') }).ctx),
    },
    linkedin_search_and_read: {
      args: { keywords: 'frontend' },
      run: (args) =>
        tools.searchAndRead.handler(
          args,
          context({
            [SEARCH_URL]: searchPage(),
            [jobUrl('4000000001')]: jobPage('x'),
            [jobUrl('4000000003')]: jobPage('y'),
            [jobUrl('4000000004')]: jobPage('z'),
          }).ctx,
        ),
    },
  },
});

describe('linkedin_search', () => {
  it('returns normalized cards', async () => {
    const result = await tools.search.handler(
      { keywords: 'frontend', geo: 'paris_idf', posted_within: '24h', remote_only: false, page: 1, max_cards: 25 },
      context({ [SEARCH_URL]: searchPage() }).ctx,
    );
    expect((result.data as { cards: unknown[] }).cards).toHaveLength(4);
  });

  it('post-filters on remote and says so', async () => {
    const result = await tools.search.handler(
      { keywords: 'x', geo: 'france', posted_within: 'any', remote_only: true, page: 1, max_cards: 25 },
      context({ [SEARCH_URL]: searchPage() }).ctx,
    );
    expect((result.data as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual(['4000000003']);
    expect(result.warnings.join(' ')).toMatch(/post-filtered/);
  });

  it('reports an honest empty result only when the page says there are no results', async () => {
    const ok = await tools.search.handler(
      { keywords: 'x', geo: 'france', posted_within: 'any', remote_only: false, page: 1, max_cards: 25 },
      context({ [SEARCH_URL]: searchPage({ cards: [], noResults: true }) }).ctx,
    );
    expect((ok.data as { cards: unknown[] }).cards).toEqual([]);
    await expect(
      tools.search.handler(
        { keywords: 'x', geo: 'france', posted_within: 'any', remote_only: false, page: 1, max_cards: 25 },
        context({ [SEARCH_URL]: searchPage({ cards: [], noResults: false }) }).ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterBroken);
  });

  it('turns a login form into SessionInvalid and a checkpoint url into Checkpoint', async () => {
    const args = { keywords: 'x', geo: 'france', posted_within: 'any' as const, remote_only: false, page: 1, max_cards: 25 };
    await expect(
      tools.search.handler(args, context({ [SEARCH_URL]: searchPage({ cards: [], loginForm: true }) }).ctx),
    ).rejects.toBeInstanceOf(SessionInvalid);
    const { ctx, session } = context({
      [SEARCH_URL]: searchPage(),
      'https://www.linkedin.com/checkpoint/challenge/1': searchPage(),
    });
    const goto = session.goto.bind(session);
    session.goto = async (url, options) => {
      await goto('https://www.linkedin.com/checkpoint/challenge/1', options);
      void url;
    };
    await expect(tools.search.handler(args, ctx)).rejects.toBeInstanceOf(Checkpoint);
  });

  it('rejects arguments that could change the url', () => {
    const input = tools.search.input;
    expect(input.safeParse({ keywords: 'x', geo: 'x&f_AL=true' }).success).toBe(false);
    expect(input.safeParse({ keywords: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('linkedin_job', () => {
  it('reads descriptions, truncates and marks closed or unloaded pages', async () => {
    const { ctx } = context({
      [jobUrl('4000000001')]: jobPage('A'.repeat(900)),
      [jobUrl('4000000002')]: jobPage(null),
      [jobUrl('4000000003')]: jobPage('Role', { closed: true }),
    });
    const result = await tools.job.handler(
      { ids: ['4000000001', '4000000001', '4000000002', '4000000003'], description_max_chars: 500 },
      ctx,
    );
    const jobs = (result.data as { jobs: { id: string; status: string; description: string; description_truncated: boolean }[] }).jobs;
    expect(jobs.map((j) => [j.id, j.status])).toEqual([
      ['4000000001', 'ok'],
      ['4000000002', 'not_loaded'],
      ['4000000003', 'closed'],
    ]);
    expect(jobs[0]?.description).toHaveLength(500);
    expect(jobs[0]?.description_truncated).toBe(true);
  });

  it('only ever navigates to job urls', async () => {
    const { ctx, session } = context({ [jobUrl('4000000001')]: jobPage('x') });
    await tools.job.handler({ ids: ['4000000001'], description_max_chars: 500 }, ctx);
    expect(session.visited).toEqual([jobUrl('4000000001')]);
  });
});

describe('linkedin_search_and_read', () => {
  it('skips seen ids, excludes titles and opens only the rest', async () => {
    const { ctx, session } = context({
      [SEARCH_URL]: searchPage(),
      [jobUrl('4000000003')]: jobPage('Remote friendly'),
      [jobUrl('4000000004')]: jobPage('Onsite'),
    });
    const input = tools.searchAndRead.input.parse({ keywords: 'x', skip_ids: ['4000000001'] });
    const result = await tools.searchAndRead.handler(input, ctx);
    const data = result.data as { skipped_seen: number; excluded_titles: number; jobs: { id: string }[] };
    expect(data.skipped_seen).toBe(1);
    expect(data.excluded_titles).toBe(1);
    expect(data.jobs.map((j) => j.id)).toEqual(['4000000003', '4000000004']);
    expect(session.visited).toEqual([SEARCH_URL, jobUrl('4000000003'), jobUrl('4000000004')]);
  });

  it('opens nothing with open=none', async () => {
    const { ctx, session } = context({ [SEARCH_URL]: searchPage() });
    const input = tools.searchAndRead.input.parse({ keywords: 'x', open: 'none' });
    await tools.searchAndRead.handler(input, ctx);
    expect(session.visited).toEqual([SEARCH_URL]);
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
    const run = (p: FakePage) => check(context({ 'https://www.linkedin.com/jobs/': p }).session);
    expect((await run(page({ loginForm: false, nav: true, title: '' }))).state).toBe('ok');
    expect((await run(page({ loginForm: true, nav: true, title: '' }))).state).toBe('needs_login');
    expect((await run(page({ loginForm: false, nav: false, title: '' }))).state).toBe('unknown');
  });
});
