import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like `GET <handle>.careers.hibob.com/api/job-ad` (checked against leboncoin). */
function ad(id: string, title: string, over: { site?: string; days?: number; workspace?: string; pay?: [number, number] } = {}) {
  return {
    id,
    title,
    departmentId: 'Tech',
    department: 'Product & Tech',
    employmentType: 'Regular',
    siteId: 1,
    site: over.site ?? 'Paris',
    country: 'France',
    language: 'fr',
    description: `<p>Join us as ${title}. We use React and TypeScript.</p>`,
    requirements: '<ul><li>5 years of experience required.</li></ul>',
    responsibilities: '<ul><li>Build UIs</li><li>Review code</li></ul>',
    benefits: '<p>Remote days</p>',
    sectionLabels: { requirements: 'Requirements', responsibilities: 'Responsibilities', benefits: 'Benefits' },
    publishedAt: ago(over.days ?? 2),
    workspaceTypeId: over.workspace ?? 'hybrid',
    workspaceType: 'x',
    payTransparencyMinSalary: over.pay?.[0] ?? null,
    payTransparencyMaxSalary: over.pay?.[1] ?? null,
    payTransparencySalaryCurrency: over.pay === undefined ? null : 'EUR',
    payTransparencySalaryPayPeriod: over.pay === undefined ? null : 'YEARLY',
  };
}

const board = {
  filterGroups: { departments: [], sites: [] },
  jobAdDetails: [
    ad('11111111-1111-4111-8111-111111111111', 'Senior Frontend Engineer', { pay: [60000, 80000], days: 2 }),
    ad('22222222-2222-4222-8222-222222222222', 'Backend Engineer', { days: 9 }),
    ad('33333333-3333-4333-8333-333333333333', 'Fullstack Developer', { workspace: 'remote', site: 'Lyon', days: 1 }),
  ],
};
const [J1, J2, J3] = board.jobAdDetails.map((job) => job.id) as [string, string, string];
const ACME = 'https://acme.careers.hibob.com/api/job-ad';
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const context = (routes: FakeHttpRoute[] = [route(ACME, board)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'hibob', routes });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: { id: string; board: string; company: string | null; url: string; locations: string[]; description: string; source: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { hibob_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://${handle}.careers.hibob.com/api/job-ad`;

  it('takes a subdomain', () => {
    expect(resolveBoard('leboncoin')).toEqual({ feedUrl: feed('leboncoin'), label: 'leboncoin' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: feed('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://leboncoin.careers.hibob.com', 'leboncoin'],
    ['https://leboncoin.careers.hibob.com/jobs/cd4065b4-630c-40e2-a7ed-d19bba19adbf/apply', 'leboncoin'],
    ['https://leboncoin.careers.hibob.com/api/job-ad', 'leboncoin'],
  ])('takes the subdomain from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://leboncoin.careers.hibob.com',
    'https://leboncoin.careers.hibob.com:8443',
    'https://user@leboncoin.careers.hibob.com',
    'https://leboncoin.careers.hibob.com.evil.example',
    'https://careers.hibob.com',
    'https://leboncoin.hibob.com',
    'https://leboncoincorporate.com/rejoignez-nous/',
    'Leboncoin',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });
});

describe('hibob_jobs', () => {
  it('reads a board with the company in the header, and builds the job address', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(c.spent()).toBe(1);
    expect(c.http.requests[0]).toMatchObject({ method: 'GET', headers: { companyidentifier: 'acme' } });
    expect(data(result).jobs.map((j) => j.id)).toEqual([J3, J1, J2]);
    expect(data(result).jobs[0]).toMatchObject({
      source: 'hibob',
      board: 'acme',
      company: 'Acme',
      url: `https://acme.careers.hibob.com/jobs/${J3}`,
      locations: ['Lyon, France', 'Remote'],
    });
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 3, relevant: 3 }]);
  });

  it('puts the four parts of the text and the published pay in the description', async () => {
    const full = await run(context().ctx, { detail: 'full' });
    const text = data(full).jobs.find((j) => j.id === J1)?.description ?? '';
    expect(text).toContain('We use React and TypeScript.');
    expect(text).toContain('Requirements\n');
    expect(text).toContain('Review code');
    expect(text).toContain('Salary: 60000-80000 EUR per yearly');
  });

  it('says so in the location when a job is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual([J3]);
    expect(data(result).jobs[0]?.locations).toEqual(['Lyon, France', 'Remote']);
  });

  it('reports an unknown company (answered 401), an error and a changed shape, each on its own', async () => {
    const c = context([
      route(ACME, board),
      route('https://ghost.careers.hibob.com/api/job-ad', '<html>401</html>', 401),
      route('https://down.careers.hibob.com/api/job-ad', '', 503),
      route('https://odd.careers.hibob.com/api/job-ad', { nope: 1 }),
    ]);
    const result = await tool.handler(tool.input.parse({ boards: ['acme', 'ghost', 'down', 'odd'] }), c.ctx);
    expect((result.data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['down', 'error'],
      ['odd', 'not_this_ats'],
    ]);
    expect(c.spent()).toBe(4);
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme ', 'https://acme.careers.hibob.com/jobs/x', 'Nope!'])).toEqual(['acme']);
  });

  it('gives every company its own budget', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
