import { HostNotAllowedError } from '@jobwatch/sdk';
import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard, slug } from './board';

/** A feed shaped like the real `/jobs.json` of a Teamtailor board (checked against bsport, PayFit, Ornikar and Swile). */
function posting(
  id: number,
  title: string,
  over: { city?: string; country?: string; date?: string; html?: string; company?: string } = {},
) {
  const city = over.city ?? 'Paris';
  const country = over.country ?? 'FR';
  const html =
    over.html ?? `<p>Join us as <strong>${title}</strong>. We use React and TypeScript.</p><ul><li>5 years of experience</li></ul>`;
  return {
    id: `uuid-${id}`,
    title,
    url: `https://careers.example-company.io/jobs/${id}-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    date_published: over.date ?? '2026-09-21T17:13:42+02:00',
    content_html: html,
    _jobposting: {
      '@type': 'JobPosting',
      title,
      description: html,
      identifier: { '@type': 'PropertyValue', name: over.company ?? 'Acme', value: id },
      datePosted: over.date ?? '2026-09-21T17:13:42+02:00',
      hiringOrganization: { '@type': 'Organization', name: over.company ?? 'Acme', sameAs: 'https://careers.example-company.io' },
      jobLocation: [
        {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            streetAddress: '1 rue X',
            addressLocality: city,
            postalCode: '75010',
            addressCountry: country,
            addressRegion: null,
          },
        },
      ],
    },
  };
}

/** An ISO time `days` days before now, so the date-range tests mean the same whenever they run. */
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

const feed = (title: string, ...items: ReturnType<typeof posting>[]) => ({ version: 'https://jsonfeed.org/version/1.1', title, items });
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });

const acme = feed(
  'Acme',
  posting(8000001, 'Senior Frontend Engineer', { date: ago(2) }),
  posting(8000002, 'Backend Engineer (Java)', { date: ago(8) }),
  posting(8000003, 'Frontend Tech Lead', { city: 'Barcelona', country: 'ES', date: ago(60) }),
  posting(8000004, 'Fullstack Developer', { html: '<p>Angular and Node.js.</p>', date: ago(3) }),
);

function context(routes: FakeHttpRoute[] = [route('https://acme.teamtailor.com/jobs.json', acme)]) {
  return createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'teamtailor', openHttps: true, routes });
}
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
const run = (ctx: ReturnType<typeof context>['ctx'], over: object) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const ids = (result: Awaited<ReturnType<typeof run>>) => (result.data as { jobs: { id: string }[] }).jobs.map((job) => job.id);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: {
      id: string;
      board: string;
      new: boolean;
      description: string;
      description_truncated: boolean;
      source: string;
      read_from: string;
      first_seen: string;
      stack_hints: string[];
    }[];
    excluded: { id: string; reason: string; term: string }[];
    boards: {
      board: string;
      status: string;
      jobs_total: number | null;
      relevant: number | null;
      feed_url: string | null;
      message?: string;
    }[];
    not_returned_ids: string[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { teamtailor_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  it('turns a handle into the teamtailor.com feed', () => {
    expect(resolveBoard('bsport')).toMatchObject({ feedUrl: 'https://bsport.teamtailor.com/jobs.json', label: 'bsport' });
    expect(resolveBoard(' pay-fit2 ')?.feedUrl).toBe('https://pay-fit2.teamtailor.com/jobs.json');
  });

  it('takes the host of any careers-site URL and drops the path, query and fragment', () => {
    expect(resolveBoard('https://careers.bsport.io/')).toMatchObject({
      feedUrl: 'https://careers.bsport.io/jobs.json',
      label: 'careers.bsport.io',
    });
    expect(resolveBoard('https://bsport.teamtailor.com/jobs/8429717-vp-of-engineering?utm=x#apply')).toMatchObject({
      feedUrl: 'https://bsport.teamtailor.com/jobs.json',
      label: 'bsport',
    });
  });

  it.each([
    'http://careers.bsport.io/',
    'https://careers.bsport.io:8443/',
    'https://user:pw@careers.bsport.io/',
    'https://127.0.0.1/',
    'https://192.168.1.10/jobs',
    'https://localhost/',
    'https://printer.local/',
    'ftp://careers.bsport.io/',
    'Not A Handle',
    '-bad',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('makes a stable lower-case board name', () => {
    expect(slug('PayFit')).toBe('payfit');
    expect(slug('Le Bon Coin & Co.')).toBe('le-bon-coin-co');
    expect(slug('Société Générale')).toBe('societe-generale');
  });
});

describe('teamtailor_jobs', () => {
  it('reads a feed, stores every job whose title passes, and reports the board', async () => {
    const c = context();
    const result = await run(c.ctx, {});
    expect(ids(result)).toEqual(['8000001', '8000004', '8000002', '8000003']); // newest first
    expect(data(result).jobs[0]).toMatchObject({ source: 'teamtailor', board: 'acme', read_from: 'fetched', new: true });
    expect(data(result).boards).toEqual([
      { board: 'acme', feed_url: 'https://acme.teamtailor.com/jobs.json', status: 'ok', jobs_total: 4, relevant: 4 },
    ]);
    expect([...c.jobs.jobs.values()].every((job) => job.source === 'teamtailor' && job.board === 'acme')).toBe(true);
    expect(c.jobs.jobs.size).toBe(4);
    expect(result.cost).toBe(1);
  });

  it('reads a company on its own domain, once the host is open', async () => {
    const c = context([route('https://careers.acme.io/jobs.json', acme)]);
    const result = await run(c.ctx, { boards: ['https://careers.acme.io/jobs/123-x'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).jobs[0]?.board).toBe('acme'); // named after the company the feed announces, not the domain
  });

  it('files the same company under one board whether it is reached by handle or by domain', async () => {
    const c = context([route('https://acme.teamtailor.com/jobs.json', acme), route('https://careers.acme.io/jobs.json', acme)]);
    const result = await run(c.ctx, { boards: ['acme', 'https://careers.acme.io/'] });
    expect(ids(result)).toHaveLength(4);
    expect(c.jobs.jobs.size).toBe(4);
    expect(result.warnings.join(' ')).toMatch(/already listed by another board/);
    // each report counts what IT contributed: the second board of the same company adds nothing new
    expect(data(result).boards.map((b) => [b.jobs_total, b.relevant])).toEqual([
      [4, 4],
      [4, 0],
    ]);
  });

  it('filters by title words (substring, accents and case ignored), office and date', async () => {
    const c = context();
    expect(ids(await run(c.ctx, { title_any: ['front'] }))).toEqual(['8000001', '8000003']);
    expect(ids(await run(c.ctx, { location_any: ['paris'] }))).toEqual(['8000001', '8000004', '8000002']);
    expect(ids(await run(c.ctx, { location_any: ['ES'] }))).toEqual(['8000003']);
    expect(ids(await run(c.ctx, { posted_within: 'last_24_hours' }))).toEqual([]);
    expect(ids(await run(c.ctx, { posted_within: 'past_week' }))).toEqual(['8000001', '8000004']);
    expect(ids(await run(c.ctx, { posted_within: 'past_month' }))).toEqual(['8000001', '8000004', '8000002']);
    expect(ids(await run(c.ctx, { posted_within: 'any' }))).toHaveLength(4);
  });

  it('drops a disallowed title without storing it, and a description match after storing it', async () => {
    const c = context();
    const byTitle = await run(c.ctx, { disallowed_terms: ['Fullstack', 'Java'] });
    expect(data(byTitle).excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      ['8000004', 'title', 'Fullstack'],
      ['8000002', 'title', 'Java'],
    ]);
    expect(c.jobs.jobs.has('8000004')).toBe(false);
    expect(c.jobs.jobs.has('8000002')).toBe(false);

    const c2 = context();
    const byDescription = await run(c2.ctx, { disallowed_terms: ['angular'], disallowed_scope: 'title_then_description' });
    expect(data(byDescription).excluded).toEqual([
      { id: '8000004', board: 'acme', title: 'Fullstack Developer', reason: 'description', term: 'angular' },
    ]);
    expect(c2.jobs.jobs.has('8000004')).toBe(true); // stored although rejected: other terms will judge it from the database
    expect(ids(byDescription)).not.toContain('8000004');
  });

  it('only_new returns jobs not stored before, and a second call marks them as seen', async () => {
    const c = context();
    await run(c.ctx, {});
    const again = await run(c.ctx, {});
    expect(data(again).jobs.every((job) => job.new === false)).toBe(true);
    expect(ids(await run(c.ctx, { only_new: true }))).toEqual([]);
    const feedWithOneMore = feed('Acme', ...acme.items, posting(8000005, 'Design System Engineer', { date: ago(1) }));
    const c2 = createHttpTestContext({
      allowedHosts: adapter.allowedHosts,
      platform: 'teamtailor',
      openHttps: true,
      routes: [route('https://acme.teamtailor.com/jobs.json', feedWithOneMore)],
    });
    for (const [id, job] of c.jobs.jobs) c2.jobs.jobs.set(id, job);
    expect(ids(await run(c2.ctx, { only_new: true }))).toEqual(['8000005']);
  });

  it('refreshes last_seen of stored jobs it sees again', async () => {
    const c = context();
    await run(c.ctx, { title_any: ['zzz-nothing'] }); // nothing relevant, nothing stored yet
    await run(c.ctx, {});
    const old = '2026-01-01T00:00:00.000Z';
    for (const [id, job] of c.jobs.jobs) c.jobs.jobs.set(id, { ...job, lastSeen: old });
    await run(c.ctx, { title_any: ['zzz-nothing'] }); // all filtered out, but still listed
    expect([...c.jobs.jobs.values()].every((job) => job.lastSeen !== old)).toBe(true);
  });

  it('caps the results, names the rest, and truncates descriptions but stores the full text', async () => {
    const c = context();
    const result = await run(c.ctx, { max_results: 2, description_max_chars: 20 });
    expect(data(result).jobs).toHaveLength(2);
    expect(data(result).not_returned_ids).toHaveLength(2);
    expect(data(result).jobs[0]?.description).toHaveLength(20);
    expect(data(result).jobs[0]?.description_truncated).toBe(true);
    expect((c.jobs.jobs.get('8000001')?.description.length ?? 0) > 20).toBe(true);
    expect(data(await run(c.ctx, { description_max_chars: 0 })).jobs[0]?.description).toBe('');
  });

  it('turns the HTML into text and finds hints in it', async () => {
    const result = await run(context().ctx, { title_any: ['senior'] });
    expect(data(result).jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(data(result).jobs[0]?.description).not.toContain('<');
    expect(data(result).jobs[0]?.stack_hints).toEqual(expect.arrayContaining(['react', 'typescript']));
  });

  it('reports one bad board without failing the others', async () => {
    const c = context([
      route('https://acme.teamtailor.com/jobs.json', acme),
      route('https://ghost.teamtailor.com/jobs.json', 'Not found', 404),
      route('https://careers.notatt.io/jobs.json', '<html>hello</html>'),
      route('https://careers.broken.io/jobs.json', { items: 'nope' }),
      route('https://down.teamtailor.com/jobs.json', 'oops', 503),
    ]);
    const result = await run(c.ctx, {
      boards: ['acme', 'ghost', 'https://careers.notatt.io/', 'https://careers.broken.io/', 'down', 'Not A Handle'],
    });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['careers.notatt.io', 'not_this_ats'],
      ['careers.broken.io', 'not_this_ats'],
      ['down', 'error'],
      ['Not A Handle', 'invalid'],
    ]);
    expect(result.warnings.join(' ')).toMatch(/ghost: not_found/);
    expect(result.cost).toBe(5); // the invalid entry never reached the network
  });

  it('never asks for a host that cannot be public, and says so', async () => {
    const c = context();
    const result = await run(c.ctx, { boards: ['https://192.168.1.10/', 'https://printer.local/'] });
    expect(data(result).boards.map((b) => b.status)).toEqual(['invalid', 'invalid']);
    expect(c.http.requests).toEqual([]);
    expect(result.cost).toBe(0);
  });

  it('reports a refused host (the client said no) as refused, not as a crash', async () => {
    const c = context([]);
    c.http.get = async () => {
      throw new HostNotAllowedError('careers.evil.example.org');
    };
    const result = await run(c.ctx, { boards: ['https://careers.evil.example.org/'] });
    expect(data(result).boards[0]).toMatchObject({ status: 'refused' });
  });

  it('keeps jobs without a date when a date range is asked, and skips postings without a usable id', async () => {
    const undated = {
      ...posting(8000009, 'Platform Engineer'),
      date_published: null,
      _jobposting: { ...posting(8000009, 'Platform Engineer')._jobposting, datePosted: null },
    };
    const noId = { title: 'Mystery', url: 'https://acme.teamtailor.com/careers', content_html: '<p>x</p>' };
    const c = context([route('https://acme.teamtailor.com/jobs.json', { title: 'Acme', items: [undated, noId] })]);
    const result = await run(c.ctx, { posted_within: 'past_week' });
    expect(ids(result)).toEqual(['8000009']);
  });

  it('rejects arguments outside the schema', () => {
    for (const bad of [
      {},
      { boards: [] },
      { boards: Array.from({ length: 11 }, (_, i) => `b${i}`) },
      { boards: ['a'], max_results: 201 },
      { boards: ['a'], posted_within: '24h' },
      { boards: ['a'], extra: 1 },
    ]) {
      expect(tool.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the adapter declares what it reaches', () => {
  it('lists the teamtailor.com wildcard, is open for custom domains, and has its own budget', () => {
    expect(adapter.allowedHosts).toEqual(['*.teamtailor.com']);
    expect(adapter.kind === 'http' && adapter.openHttps).toBe(true);
    expect(adapter.rate).toEqual({ perHour: 120, perDay: 600 });
  });
});
