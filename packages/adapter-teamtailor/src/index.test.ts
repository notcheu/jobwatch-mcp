import { HostNotAllowedError } from '@jobwatch/sdk';
import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { basePath, feedFromHtml, resolveBoard, slug } from './board';

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
      summary: string;
      summary_kind: string | null;
      description_chars: number;
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

  it('takes the host of any careers-site URL and drops the query, the fragment and everything from /jobs on', () => {
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
    expect(c.spent()).toBe(1);
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

  it('caps the results, names the rest, and returns the full text only when asked', async () => {
    const c = context();
    const result = await run(c.ctx, { max_results: 2, detail: 'full', description_max_chars: 500 });
    expect(data(result).jobs).toHaveLength(2);
    expect(data(result).not_returned_ids).toHaveLength(2);
    // the fixture descriptions are short, so nothing is cut here; the cut itself is tested with the shared code
    expect(data(result).jobs[0]?.description).toContain('We use React and TypeScript');
    expect(data(result).jobs[0]?.summary).toBe('');
    expect(data(await run(c.ctx, { detail: 'none' })).jobs[0]).toMatchObject({ description: '', summary: '' });
  });

  it('turns the HTML into text, summarizes it by default, and finds hints in it', async () => {
    const c = context();
    const result = await run(c.ctx, { title_any: ['senior'] });
    expect(data(result).jobs[0]).toMatchObject({
      description: '',
      description_chars: c.jobs.jobs.get('8000001')?.description.length ?? -1,
    });
    expect(data(result).jobs[0]?.summary).toContain('We use React and TypeScript.');
    expect(data(result).jobs[0]?.summary).not.toContain('<');
    expect(data(result).jobs[0]?.stack_hints).toEqual(expect.arrayContaining(['react', 'typescript']));
    const full = await run(c.ctx, { title_any: ['senior'], detail: 'full' });
    expect(data(full).jobs[0]?.description).toContain('We use React and TypeScript.');
    expect(data(full).jobs[0]?.description).not.toContain('<');
  });

  it('reports one bad board without failing the others', async () => {
    const c = context([
      route('https://acme.teamtailor.com/jobs.json', acme),
      route('https://ghost.teamtailor.com/jobs.json', 'Not found', 404),
      route('https://careers.notatt.io/jobs.json', '<html>hello</html>'),
      route('https://careers.notatt.io/', 'Not found', 404),
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
    expect(c.spent()).toBe(6); // the invalid entry never reached the network; the site that is not a feed also costs one page read
  });

  it('never asks for a host that cannot be public, and says so', async () => {
    const c = context();
    const result = await run(c.ctx, { boards: ['https://192.168.1.10/', 'https://printer.local/'] });
    expect(data(result).boards.map((b) => b.status)).toEqual(['invalid', 'invalid']);
    expect(c.http.requests).toEqual([]);
    expect(c.spent()).toBe(0);
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
    expect(adapter.rate).toEqual({ perHour: 600, perDay: 3000 }); // a ceiling for the platform
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 }); // the real budget: per company handle
  });
});

