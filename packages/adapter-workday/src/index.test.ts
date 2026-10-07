import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { labelOf, resolveBoard, siteOf } from './board';
import { MAX_SEARCHES, postedAt } from './feed';

const SITE = { tenant: 'acme', shard: 'wd5', site: 'AcmeCareers' };
const LABEL = labelOf(SITE);
const BASE = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/AcmeCareers';
const SEARCH = `${BASE}/jobs`;

/** Shaped like `POST .../wday/cxs/<tenant>/<site>/jobs` (checked against NVIDIA). */
const listed = (slug: string, req: string, title: string, over: { posted?: string; where?: string } = {}) => ({
  title,
  externalPath: `/job/${(over.where ?? 'FR, Paris').replace(/[^A-Za-z0-9]+/g, '-')}/${slug}_${req}`,
  locationsText: over.where ?? 'FR, Paris',
  postedOn: over.posted ?? 'Posted 2 Days Ago',
  bulletFields: [req],
});
/** Shaped like `GET .../job/<path>`. */
const detail = (title: string, over: { start?: string; extra?: string[] } = {}) => ({
  jobPostingInfo: {
    id: 'x',
    title,
    jobDescription: `<p>Join us as ${title}. We use React and TypeScript.</p><ul><li>5 years of experience required.</li></ul>`,
    location: 'FR, Paris',
    additionalLocations: over.extra ?? [],
    startDate: over.start ?? '2026-10-05',
    timeType: 'Full time',
    jobReqId: 'JR1',
  },
  hiringOrganization: { name: '2100 Acme France' },
});

