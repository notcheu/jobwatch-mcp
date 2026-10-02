import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like `GET boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true`: content is entity-encoded HTML. */
function job(id: number, title: string, over: { where?: string; company?: string; days?: number; html?: string } = {}) {
  const html =
    over.html ?? `<p>Join us as <strong>${title}</strong>.</p><ul><li>React &amp; TypeScript</li><li>5 years of experience</li></ul>`;
  const encoded = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    id,
    internal_job_id: id * 3,
    title,
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    company_name: over.company ?? 'Acme',
    location: { name: over.where ?? 'Paris, France' },
    first_published: ago(over.days ?? 2),
    updated_at: ago(0),
    requisition_id: `R-${id}`,
    content: encoded,
    departments: [{ id: 1, name: 'Engineering' }],
    offices: [],
    metadata: null,
  };
}

const acme = {
  jobs: [
    job(4001, 'Senior Frontend Engineer', { days: 2 }),
    job(4002, 'Backend Engineer (Java)', { days: 8 }),
    job(4003, 'Frontend Tech Lead', { where: 'Barcelona, Spain', days: 60 }),
    job(4004, 'Fullstack Developer', { html: '<p>Angular and Node.js.</p>', days: 3 }),
  ],
  meta: { total: 4 },
};

const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const ACME = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'greenhouse', routes });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: {
      id: string;
      board: string;
      company: string;
      locations: string[];
      description: string;
      summary: string;
      source: string;
      new: boolean;
      stack_hints: string[];
    }[];
    excluded: { id: string; reason: string; term: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };
const ids = (result: Awaited<ReturnType<typeof run>>) => data(result).jobs.map((j) => j.id);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { greenhouse_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://boards-api.greenhouse.io/v1/boards/${handle}/jobs?content=true`;

  it('takes a board token', () => {
    expect(resolveBoard('algolia')).toEqual({ feedUrl: feed('algolia'), label: 'algolia' });
    expect(resolveBoard(' Pipe_Drive-2 ')?.feedUrl).toBe(feed('Pipe_Drive-2'));
  });

  it.each([
    ['https://boards.greenhouse.io/algolia', 'algolia'],
    ['https://boards.greenhouse.io/algolia/jobs/4001?gh_src=x#top', 'algolia'],
    ['https://job-boards.greenhouse.io/algolia', 'algolia'],
    ['https://job-boards.greenhouse.io/algolia/jobs/4001', 'algolia'],
    ['https://boards.greenhouse.io/embed/job_board?for=algolia', 'algolia'],
    ['https://boards-api.greenhouse.io/v1/boards/algolia/jobs', 'algolia'],
  ])('takes the board from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://boards.greenhouse.io/algolia',
    'https://boards.greenhouse.io:8443/algolia',
    'https://user@boards.greenhouse.io/algolia',
    'https://example.com/algolia',
    'https://boards.greenhouse.io.evil.example/algolia',
    'https://boards.greenhouse.io/',
    'https://boards.greenhouse.io/embed/job_board',
    'https://boards.greenhouse.io/a b',
    'https://boards-api.greenhouse.io/v2/boards/algolia/jobs',
    '../etc/passwd',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('never builds a request outside the API host, whatever URL it is given', () => {
    for (const url of ['https://boards.greenhouse.io/algolia', 'https://job-boards.greenhouse.io/algolia', 'algolia']) {
      expect(new URL(resolveBoard(url)?.feedUrl ?? '').hostname).toBe('boards-api.greenhouse.io');
    }
  });
});