describe('finding a board on any domain and path', () => {
  it("keeps the path in front of /jobs, for a careers site mounted under the company's own domain", () => {
    expect(resolveBoard('https://www.acme.com/careers')).toMatchObject({
      feedUrl: 'https://www.acme.com/careers/jobs.json',
      label: 'www.acme.com/careers',
    });
    expect(resolveBoard('https://www.acme.com/careers/')?.feedUrl).toBe('https://www.acme.com/careers/jobs.json');
    expect(resolveBoard('https://www.acme.com/en/careers/jobs/123-dev?x=1#y')?.feedUrl).toBe('https://www.acme.com/en/careers/jobs.json');
    expect(resolveBoard('https://www.acme.com/jobs')?.feedUrl).toBe('https://www.acme.com/jobs.json');
    expect(resolveBoard('https://careers.bsport.io/jobs.rss')?.feedUrl).toBe('https://careers.bsport.io/jobs.json');
  });

  it('remembers the page the caller named, to look at it if the guess is wrong', () => {
    expect(resolveBoard('https://www.acme.com/careers/jobs/123-dev?x=1')?.pageUrl).toBe('https://www.acme.com/careers/jobs/123-dev');
    expect(resolveBoard('bsport')?.pageUrl).toBeUndefined();
  });

  it.each([
    'https://www.acme.com/a%2Fb/jobs',
    'https://www.acme.com/a/b/c/d/e/f/g/jobs',
    'https://www.acme.com/a b/jobs',
    'https://www.acme.com/caf%C3%A9/jobs',
    'https://www.acme.com/a;x/jobs',
  ])('refuses an odd path %j', (url) => {
    expect(resolveBoard(url)).toBeNull();
  });

  it('never lets a path climb out: the URL parser resolves dot segments before the path is looked at', () => {
    for (const url of [
      'https://www.acme.com/a/../etc/jobs',
      'https://www.acme.com/%2e%2e/jobs',
      'https://www.acme.com/a/%2E%2E/b/jobs',
      'https://www.acme.com/..',
    ]) {
      const feed = resolveBoard(url)?.feedUrl ?? '';
      expect(feed).toMatch(/^https:\/\/www\.acme\.com(?:\/[A-Za-z0-9._~-]+)*\/jobs\.json$/);
      expect(feed).not.toMatch(/\.\.|%/);
    }
  });

  it('computes the base path of a careers URL', () => {
    expect(basePath('/')).toBe('');
    expect(basePath('/careers')).toBe('/careers');
    expect(basePath('/careers/jobs/1-x')).toBe('/careers');
    expect(basePath('/jobs.json')).toBe('');
    expect(basePath('/a/./b')).toBeNull();
  });
});

describe('feedFromHtml', () => {
  const page = 'https://www.acme.com/careers';
  const link = (attrs: string) => `<html><head><meta charset="utf-8"><link ${attrs} /></head><body>x</body></html>`;

  it('takes the feed a Teamtailor page advertises, whatever the attribute order', () => {
    expect(
      feedFromHtml(link('rel="alternate" type="application/rss+xml" title="Jobs" href="https://www.acme.com/careers/jobs.rss"'), page),
    ).toBe('https://www.acme.com/careers/jobs.json');
    expect(feedFromHtml(link('href="https://www.acme.com/jobs.rss" type="application/rss+xml" rel="alternate"'), page)).toBe(
      'https://www.acme.com/jobs.json',
    );
    expect(feedFromHtml(link("rel='alternate' type='application/rss+xml' href='/careers/jobs.rss'"), page)).toBe(
      'https://www.acme.com/careers/jobs.json',
    );
    expect(feedFromHtml(link('rel="alternate" type="application/feed+json" href="https://www.acme.com/careers/jobs.json"'), page)).toBe(
      'https://www.acme.com/careers/jobs.json',
    );
  });

  it('ignores a feed on another host, over http, on a port, with credentials, off the jobs path, or with an odd path', () => {
    for (const href of [
      'https://evil.example/jobs.rss',
      'http://www.acme.com/jobs.rss',
      'https://www.acme.com:8443/jobs.rss',
      'https://user@www.acme.com/jobs.rss',
      'https://www.acme.com/admin/export.rss',
      'https://169.254.169.254/jobs.rss',
    ]) {
      expect(feedFromHtml(link(`rel="alternate" type="application/rss+xml" href="${href}"`), page), href).toBeNull();
    }
  });

  it('returns null for a page with no advertised feed, a non-feed alternate, or garbage', () => {
    expect(feedFromHtml('<html><body>nothing</body></html>', page)).toBeNull();
    expect(feedFromHtml(link('rel="alternate" hreflang="fr" href="https://www.acme.com/fr"'), page)).toBeNull();
    expect(feedFromHtml(link('rel="stylesheet" type="application/rss+xml" href="https://www.acme.com/jobs.rss"'), page)).toBeNull();
    expect(feedFromHtml('<link' + 'x'.repeat(100_000), page)).toBeNull();
    expect(feedFromHtml('', 'not a url')).toBeNull();
  });
});

