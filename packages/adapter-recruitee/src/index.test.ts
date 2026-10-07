import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): string =>
  new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');

/** Shaped like `GET <handle>.recruitee.com/api/offers/` (checked against bunq). */
function offer(id: number, title: string, over: { city?: string; days?: number; remote?: boolean; status?: string } = {}) {
  return {
    id,
    slug: title.toLowerCase().replace(/\W+/g, '-'),
    status: over.status ?? 'published',
    title,
    careers_url: `https://acme.recruitee.com/o/${id}`,
    company_name: 'Acme',
    published_at: ago(over.days ?? 2),
    location: `${over.city ?? 'Paris'}, Île-de-France, France`,
    city: over.city ?? 'Paris',
    country: 'France',
    remote: over.remote ?? false,
    hybrid: true,
    description: `<p>Join us as ${title}. We use React and TypeScript.</p>`,
    requirements: '<ul><li>5 years of experience required.</li></ul>',
    locations: [{ id: 1, name: over.city ?? 'Paris', city: over.city ?? 'Paris', country: 'France' }],
  };
}

const acme = {
  offers: [
    offer(1001, 'Senior Frontend Engineer', { days: 3 }),
    offer(1002, 'Backend Engineer', { days: 9 }),
    offer(1003, 'Fullstack Developer', { remote: true, city: 'Lyon', days: 1 }),
    offer(1004, 'Draft Role', { status: 'draft' }),
  ],
};
const ACME = 'https://acme.recruitee.com/api/offers/';
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'recruitee', routes });
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
      source: string;
      posted_at: string | null;
    }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { recruitee_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://${handle}.recruitee.com/api/offers/`;

  it('takes a subdomain', () => {
    expect(resolveBoard('bunq')).toEqual({ feedUrl: feed('bunq'), label: 'bunq' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: feed('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://bunq.recruitee.com', 'bunq'],
    ['https://bunq.recruitee.com/o/website-lead', 'bunq'],
    ['https://bunq.recruitee.com/api/offers/', 'bunq'],
  ])('takes the subdomain from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://bunq.recruitee.com',
    'https://bunq.recruitee.com:8443',
    'https://user@bunq.recruitee.com',
    'https://bunq.recruitee.com.evil.example',
    'https://careers.bunq.com/o/website-lead',
    'https://api.recruitee.com/c/1/offers',
    'https://a.b.recruitee.com',
    'Bunq',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('only ever points at a recruitee.com host', () => {
    for (const input of ['bunq', 'https://bunq.recruitee.com/o/x'])
      expect(new URL(resolveBoard(input)?.feedUrl ?? '').hostname).toBe('bunq.recruitee.com');
  });
});

describe('recruitee_jobs', () => {
  it('reads a board, leaves out what is not published, and names the company', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(c.spent()).toBe(1); // one request for one board
    expect(data(result).jobs.map((j) => j.id)).toEqual(['1003', '1001', '1002']);
    expect(data(result).jobs[0]).toMatchObject({
      source: 'recruitee',
      board: 'acme',
      company: 'Acme',
      locations: ['Paris, France', 'Paris, Île-de-France, France'],
    });
    expect(data(result).jobs[0]?.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 3, relevant: 3 }]);
    const full = await run(c.ctx, { detail: 'full' });
    expect(data(full).jobs.find((j) => j.id === '1001')?.description).toContain('We use React and TypeScript.');
    expect(data(full).jobs.find((j) => j.id === '1001')?.description).toContain('5 years of experience required.');
  });

  it('says so in the location when an offer is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['1003']);
    expect(data(result).jobs[0]?.locations).toContain('Remote');
  });

  it('reports a board that does not exist, an error, and an answer that is not an offer list, each on its own', async () => {
    const c = context([
      route(ACME, acme),
      route('https://ghost.recruitee.com/api/offers/', { error: 'Not Found' }, 404),
      route('https://odd.recruitee.com/api/offers/', { nope: 1 }),
    ]);
    const result = await tool.handler(tool.input.parse({ boards: ['acme', 'ghost', 'odd', 'Not A Handle'] }), c.ctx);
    expect((result.data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['odd', 'not_this_ats'],
      ['Not A Handle', 'invalid'],
    ]);
    expect(c.spent()).toBe(3); // the invalid one costs nothing
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme ', 'https://acme.recruitee.com/o/1', 'nope!'])).toEqual(['acme']);
  });

  it('gives every company its own budget and the whole platform a high ceiling', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
