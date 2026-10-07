import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const day = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Shaped like `GET <handle>.bamboohr.com/careers/list` (checked against Scribd). */
const listed = (id: string, name: string, over: { city?: string; remote?: boolean } = {}) => ({
  id,
  jobOpeningName: name,
  departmentId: '18910',
  departmentLabel: 'Engineering',
  employmentStatusLabel: 'Full-Time',
  employmentType: null,
  location: { city: over.city ?? 'Paris', state: 'Île-de-France' },
  atsLocation: { country: null, state: null, province: null, city: null },
  isRemote: over.remote ?? null,
  locationType: '0',
});
/** Shaped like `GET <handle>.bamboohr.com/careers/<id>/detail`. */
const detail = (id: string, name: string, over: { days?: number; pay?: string | null; city?: string } = {}) => ({
  meta: { totalCount: 1 },
  result: {
    jobOpening: {
      jobOpeningShareUrl: `https://acme.bamboohr.com/careers/${id}`,
      jobOpeningName: name,
      jobOpeningStatus: 'Open',
      location: { city: over.city ?? 'Paris', state: 'Île-de-France', postalCode: '75001', addressCountry: 'France' },
      description: `<p>Join us as ${name}. We use React and TypeScript.</p><ul><li>5 years of experience required.</li></ul>`,
      compensation: over.pay ?? null,
      datePosted: day(over.days ?? 2),
    },
    formFields: { firstName: { isRequired: true } },
  },
});

const rows = [
  { ...listed('101', 'Senior Frontend Engineer'), d: detail('101', 'Senior Frontend Engineer', { days: 3, pay: '90000 EUR / year' }) },
  { ...listed('102', 'Backend Engineer'), d: detail('102', 'Backend Engineer', { days: 40 }) },
  {
    ...listed('103', 'Fullstack Developer', { city: 'Lyon', remote: true }),
    d: detail('103', 'Fullstack Developer', { days: 1, city: 'Lyon' }),
  },
  { ...listed('104', 'Office Manager'), d: detail('104', 'Office Manager', { days: 5 }) },
];
const LIST = 'https://acme.bamboohr.com/careers/list';
const DETAIL = (id: string) => `https://acme.bamboohr.com/careers/${id}/detail`;
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const board = { meta: { totalCount: rows.length }, result: rows.map(({ d: _d, ...entry }) => entry) };
const routes = (): FakeHttpRoute[] => [route(LIST, board), ...rows.map((row) => route(DETAIL(row.id), row.d))];
const context = (r: FakeHttpRoute[] = routes()) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'bamboohr', routes: r });
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
  samples: { bamboohr_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://${handle}.bamboohr.com/careers/list`;

  it('takes a subdomain', () => {
    expect(resolveBoard('scribd')).toEqual({ feedUrl: feed('scribd'), label: 'scribd' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: feed('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://scribd.bamboohr.com/careers', 'scribd'],
    ['https://scribd.bamboohr.com/careers/144', 'scribd'],
    ['https://scribd.bamboohr.com/careers/list', 'scribd'],
  ])('takes the subdomain from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://scribd.bamboohr.com/careers',
    'https://scribd.bamboohr.com:8443/careers',
    'https://user@scribd.bamboohr.com/careers',
    'https://scribd.bamboohr.com.evil.example/careers',
    'https://www.bamboohr.com/careers/',
    'https://documentation.bamboohr.com/reference',
    'www',
    'api',
    'https://bamboohr.com',
    'https://a.b.bamboohr.com',
    'Scribd',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });
});

describe('bamboohr_jobs', () => {
  it('lists the board, then reads the detail of the positions that pass the filters only, the newest first', async () => {
    const c = context();
    const result = await run(c.ctx, { title_any: ['engineer', 'developer'], detail: 'full' });
    expect(c.spent()).toBe(1 + 3); // the list, and the three titles that match: not the office manager
    expect(c.http.requests.map((r) => r.url.split('/').slice(-2).join('/'))).toEqual([
      'careers/list',
      '103/detail',
      '102/detail',
      '101/detail',
    ]);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['103', '101', '102']); // ordered by the date each detail gave
    const first = data(result).jobs.find((j) => j.id === '101');
    expect(first).toMatchObject({
      source: 'bamboohr',
      board: 'acme',
      company: 'Acme',
      url: 'https://acme.bamboohr.com/careers/101',
      locations: ['Paris, Île-de-France, France', 'Paris, Île-de-France'],
    });
    expect(first?.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first?.description).toContain('We use React and TypeScript.');
    expect(first?.description).toContain('Salary: 90000 EUR / year');
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: LIST, status: 'ok', jobs_total: 4, relevant: 3 }]);
  });

  it('applies the date range on the date of each detail, since the list has none', async () => {
    const result = await run(context().ctx, { posted_within: 'past_month' });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['103', '101', '104']); // 102 is 40 days old
  });

  it('says so in the location when a position is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['103']);
    expect(data(result).jobs[0]?.locations).toContain('Remote');
  });

  it('reads at most 40 details per board, the highest ids first, and says how many more matched', async () => {
    const many = Array.from({ length: 45 }, (_, i) => listed(String(200 + i), `Engineer ${i}`));
    const c = context([
      route(LIST, { meta: { totalCount: 45 }, result: many }),
      ...many.map((m) => route(DETAIL(m.id), detail(m.id, m.jobOpeningName))),
    ]);
    const result = await run(c.ctx, { max_results: 200 });
    expect(c.spent()).toBe(1 + 40);
    expect(c.http.requests.some((r) => r.url.endsWith('/200/detail'))).toBe(false); // the oldest five are the ones left
    expect(result.warnings.join(' ')).toMatch(/5 more job\(s\) matched the filters but their text was not read/);
  });

  it('leaves out a position that closed since the list, and says so', async () => {
    const c = context([
      route(LIST, { meta: { totalCount: 2 }, result: [listed('101', 'A'), listed('102', 'B')] }),
      route(DETAIL('101'), detail('101', 'A')),
      route(DETAIL('102'), 'gone', 404),
    ]);
    const result = await run(c.ctx);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['101']);
    expect(result.warnings.join(' ')).toMatch(/1 position\(s\) could not be read/);
  });

  it('reports an unknown company (redirected to the vendor site), an error and a changed shape, each on its own', async () => {
    const c = context([
      ...routes(),
      route('https://ghost.bamboohr.com/careers/list', '<html>bamboohr.com</html>'),
      route('https://down.bamboohr.com/careers/list', '', 503),
      route('https://odd.bamboohr.com/careers/list', { nope: 1 }),
    ]);
    const statuses = async (boards: string[]) =>
      ((await tool.handler(tool.input.parse({ boards }), c.ctx)).data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status]);
    expect(await statuses(['acme', 'ghost'])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
    ]);
    expect(await statuses(['down', 'odd'])).toEqual([
      ['down', 'error'],
      ['odd', 'not_this_ats'],
    ]);
  });

  it('takes two companies at most, because each can cost a list and forty details', () => {
    expect(tool.input.safeParse({ boards: ['a', 'b', 'c'] }).success).toBe(false);
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme '])).toEqual(['acme']);
    expect(keys(['https://acme.bamboohr.com/careers/1', 'Nope!'])).toEqual(['acme']);
  });

  it('gives every company a budget that covers a list and its details, and reserves them in the call', () => {
    expect(adapter.keyRate).toEqual({ perHour: 120, perDay: 400 });
    expect(tool.limits.cost).toBe(2 * (1 + 40));
  });
});