describe('teamtailor_jobs on a site that is not at the guessed address', () => {
  const careersHtml = (feed: string) =>
    `<html><head><link rel="alternate" type="application/rss+xml" title="Jobs" href="${feed}" /></head><body>Careers</body></html>`;

  it('finds a careers site mounted under a path, from any page of it', async () => {
    const routes = [
      route('https://www.acme.com/careers/jobs/123-dev/jobs.json', 'Not found', 404),
      route('https://www.acme.com/careers/jobs/123-dev', careersHtml('https://www.acme.com/team/careers/jobs.rss')),
      route('https://www.acme.com/team/careers/jobs.json', acme),
    ];
    // the caller's URL is the page itself; the guess (/careers/jobs.json) fails, the page advertises the real feed
    const wrong = [
      route('https://www.acme.com/careers/jobs.json', 'Not found', 404),
      route('https://www.acme.com/careers/jobs/123-dev', careersHtml('https://www.acme.com/team/careers/jobs.rss')),
      route('https://www.acme.com/team/careers/jobs.json', acme),
    ];
    void routes;
    const c = context(wrong);
    const result = await run(c.ctx, { boards: ['https://www.acme.com/careers/jobs/123-dev'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards[0]).toMatchObject({ status: 'ok', feed_url: 'https://www.acme.com/team/careers/jobs.json' });
    expect(c.http.requests.map((r) => r.url)).toEqual([
      'https://www.acme.com/careers/jobs.json',
      'https://www.acme.com/careers/jobs/123-dev',
      'https://www.acme.com/team/careers/jobs.json',
    ]);
    expect(c.spent()).toBe(3);
  });

  it('uses the guess when it is right, without reading the page', async () => {
    const c = context([route('https://www.acme.com/careers/jobs.json', acme)]);
    const result = await run(c.ctx, { boards: ['https://www.acme.com/careers'] });
    expect(ids(result)).toHaveLength(4);
    expect(c.http.requests).toHaveLength(1);
  });

  it('reports a page that advertises no Teamtailor feed as not found, and never follows a feed on another host', async () => {
    const none = context([
      route('https://www.acme.com/jobs.json', 'nope', 404),
      route('https://www.acme.com/', '<html><body>No feed here</body></html>'),
    ]);
    const r1 = await run(none.ctx, { boards: ['https://www.acme.com/'] });
    expect(data(r1).boards[0]).toMatchObject({ status: 'not_found' });
    const evil = context([
      route('https://www.acme.com/jobs.json', 'nope', 404),
      route('https://www.acme.com/', careersHtml('https://evil.example/jobs.rss')),
      route('https://evil.example/jobs.json', acme),
    ]);
    const r2 = await run(evil.ctx, { boards: ['https://www.acme.com/'] });
    expect(data(r2).boards[0]).toMatchObject({ status: 'not_found' });
    expect(evil.http.requests.map((r) => new URL(r.url).hostname)).not.toContain('evil.example');
  });

  it('also looks at the page when the guessed address answers something that is not a feed', async () => {
    const c = context([
      route('https://www.acme.com/jobs.json', '<html>a marketing page</html>'),
      route('https://www.acme.com/', careersHtml('https://www.acme.com/people/jobs.rss')),
      route('https://www.acme.com/people/jobs.json', acme),
    ]);
    const result = await run(c.ctx, { boards: ['https://www.acme.com/'] });
    expect(ids(result)).toHaveLength(4);
    expect(data(result).boards[0]?.feed_url).toBe('https://www.acme.com/people/jobs.json');
  });

  it('does not run discovery for a handle: there is no page to look at', async () => {
    const c = context([route('https://ghost.teamtailor.com/jobs.json', 'nope', 404)]);
    const result = await run(c.ctx, { boards: ['ghost'] });
    expect(data(result).boards[0]).toMatchObject({ status: 'not_found' });
    expect(c.http.requests).toHaveLength(1);
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
      keys([
        'bsport',
        ' bsport ',
        'https://bsport.teamtailor.com/jobs/8429717-vp',
        'https://careers.bsport.io/',
        'https://www.acme.com/careers/jobs/1-x',
        'Not A Handle',
        'https://192.168.1.1/',
      ]),
    ).toEqual(['bsport', 'careers.bsport.io', 'www.acme.com/careers']);
    expect(keys([])).toEqual([]);
  });

  it('gives every company its own budget and the whole platform a high ceiling', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
    expect(adapter.rate).toEqual({ perHour: 600, perDay: 3000 });
  });
});
