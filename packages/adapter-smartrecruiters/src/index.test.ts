import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';
import { MAX_LIST_PAGES } from './feed';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like `GET api.smartrecruiters.com/v1/companies/<id>/postings` (checked against BoschGroup and Ubisoft2). */
const listed = (id: string, name: string, over: { days?: number; city?: string; remote?: boolean } = {}) => ({
  id,
  name,
  uuid: `uuid-${id}`,
  releasedDate: ago(over.days ?? 2),
  location: {
    city: over.city ?? 'Paris',
    region: 'IDF',
    country: 'fr',
    remote: over.remote ?? false,
    hybrid: false,
    fullLocation: `${over.city ?? 'Paris'}, IDF, France`,
  },
  company: { identifier: 'Acme', name: 'Acme Group' },
  ref: `https://api.smartrecruiters.com/v1/companies/Acme/postings/${id}`,
});
/** Shaped like `GET .../postings/<id>`. */
const detail = (id: string, title: string) => ({
  id,
  name: title,
  postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}-job`,
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p>We build things.</p>' },
      jobDescription: { title: 'Job Description', text: `<p>Join us as ${title}. We use React and TypeScript.</p>` },
      qualifications: { title: 'Qualifications', text: '<ul><li>5 years of experience required.</li></ul>' },
      additionalInformation: { title: 'Additional Information', text: '' },
    },
  },
});

const postings = [
  listed('7440001', 'Senior Frontend Engineer', { days: 3 }),
  listed('7440002', 'Backend Engineer', { days: 9 }),
  listed('7440003', 'Fullstack Developer', { days: 1, city: 'Lyon', remote: true }),
  listed('7440004', 'Office Manager', { days: 5 }),
];
const LIST = (offset = 0) => `https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=${offset}`;
const DETAIL = (id: string) => `https://api.smartrecruiters.com/v1/companies/Acme/postings/${id}`;
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const page = (content: unknown[], totalFound = content.length) => ({ offset: 0, limit: 100, totalFound, content });
const routes = (list = page(postings)): FakeHttpRoute[] => [
  route(LIST(), list),
  ...postings.map((p) => route(DETAIL(p.id), detail(p.id, p.name))),
];
const context = (r: FakeHttpRoute[] = routes()) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'smartrecruiters', routes: r });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['Acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: { id: string; board: string; company: string | null; url: string; locations: string[]; description: string; source: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { smartrecruiters_jobs: { args: { boards: ['Acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://api.smartrecruiters.com/v1/companies/${handle}/postings`;

  it('takes an identifier and keeps its case', () => {
    expect(resolveBoard('BoschGroup')).toEqual({ feedUrl: feed('BoschGroup'), label: 'BoschGroup' });
    expect(resolveBoard(' Ubisoft2 ')).toEqual({ feedUrl: feed('Ubisoft2'), label: 'Ubisoft2' });
  });

  it.each([
    ['https://jobs.smartrecruiters.com/BoschGroup', 'BoschGroup'],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000154142930-warehouse-coordinator', 'BoschGroup'],
    ['https://careers.smartrecruiters.com/Ubisoft2', 'Ubisoft2'],
    ['https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=1', 'BoschGroup'],
  ])('takes the identifier from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://jobs.smartrecruiters.com/BoschGroup',
    'https://jobs.smartrecruiters.com:8443/BoschGroup',
    'https://user@jobs.smartrecruiters.com/BoschGroup',
    'https://jobs.smartrecruiters.com.evil.example/BoschGroup',
    'https://jobs.smartrecruiters.com/',
    'https://api.smartrecruiters.com/v2/companies/BoschGroup',
    'https://example.com/BoschGroup',
    'a/b',
    '../x',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });
});