const jobs = [
  listed('Senior-Frontend-Engineer', 'JR1001', 'Senior Frontend Engineer', { posted: 'Posted 3 Days Ago' }),
  listed('Backend-Engineer', 'JR1002', 'Backend Engineer', { posted: 'Posted 30+ Days Ago' }),
  listed('Fullstack-Developer', 'JR1003', 'Fullstack Developer', { posted: 'Posted Today', where: 'FR, Lyon' }),
  listed('Office-Manager', 'JR1004', 'Office Manager', { posted: 'Posted Yesterday' }),
];
const searchPage = (items: unknown[], total = items.length) => ({ total, jobPostings: items, facets: [], userAuthenticated: false });
const post = (when: (body: Record<string, unknown>) => boolean, body: unknown, status = 200): FakeHttpRoute => ({
  method: 'POST',
  url: SEARCH,
  when: (sent) => when(sent as Record<string, unknown>),
  body,
  status,
});
const get = (path: string, body: unknown, status = 200): FakeHttpRoute => ({ url: `${BASE}${path}`, body, status });
const routes = (): FakeHttpRoute[] => [post(() => true, searchPage(jobs)), ...jobs.map((j) => get(j.externalPath, detail(j.title)))];
const context = (r: FakeHttpRoute[] = routes()) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'workday', routes: r });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: [LABEL], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: {
      id: string;
      board: string;
      company: string | null;
      url: string;
      locations: string[];
      description: string;
      source: string;
      posted_at: string | null;
    }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { workday_jobs: { args: { boards: [LABEL] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a site', () => {
  const feed = (tenant: string, shard: string, site: string) => ({
    feedUrl: `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
    label: `${tenant}.${shard}/${site}`,
  });

  it('takes tenant.wdN/Site and keeps the case of the site', () => {
    expect(resolveBoard('nvidia.wd5/NVIDIAExternalCareerSite')).toEqual(feed('nvidia', 'wd5', 'NVIDIAExternalCareerSite'));
    expect(siteOf(LABEL)).toEqual(SITE);
  });

  it.each([
    ['https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'],
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite'],
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System_JR2017744-1'],
    ['https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs'],
  ])('takes the site from %s', (url) => {
    expect(resolveBoard(url)).toEqual(feed('nvidia', 'wd5', 'NVIDIAExternalCareerSite'));
  });

  it.each([
    'http://nvidia.wd5.myworkdayjobs.com/Site',
    'https://nvidia.wd5.myworkdayjobs.com:8443/Site',
    'https://user@nvidia.wd5.myworkdayjobs.com/Site',
    'https://nvidia.wd5.myworkdayjobs.com.evil.example/Site',
    'https://nvidia.wd5.myworkdayjobs.com/',
    'https://nvidia.wd5.myworkdayjobs.com/en-US',
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/other/Site/jobs',
    'https://myworkdayjobs.com/Site',
    'https://wd5.myworkdayjobs.com/Site',
    'https://example.com/Site',
    'nvidia',
    'nvidia.wd5',
    'nvidia.wd5/',
    'nvidia.wd5/a b',
    'NVIDIA.wd5/Site',
    'nvidia.xx5/Site',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('only ever points at a data centre the adapter lists', () => {
    expect(adapter.allowedHosts).toContain('*.wd5.myworkdayjobs.com');
    expect(resolveBoard('acme.wd999/Site')).not.toBeNull(); // a shape that is fine ...
    expect(adapter.allowedHosts).not.toContain('*.wd999.myworkdayjobs.com'); // ... on a host that is not listed: refused by the client
  });
});

describe('the date Workday gives', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  it.each([
    ['Posted Today', '2026-10-07T12:00:00.000Z'],
    ['Posted Yesterday', '2026-10-06T12:00:00.000Z'],
    ['Posted 3 Days Ago', '2026-10-04T12:00:00.000Z'],
    ['Posted 1 Day Ago', '2026-10-06T12:00:00.000Z'],
    ['Posted 30+ Days Ago', '2026-09-07T12:00:00.000Z'],
  ])('reads %j', (text, iso) => {
    expect(postedAt(text, now)).toBe(iso);
  });
  it('is null for anything else', () => {
    expect(postedAt('Soon', now)).toBeNull();
    expect(postedAt(null, now)).toBeNull();
  });
});

describe('workday_jobs', () => {
  it('searches the site, then reads the text of the postings that pass the filters only, newest first', async () => {
    const c = context();
    const result = await run(c.ctx, { posted_within: 'past_week', location_any: ['paris', 'lyon'], detail: 'full' });
    expect(c.http.requests.map((r) => r.method)).toEqual(['POST', 'GET', 'GET', 'GET']); // the search; 3 texts: not the 30+ days old one
    expect(c.http.requests[0]?.body).toMatchObject({ limit: 20, offset: 0, searchText: '' });
    expect(c.spent()).toBe(4);
    const first = data(result).jobs.find((j) => j.id === 'acme-JR1001');
    expect(first).toMatchObject({
      source: 'workday',
      board: 'acme',
      url: 'https://acme.wd5.myworkdayjobs.com/AcmeCareers/job/FR-Paris/Senior-Frontend-Engineer_JR1001',
      locations: ['FR, Paris'],
    });
    expect(first?.posted_at).toBe('2026-10-05T00:00:00.000Z'); // the exact start date of the detail, not "3 days ago"
    expect(first?.description).toContain('We use React and TypeScript.');
    expect(first?.description).toContain('Time type: Full time');
    expect(
      data(result)
        .jobs.map((j) => j.id)
        .sort(),
    ).toEqual(['acme-JR1001', 'acme-JR1003', 'acme-JR1004']);
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: SEARCH, status: 'ok', jobs_total: 4, relevant: 3 }]);
  });

  it('searches each title word on the site, three at most, and keeps what they all found once', async () => {
    const c = context([
      post((b) => b['searchText'] === 'engineer', searchPage([jobs[0], jobs[1]])),
      post((b) => b['searchText'] === 'developer', searchPage([jobs[2], jobs[0]])),
      ...jobs.map((j) => get(j.externalPath, detail(j.title))),
    ]);
    const result = await run(c.ctx, { title_any: ['engineer', 'developer'] });
    expect(c.http.requests.filter((r) => r.method === 'POST').map((r) => (r.body as { searchText: string }).searchText)).toEqual([
      'engineer',
      'developer',
    ]);
    expect(
      data(result)
        .jobs.map((j) => j.id)
        .sort(),
    ).toEqual(['acme-JR1001', 'acme-JR1002', 'acme-JR1003']);
  });

  it('takes the next pages of a long list, and warns when the list is longer than what it takes', async () => {
    const page = (n: number) =>
      Array.from({ length: 20 }, (_, i) => listed(`Role-${n}-${i}`, `JR9${n}${String(i).padStart(2, '0')}`, `Role ${n} ${i}`));
    const c = context([post((b) => b['offset'] === 0, searchPage(page(0), 500)), post((b) => b['offset'] !== 0, searchPage(page(1), 500))]);
    const result = await run(c.ctx, { title_any: ['nothing matches this'] });
    expect(result.warnings.join(' ')).not.toMatch(/only the newest/); // a word was searched on the site: the list is its answer
    const open = context([post(() => true, searchPage(page(0), 500))]);
    const wide = await run(open.ctx, { location_any: ['nowhere'] });
    expect(open.http.requests.filter((r) => r.method === 'POST')).toHaveLength(MAX_SEARCHES - 1);
    expect(wide.warnings.join(' ')).toMatch(/only the newest 20 of 500 postings were listed/);
  });

  it('reads at most 40 texts per site and says how many more matched', async () => {
    const many = Array.from({ length: 20 }, (_, i) => listed(`E-${i}`, `JR70${String(i).padStart(2, '0')}`, `Engineer ${i}`));
    const more = Array.from({ length: 20 }, (_, i) => listed(`F-${i}`, `JR71${String(i).padStart(2, '0')}`, `Engineer F${i}`));
    const extra = Array.from({ length: 5 }, (_, i) => listed(`G-${i}`, `JR72${String(i).padStart(2, '0')}`, `Engineer G${i}`));
    const all = [...many, ...more, ...extra];
    const c = context([
      post((b) => b['offset'] === 0, searchPage(many, 45)),
      post((b) => b['offset'] === 20, searchPage(more, 45)),
      post((b) => b['offset'] === 40, searchPage(extra, 45)),
      ...all.map((j) => get(j.externalPath, detail(j.title))),
    ]);
    const result = await run(c.ctx, { max_results: 200 });
    expect(c.http.requests.filter((r) => r.method === 'GET')).toHaveLength(40);
    expect(result.warnings.join(' ')).toMatch(/5 more job\(s\) matched the filters but their text was not read/);
  });

  it('leaves out a posting that closed since the list, and says so', async () => {
    const c = context([
      post(() => true, searchPage(jobs.slice(0, 2))),
      get(jobs[0]?.externalPath as string, detail('A')),
      get(jobs[1]?.externalPath as string, 'gone', 404),
    ]);
    const result = await run(c.ctx);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['acme-JR1001']);
    expect(result.warnings.join(' ')).toMatch(/1 posting\(s\) could not be read/);
  });

  it('reports an unknown site (404) or company (422), an error and a changed shape, each on its own', async () => {
    const other = (tenant: string, site: string, status: number, body: unknown): FakeHttpRoute => ({
      method: 'POST',
      url: `https://${tenant}.wd5.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      status,
      body,
    });
    const c = context([
      ...routes(),
      other('ghost', 'S', 422, { errorCode: 'HTTP_422' }),
      other('acme', 'NoSite', 404, ''),
      other('down', 'S', 503, ''),
      other('odd', 'S', 200, { nope: 1 }),
    ]);
    const statuses = async (boards: string[]) =>
      ((await tool.handler(tool.input.parse({ boards }), c.ctx)).data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status]);
    expect(await statuses([LABEL, 'ghost.wd5/S'])).toEqual([
      ['acme', 'ok'],
      ['ghost.wd5/S', 'not_found'],
    ]);
    expect(await statuses(['acme.wd5/NoSite', 'down.wd5/S'])).toEqual([
      ['acme.wd5/NoSite', 'not_found'],
      ['down.wd5/S', 'error'],
    ]);
    expect(await statuses(['odd.wd5/S', 'not valid'])).toEqual([
      ['odd.wd5/S', 'not_this_ats'],
      ['not valid', 'invalid'],
    ]);
    expect(tool.input.safeParse({ boards: ['a.wd5/A', 'b.wd5/B', 'c.wd5/C'] }).success).toBe(false); // two sites at most
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct site once, whichever way it was written, and none for what cannot be a site', () => {
    expect(keys([LABEL, ` ${LABEL} `])).toEqual([LABEL]);
    expect(keys(['https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers/job/x', 'nope'])).toEqual([LABEL]);
  });

  it('gives every site a budget that covers its searches and texts, and reserves them in the call', () => {
    expect(adapter.keyRate).toEqual({ perHour: 120, perDay: 400 });
    expect(tool.limits.cost).toBe(2 * (MAX_SEARCHES + 40));
    expect(tool.limits.cost).toBeLessThanOrEqual(100);
  });
});
