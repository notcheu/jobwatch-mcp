import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';
import { descriptionFromPage } from './feed';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like `GET <handle>.breezy.hr/json` (checked against RhynoCare). */
const listed = (
  id: string,
  slug: string,
  name: string,
  over: { days?: number; city?: string; remote?: boolean; salary?: string | null } = {},
) => ({
  id,
  friendly_id: `${id}-${slug}`,
  name,
  url: `https://acme.breezy.hr/p/${id}-${slug}`,
  published_date: ago(over.days ?? 2),
  type: { id: 'fullTime', name: 'Full-Time' },
  location: {
    country: { name: 'France', id: 'FR' },
    state: { id: 'IDF', name: 'Île-de-France' },
    city: over.city ?? 'Paris',
    primary: true,
    is_remote: over.remote ?? false,
    name: `${over.city ?? 'Paris'}, IDF`,
  },
  department: null,
  salary: over.salary === undefined ? null : over.salary,
  company: { name: 'Acme', logo_url: null, friendly_id: 'acme' },
});
/** A position page: a Breezy page carries a WebSite block and a JobPosting block. */
const page = (name: string): string =>
  `<html><head><script type="application/ld+json">{"@context":"http://schema.org","@type":"WebSite","name":"Breezy HR"}</script>` +
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: name,
    description: `<p><strong>About</strong></p><p>Join us as ${name}. We use React and TypeScript.</p><ul><li>5 years of experience required.</li></ul>`,
  })}</script></head><body>...</body></html>`;

const postings = [
  listed('aaa000000001', 'senior-frontend-engineer', 'Senior Frontend Engineer', { days: 3, salary: '$90k - $110k / year' }),
  listed('aaa000000002', 'backend-engineer', 'Backend Engineer', { days: 9 }),
  listed('aaa000000003', 'fullstack-developer', 'Fullstack Developer', { days: 1, city: 'Lyon', remote: true }),
  listed('aaa000000004', 'office-manager', 'Office Manager', { days: 5 }),
];
const LIST = 'https://acme.breezy.hr/json';
const PAGE = (p: (typeof postings)[number]) => `https://acme.breezy.hr/p/${p.friendly_id}`;
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const routes = (): FakeHttpRoute[] => [route(LIST, postings), ...postings.map((p) => route(PAGE(p), page(p.name)))];
const context = (r: FakeHttpRoute[] = routes()) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'breezy', routes: r });
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
  samples: { breezy_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://${handle}.breezy.hr/json`;

  it('takes a subdomain', () => {
    expect(resolveBoard('rhynocare')).toEqual({ feedUrl: feed('rhynocare'), label: 'rhynocare' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: feed('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://rhynocare.breezy.hr', 'rhynocare'],
    ['https://rhynocare.breezy.hr/p/342b815596f0-dietary-aide', 'rhynocare'],
    ['https://rhynocare.breezy.hr/json', 'rhynocare'],
  ])('takes the subdomain from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://rhynocare.breezy.hr',
    'https://rhynocare.breezy.hr:8443',
    'https://user@rhynocare.breezy.hr',
    'https://rhynocare.breezy.hr.evil.example',
    'https://www.breezy.hr',
    'https://app.breezy.hr',
    'https://breezy.hr',
    'https://a.b.breezy.hr',
    'RhynoCare',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });
});

describe('the text of a position page', () => {
  it('comes from its JobPosting data, whatever the other blocks are', () => {
    expect(descriptionFromPage(page('Dev'))).toContain('Join us as Dev. We use React and TypeScript.');
  });

  it('is null for a page with no JobPosting block, or with a block that is not JSON', () => {
    expect(descriptionFromPage('<html></html>')).toBeNull();
    expect(descriptionFromPage('<script type="application/ld+json">{nope</script>')).toBeNull();
    expect(descriptionFromPage('<script type="application/ld+json">{"@type":"WebSite"}</script>')).toBeNull();
  });
});

describe('breezy_jobs', () => {
  it('lists the board, then reads the page of the positions that pass the filters only, newest first', async () => {
    const c = context();
    const result = await run(c.ctx, { title_any: ['engineer', 'developer'], detail: 'full' });
    expect(c.spent()).toBe(1 + 3); // the list, and the three titles that match: not the office manager
    expect(data(result).jobs.map((j) => j.id)).toEqual(['aaa000000003', 'aaa000000001', 'aaa000000002']);
    const first = data(result).jobs.find((j) => j.id === 'aaa000000001');
    expect(first).toMatchObject({
      source: 'breezy',
      board: 'acme',
      company: 'Acme',
      url: 'https://acme.breezy.hr/p/aaa000000001-senior-frontend-engineer',
      locations: ['Paris, Île-de-France, France'],
    });
    expect(first?.description).toContain('We use React and TypeScript.');
    expect(first?.description).toContain('5 years of experience required.');
    expect(first?.description).toContain('Salary: $90k - $110k / year');
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: LIST, status: 'ok', jobs_total: 4, relevant: 3 }]);
  });

  it('says so in the location when a position is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['aaa000000003']);
    expect(data(result).jobs[0]?.locations).toEqual(['Lyon, Île-de-France, France', 'Remote']);
  });

  it('reads no page for a position a disallowed word drops from the title', async () => {
    const c = context();
    await run(c.ctx, { disallowed_terms: ['manager'] });
    expect(c.http.requests.some((r) => r.url.includes('office-manager'))).toBe(false);
  });

  it('reads at most 40 pages per board and says how many more matched', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      listed(`bbb0000000${String(i).padStart(2, '0')}`, `role-${i}`, `Engineer ${i}`, { days: 2 }),
    );
    const c = context([route(LIST, many), ...many.map((p) => route(PAGE(p), page(p.name)))]);
    const result = await run(c.ctx, { max_results: 200 });
    expect(c.spent()).toBe(1 + 40);
    expect(result.warnings.join(' ')).toMatch(/5 more job\(s\) matched the filters but their text was not read/);
  });

  it('leaves out a position that closed since the list, and says so; a page with no data at all is a broken board', async () => {
    const closed = context([
      route(LIST, postings.slice(0, 2)),
      route(PAGE(postings[0] as never), page('A')),
      route(PAGE(postings[1] as never), 'gone', 404),
    ]);
    const result = await run(closed.ctx);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['aaa000000001']);
    expect(result.warnings.join(' ')).toMatch(/1 position\(s\) could not be read/);

    const broken = context([route(LIST, postings.slice(0, 1)), route(PAGE(postings[0] as never), '<html>new design</html>')]);
    const answer = await run(broken.ctx);
    expect(data(answer).boards[0]).toMatchObject({ status: 'not_this_ats' });
  });

  it('reports a board that does not exist, an error and an answer that is not a list, each on its own', async () => {
    const c = context([
      ...routes(),
      route('https://ghost.breezy.hr/json', '<html>404</html>', 404),
      route('https://down.breezy.hr/json', '', 503),
      route('https://odd.breezy.hr/json', { nope: 1 }),
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
    expect(tool.input.safeParse({ boards: ['a', 'b', 'c'] }).success).toBe(false); // two companies at most
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme '])).toEqual(['acme']);
    expect(keys(['https://acme.breezy.hr/p/1-x', 'Nope!'])).toEqual(['acme']);
  });

  it('gives every company a budget that covers a list and its pages, and reserves them in the call', () => {
    expect(adapter.keyRate).toEqual({ perHour: 120, perDay: 400 });
    expect(tool.limits.cost).toBe(2 * (1 + 40));
    expect(tool.limits.estimate?.(tool.input.parse({ boards: ['acme'] }))).toBe(1 + 20);
  });
});
