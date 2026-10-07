import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like `GET api.ashbyhq.com/posting-api/job-board/<name>` (checked against Nabla, Alan and Pennylane). */
function job(
  id: string,
  title: string,
  over: { where?: string; second?: unknown[]; days?: number; plain?: string; remote?: boolean; listed?: boolean } = {},
) {
  return {
    id,
    title,
    department: 'Engineering',
    team: 'Web',
    employmentType: 'FullTime',
    location: over.where ?? 'Paris',
    secondaryLocations: over.second ?? [],
    publishedAt: ago(over.days ?? 2),
    isListed: over.listed ?? true,
    isRemote: over.remote ?? false,
    workplaceType: over.remote ? 'Remote' : 'Hybrid',
    address: { postalAddress: { addressLocality: over.where ?? 'Paris', addressCountry: 'France' } },
    jobUrl: `https://jobs.ashbyhq.com/acme/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/acme/${id}/application`,
    descriptionHtml: '<p>html</p>',
    descriptionPlain: over.plain ?? `Join us as ${title}. We use React and TypeScript. 5 years of experience.`,
  };
}

const acme = {
  apiVersion: '1',
  jobs: [
    job('a0000001-0000-4000-8000-000000000001', 'Senior Frontend Engineer', { days: 2 }),
    job('a0000002-0000-4000-8000-000000000002', 'Backend Engineer (Java)', { days: 8, second: [{ location: 'Lyon' }, 'Nantes'] }),
    job('a0000003-0000-4000-8000-000000000003', 'Frontend Tech Lead', { where: 'Barcelona', days: 60 }),
    job('a0000004-0000-4000-8000-000000000004', 'Fullstack Developer', {
      plain: 'Angular and Node.js.',
      days: 3,
      remote: true,
      where: 'France',
    }),
    job('a0000005-0000-4000-8000-000000000005', 'Unlisted Role', { listed: false }),
  ],
};
const [J1, J2, J3, J4] = acme.jobs.map((j) => j.id) as [string, string, string, string, string];

const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const ACME = 'https://api.ashbyhq.com/posting-api/job-board/acme';
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'ashby', routes });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: {
      id: string;
      board: string;
      company: string | null;
      locations: string[];
      description: string;
      summary: string;
      source: string;
    }[];
    excluded: { id: string; reason: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };
const ids = (result: Awaited<ReturnType<typeof run>>) => data(result).jobs.map((j) => j.id);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { ashby_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://api.ashbyhq.com/posting-api/job-board/${handle}`;

  it('takes a job board name and keeps its spelling', () => {
    expect(resolveBoard('pennylane')).toEqual({ feedUrl: feed('pennylane'), label: 'pennylane' });
    expect(resolveBoard(' backmarket ')?.feedUrl).toBe(feed('backmarket'));
    expect(resolveBoard('Some.Company_1')?.feedUrl).toBe(feed('Some.Company_1'));
  });

  it.each([
    ['https://jobs.ashbyhq.com/pennylane', 'pennylane'],
    ['https://jobs.ashbyhq.com/pennylane/a0000001-0000-4000-8000-000000000001?utm=x', 'pennylane'],
    ['https://api.ashbyhq.com/posting-api/job-board/pennylane?includeCompensation=true', 'pennylane'],
  ])('takes the board from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://jobs.ashbyhq.com/pennylane',
    'https://jobs.ashbyhq.com:8443/pennylane',
    'https://user@jobs.ashbyhq.com/pennylane',
    'https://jobs.ashbyhq.com.evil.example/pennylane',
    'https://example.com/pennylane',
    'https://jobs.ashbyhq.com/',
    'https://api.ashbyhq.com/posting-api/other/pennylane',
    'a/b',
    '../x',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('only ever points at the API host', () => {
    for (const input of ['pennylane', 'https://jobs.ashbyhq.com/pennylane'])
      expect(new URL(resolveBoard(input)?.feedUrl ?? '').hostname).toBe('api.ashbyhq.com');
  });
});