describe('greenhouse_jobs', () => {
  it('reads a board, decodes the HTML, stores the jobs with source and board, and reports the board', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(ids(result)).toEqual(['4001', '4004', '4002', '4003']);
    expect(data(result).jobs[0]).toMatchObject({
      source: 'greenhouse',
      board: 'acme',
      company: 'Acme',
      locations: ['Paris, France'],
      new: true,
    });
    expect(data(result).jobs[0]?.summary).toContain('React & TypeScript');
    expect(data(result).jobs[0]?.summary).not.toMatch(/[<>]|&amp;|&lt;/);
    expect(data(result).jobs[0]?.description).toBe('');
    expect(data(result).jobs[0]?.stack_hints).toEqual(expect.arrayContaining(['react', 'typescript']));
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 4, relevant: 4 }]);
    expect([...c.jobs.jobs.values()].every((j) => j.source === 'greenhouse' && j.board === 'acme')).toBe(true);
    expect(result.cost).toBe(1);
    expect(c.http.requests.map((r) => r.url)).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs']);
    const full = await run(c.ctx, { detail: 'full' });
    expect(data(full).jobs[0]?.description).toContain('React & TypeScript');
    expect(data(full).jobs[0]?.description).not.toMatch(/[<>]|&amp;|&lt;/);
  });

  it('applies the shared filters and rules', async () => {
    const c = context();
    expect(ids(await run(c.ctx, { title_any: ['front'], location_any: ['paris'] }))).toEqual(['4001']);
    expect(ids(await run(c.ctx, { posted_within: 'past_week' }))).toEqual(['4001', '4004']);
    const byTitle = await run(c.ctx, { disallowed_terms: ['java'] });
    expect(data(byTitle).excluded.map((e) => [e.id, e.reason])).toEqual([['4002', 'title']]);
    expect(c.jobs.jobs.has('4002')).toBe(false);
    const byDescription = await run(c.ctx, { disallowed_terms: ['angular'], disallowed_scope: 'title_then_description' });
    expect(data(byDescription).excluded.map((e) => [e.id, e.reason])).toEqual([['4004', 'description']]);
    expect(c.jobs.jobs.has('4004')).toBe(true);
  });

  it('reads a board given as a URL, and two forms of the same board once', async () => {
    const c = context();
    const result = await run(c.ctx, {
      boards: ['https://boards.greenhouse.io/acme/jobs/4001', 'acme', 'https://job-boards.greenhouse.io/acme'],
    });
    expect(ids(result)).toHaveLength(4);
    expect(c.http.requests).toHaveLength(1); // the same board three ways is one request
  });

  it('reports one bad board without failing the others, and never reaches another host', async () => {
    const c = context([
      route(ACME, acme),
      route('https://boards-api.greenhouse.io/v1/boards/ghost/jobs?content=true', 'Not found', 404),
      route('https://boards-api.greenhouse.io/v1/boards/odd/jobs?content=true', { oops: true }),
      route('https://boards-api.greenhouse.io/v1/boards/down/jobs?content=true', 'x', 503),
    ]);
    const result = await run(c.ctx, { boards: ['acme', 'ghost', 'odd', 'down', 'https://evil.example/acme', 'https://192.168.1.1/'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['odd', 'not_this_ats'],
      ['down', 'error'],
      ['https://evil.example/acme', 'invalid'],
      ['https://192.168.1.1/', 'invalid'],
    ]);
    expect(result.cost).toBe(4);
    expect(new Set(c.http.requests.map((r) => new URL(r.url).hostname))).toEqual(new Set(['boards-api.greenhouse.io']));
  });

  it('names the board after the company the API reports, even if the token differs', async () => {
    const c = context([
      route('https://boards-api.greenhouse.io/v1/boards/acme2/jobs?content=true', {
        jobs: [job(5001, 'Data Engineer', { company: 'Société Acme' })],
      }),
    ]);
    const result = await run(c.ctx, { boards: ['acme2'] });
    expect(data(result).jobs[0]?.board).toBe('societe-acme');
  });

  it('is closed: no open mode, one exact host', () => {
    expect(adapter.allowedHosts).toEqual(['boards-api.greenhouse.io']);
    expect('openHttps' in adapter).toBe(false);
  });

  it('rejects arguments outside the schema', () => {
    for (const bad of [{}, { boards: [] }, { boards: Array.from({ length: 11 }, (_, i) => `b${i}`) }, { boards: ['a'], extra: 1 }]) {
      expect(tool.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