describe('smartrecruiters_jobs', () => {
  it('lists the board, then reads the text of the postings that pass the filters only, newest first', async () => {
    const c = context();
    const result = await run(c.ctx, { title_any: ['engineer', 'developer'], detail: 'full' });
    expect(c.spent()).toBe(1 + 3); // the list, and the three postings whose title matches: not the office manager
    expect(c.http.requests.map((r) => r.url.split('/').pop())).toEqual(['postings', '7440003', '7440001', '7440002']);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['7440003', '7440001', '7440002']);
    const first = data(result).jobs.find((j) => j.id === '7440001');
    expect(first).toMatchObject({
      source: 'smartrecruiters',
      board: 'acme-group',
      company: 'Acme Group',
      url: 'https://jobs.smartrecruiters.com/Acme/7440001-job',
      locations: ['Paris, IDF, France'],
    });
    expect(first?.description).toContain('We use React and TypeScript.');
    expect(first?.description).toContain('5 years of experience required.');
    expect(data(result).boards).toEqual([
      { board: 'acme-group', feed_url: LIST().split('?')[0], status: 'ok', jobs_total: 4, relevant: 3 },
    ]);
  });

  it('says so in the location when a posting is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['7440003']);
    expect(data(result).jobs[0]?.locations).toEqual(['Lyon, IDF, France', 'Remote']);
  });

  it('reads no text for a posting a disallowed word drops from the title', async () => {
    const c = context();
    const result = await run(c.ctx, { disallowed_terms: ['manager'] });
    expect(c.http.requests.some((r) => r.url.endsWith('/7440004'))).toBe(false);
    expect(data(result).jobs.map((j) => j.id)).not.toContain('7440004');
  });

  it('asks for the next page of a long list, and warns when the list is longer than what it takes', async () => {
    const many = Array.from({ length: 100 }, (_, i) => listed(`80000${String(i).padStart(2, '0')}`, `Role ${i}`, { days: 2 }));
    const c = context([
      route(LIST(0), page(many, 104)),
      route(LIST(100), page(postings, 104)),
      ...many.map((p) => route(DETAIL(p.id), detail(p.id, p.name))),
      ...postings.map((p) => route(DETAIL(p.id), detail(p.id, p.name))),
    ]);
    const result = await run(c.ctx, { title_any: ['Role 99'], max_results: 5 });
    expect(c.http.requests.filter((r) => r.url.endsWith('/postings'))).toHaveLength(2); // the list, then its second page
    expect(result.warnings.join(' ')).not.toMatch(/only the newest/);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['8000099']);

    const cut = context([
      route(LIST(0), page(many, 9999)),
      ...Array.from({ length: MAX_LIST_PAGES }, (_, i) => route(LIST(i * 100), page(many, 9999))),
    ]);
    const cutResult = await run(cut.ctx, { title_any: ['nothing matches this'] });
    expect(cut.spent()).toBe(MAX_LIST_PAGES);
    expect(cutResult.warnings.join(' ')).toMatch(/only the newest 500 of 9999 postings were listed/);
  });

  it('reads at most 40 texts per board and says how many more matched', async () => {
    const many = Array.from({ length: 45 }, (_, i) => listed(`81000${String(i).padStart(2, '0')}`, `Engineer ${i}`, { days: 2 }));
    const c = context([route(LIST(), page(many)), ...many.map((p) => route(DETAIL(p.id), detail(p.id, p.name)))]);
    const result = await run(c.ctx, { max_results: 200 });
    expect(c.spent()).toBe(1 + 40);
    expect(result.warnings.join(' ')).toMatch(/5 more job\(s\) matched the filters but their text was not read/);
  });

  it('leaves out a posting that closed since the list, and says so', async () => {
    const c = context([
      route(LIST(), page(postings.slice(0, 2))),
      route(DETAIL('7440001'), detail('7440001', 'Senior Frontend Engineer')),
      route(DETAIL('7440002'), { message: 'gone' }, 404),
    ]);
    const result = await run(c.ctx);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['7440001']);
    expect(result.warnings.join(' ')).toMatch(/1 posting\(s\) could not be read/);
  });

  it('reports a board with no postings as empty, an error, and a changed shape, each on its own', async () => {
    const c = context([
      ...routes(),
      route('https://api.smartrecruiters.com/v1/companies/Ghost/postings?limit=100&offset=0', page([])),
      route('https://api.smartrecruiters.com/v1/companies/Down/postings?limit=100&offset=0', '', 503),
      route('https://api.smartrecruiters.com/v1/companies/Odd/postings?limit=100&offset=0', { nope: 1 }),
    ]);
    const statuses = async (boards: string[]) =>
      ((await tool.handler(tool.input.parse({ boards }), c.ctx)).data as ReturnType<typeof data>).boards.map((b) => [
        b.board,
        b.status,
        b.jobs_total,
      ]);
    expect(await statuses(['Acme', 'Ghost'])).toEqual([
      ['acme-group', 'ok', 4],
      ['ghost', 'ok', 0],
    ]);
    expect(await statuses(['Down', 'Odd'])).toEqual([
      ['Down', 'error', null],
      ['Odd', 'not_this_ats', null],
    ]);
    expect(await statuses(['not valid!'])).toEqual([['not valid!', 'invalid', null]]);
  });

  it('takes two companies at most, because each can cost a list and forty texts', () => {
    expect(tool.input.safeParse({ boards: ['A', 'B', 'C'] }).success).toBe(false);
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['Acme', ' Acme '])).toEqual(['Acme']);
    expect(keys(['https://jobs.smartrecruiters.com/Acme/123-x', 'nope!'])).toEqual(['Acme']);
  });

  it('gives every company a budget that covers a list and its postings, and reserves them in the call', () => {
    expect(adapter.keyRate).toEqual({ perHour: 120, perDay: 400 });
    expect(tool.limits.cost).toBe(2 * (MAX_LIST_PAGES + 40)); // two companies at most, so that a call stays within the 100 units a call may reserve
    expect(tool.limits.estimate?.(tool.input.parse({ boards: ['Acme'] }))).toBe(MAX_LIST_PAGES + 20);
  });
});