describe('ashby_jobs', () => {
  it('reads a board, drops unlisted postings, stores the rest with source and board, and reports it', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(c.spent()).toBe(1); // one request for one board
    expect(c.spent()).toBe(1); // one request for one board
    expect(ids(result)).toEqual([J1, J4, J2, J3]);
    expect(data(result).jobs[0]).toMatchObject({ source: 'ashby', board: 'acme', company: 'acme', locations: ['Paris'] });
    expect(data(result).jobs[0]?.description).toBe('');
    expect(data(result).jobs[0]?.summary).toContain('We use React and TypeScript.');
    expect(data(await run(c.ctx, { detail: 'full' })).jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 4, relevant: 4 }]);
    expect(c.jobs.jobs.has('a0000005-0000-4000-8000-000000000005')).toBe(false);
    expect([...c.jobs.jobs.values()].every((j) => j.source === 'ashby' && j.board === 'acme')).toBe(true);
  });

  it('keeps every office, strings or objects, and says Remote when the remote flag is set', async () => {
    const result = await run(context().ctx);
    const byId = new Map(data(result).jobs.map((j) => [j.id, j.locations]));
    expect(byId.get(J2)).toEqual(['Paris', 'Lyon', 'Nantes']);
    expect(byId.get(J4)).toEqual(['France', 'Remote']);
    expect(ids(await run(context().ctx, { location_any: ['remote'] }))).toEqual([J4]);
    expect(ids(await run(context().ctx, { location_any: ['nantes'] }))).toEqual([J2]);
  });

  it('applies the shared filters and rules', async () => {
    const c = context();
    expect(ids(await run(c.ctx, { title_any: ['front'], location_any: ['paris'] }))).toEqual([J1]);
    expect(ids(await run(c.ctx, { posted_within: 'past_week' }))).toEqual([J1, J4]);
    const byTitle = await run(c.ctx, { disallowed_terms: ['java'] });
    expect(data(byTitle).excluded.map((e) => [e.id, e.reason])).toEqual([[J2, 'title']]);
    expect(c.jobs.jobs.has(J2)).toBe(false);
    const byDescription = await run(c.ctx, { disallowed_terms: ['angular'], disallowed_scope: 'title_then_description' });
    expect(data(byDescription).excluded.map((e) => [e.id, e.reason])).toEqual([[J4, 'description']]);
    expect(c.jobs.jobs.has(J4)).toBe(true);
  });

  it('reads a board given as a URL once, however it is named', async () => {
    const c = context();
    const result = await run(c.ctx, { boards: ['https://jobs.ashbyhq.com/acme', 'acme', 'https://jobs.ashbyhq.com/acme/' + J1] });
    expect(ids(result)).toHaveLength(4);
    expect(c.http.requests).toHaveLength(1);
  });

  it('reports one bad board without failing the others, and never reaches another host', async () => {
    const c = context([
      route(ACME, acme),
      route('https://api.ashbyhq.com/posting-api/job-board/ghost', 'nope', 404),
      route('https://api.ashbyhq.com/posting-api/job-board/odd', { jobs: 'x' }),
    ]);
    const result = await run(c.ctx, { boards: ['acme', 'ghost', 'odd', 'https://evil.example/acme'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['odd', 'not_this_ats'],
      ['https://evil.example/acme', 'invalid'],
    ]);
    expect(new Set(c.http.requests.map((r) => new URL(r.url).hostname))).toEqual(new Set(['api.ashbyhq.com']));
  });

  it('files the board under the lower-case board name', async () => {
    const c = context([
      route('https://api.ashbyhq.com/posting-api/job-board/BackMarket', {
        jobs: [job('b0000001-0000-4000-8000-000000000001', 'Data Engineer')],
      }),
    ]);
    expect(data(await run(c.ctx, { boards: ['BackMarket'] })).jobs[0]?.board).toBe('backmarket');
  });

  it('is closed: one exact host, no open mode', () => {
    expect(adapter.allowedHosts).toEqual(['api.ashbyhq.com']);
    expect('openHttps' in adapter).toBe(false);
  });

  it('rejects arguments outside the schema', () => {
    for (const bad of [{}, { boards: [] }, { boards: ['a'], extra: 1 }, { boards: ['a'], max_results: 201 }]) {
      expect(tool.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]): readonly string[] => {
    const keysOf = tool.limits.keys;
    if (keysOf === undefined) throw new Error('the tool names no budget keys');
    return (keysOf as (args: { boards: string[] }) => readonly string[])({ boards });
  };

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['pennylane', 'https://jobs.ashbyhq.com/pennylane', 'backmarket', 'https://evil.example/x', 'a/b'])).toEqual([
      'pennylane',
      'backmarket',
    ]);
    expect(keys([])).toEqual([]);
  });

  it('gives every company its own budget and the whole platform a high ceiling', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
