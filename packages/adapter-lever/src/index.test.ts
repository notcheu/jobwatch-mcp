import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): number => Date.now() - days * 86_400_000;

/** Shaped like `GET api.lever.co/v0/postings/<site>?mode=json` (checked against Swile and Pigment). */
function posting(
  id: string,
  title: string,
  over: { where?: string; all?: string[]; days?: number; plain?: string; workplace?: string } = {},
) {
  return {
    id,
    text: title,
    hostedUrl: `https://jobs.lever.co/acme/${id}`,
    applyUrl: `https://jobs.lever.co/acme/${id}/apply`,
    createdAt: ago(over.days ?? 2),
    workplaceType: over.workplace ?? 'hybrid',
    country: 'FR',
    categories: {
      commitment: 'Full-time',
      department: 'Engineering',
      location: over.where ?? 'Paris, France',
      team: 'Web',
      allLocations: over.all ?? [over.where ?? 'Paris, France'],
    },
    descriptionPlain: over.plain ?? `Join us as ${title}. We use React and TypeScript.`,
    description: '<div>html</div>',
    additionalPlain: '5 years of experience required.',
    lists: [{ text: 'What you will do', content: '<li>Build UIs</li><li>Review code</li>' }],
  };
}

const acme = [
  posting('aaaa0001-0000-4000-8000-000000000001', 'Senior Frontend Engineer', { days: 2 }),
  posting('aaaa0002-0000-4000-8000-000000000002', 'Backend Engineer (Java)', { days: 8 }),
  posting('aaaa0003-0000-4000-8000-000000000003', 'Frontend Tech Lead', { where: 'Barcelona, Spain', days: 60 }),
  posting('aaaa0004-0000-4000-8000-000000000004', 'Fullstack Developer', {
    plain: 'Angular and Node.js.',
    days: 3,
    workplace: 'remote',
    where: 'Lyon, France',
  }),
];
const [J1, J2, J3, J4] = acme.map((job) => job.id) as [string, string, string, string];

const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const ACME = 'https://api.lever.co/v0/postings/acme?mode=json';
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'lever', routes });
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
      remote_hints: string[];
    }[];
    excluded: { id: string; reason: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };
const ids = (result: Awaited<ReturnType<typeof run>>) => data(result).jobs.map((j) => j.id);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { lever_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://api.lever.co/v0/postings/${handle}?mode=json`;

  it('takes a site name and keeps its case', () => {
    expect(resolveBoard('swile')).toEqual({ feedUrl: feed('swile'), label: 'swile' });
    expect(resolveBoard(' Modjo ')).toEqual({ feedUrl: feed('Modjo'), label: 'Modjo' });
  });

  it.each([
    ['https://jobs.lever.co/swile', 'swile'],
    ['https://jobs.lever.co/swile/aaaa0001-0000-4000-8000-000000000001?lever-source=x', 'swile'],
    ['https://jobs.lever.co/Modjo/', 'Modjo'],
    ['https://api.lever.co/v0/postings/swile?mode=json', 'swile'],
  ])('takes the site from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://jobs.lever.co/swile',
    'https://jobs.lever.co:8443/swile',
    'https://user@jobs.lever.co/swile',
    'https://jobs.lever.co.evil.example/swile',
    'https://example.com/swile',
    'https://jobs.lever.co/',
    'https://api.lever.co/v1/postings/swile',
    'a/b',
    '../x',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('only ever points at the API host', () => {
    for (const input of ['swile', 'https://jobs.lever.co/swile'])
      expect(new URL(resolveBoard(input)?.feedUrl ?? '').hostname).toBe('api.lever.co');
  });
});

describe('lever_jobs', () => {
  it('reads a board, stores the jobs with source and board named after the site, and reports it', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(c.spent()).toBe(1); // one request for one board
    expect(ids(result)).toEqual([J1, J4, J2, J3]);
    expect(data(result).jobs[0]).toMatchObject({ source: 'lever', board: 'acme', company: null, locations: ['Paris, France'] });
    const full = await run(c.ctx, { detail: 'full' });
    expect(data(full).jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(data(full).jobs[0]?.description).toContain('- Build UIs');
    expect(data(full).jobs[0]?.description).toContain('5 years of experience required.');
    expect(data(result).jobs[0]?.description).toBe('');
    // the summary starts at the role section, not at the intro sentence
    expect(data(result).jobs[0]?.summary).toMatch(/^Role: Build UIs; Review code/);
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 4, relevant: 4 }]);
    expect([...c.jobs.jobs.values()].every((j) => j.source === 'lever' && j.board === 'acme')).toBe(true);
  });

  it('says so in the location when Lever marks a posting remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(ids(result)).toEqual([J4]);
    expect(data(result).jobs[0]?.locations).toEqual(['Lyon, France', 'Remote']);
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
    const result = await run(c.ctx, { boards: ['https://jobs.lever.co/acme', 'acme', 'https://jobs.lever.co/acme/' + J1] });
    expect(ids(result)).toHaveLength(4);
    expect(c.http.requests).toHaveLength(1);
  });

  it('reports one bad board without failing the others, and never reaches another host', async () => {
    const c = context([
      route(ACME, acme),
      route('https://api.lever.co/v0/postings/ghost?mode=json', '{"ok":false}', 404),
      route('https://api.lever.co/v0/postings/odd?mode=json', { not: 'an array' }),
    ]);
    const result = await run(c.ctx, { boards: ['acme', 'ghost', 'odd', 'https://evil.example/acme'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['odd', 'not_this_ats'],
      ['https://evil.example/acme', 'invalid'],
    ]);
    expect(new Set(c.http.requests.map((r) => new URL(r.url).hostname))).toEqual(new Set(['api.lever.co']));
  });

  it('files the board under the lower-case site name', async () => {
    const c = context([
      route('https://api.lever.co/v0/postings/Modjo?mode=json', [posting('bbbb0001-0000-4000-8000-000000000001', 'Data Engineer')]),
    ]);
    expect(data(await run(c.ctx, { boards: ['Modjo'] })).jobs[0]?.board).toBe('modjo');
  });

  it('is closed: one exact host, no open mode', () => {
    expect(adapter.allowedHosts).toEqual(['api.lever.co']);
    expect('openHttps' in adapter).toBe(false);
  });

  it('rejects arguments outside the schema', () => {
    for (const bad of [{}, { boards: [] }, { boards: ['a'], extra: 1 }, { boards: ['a'], posted_within: '24h' }]) {
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
    expect(
      keys(['swile', 'https://jobs.lever.co/swile', 'https://jobs.lever.co/swile/aaaa-1', 'Modjo', 'https://evil.example/swile']),
    ).toEqual(['swile', 'Modjo']);
    expect(keys([])).toEqual([]);
  });

  it('gives every company its own budget and the whole platform a high ceiling', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
