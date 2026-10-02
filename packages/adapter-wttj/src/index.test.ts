import { Checkpoint, SessionInvalid } from '@jobwatch/sdk';
import { createBrowserTestContext, describeAdapterContract, type FakePage } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import { CLICK_NEXT, EXTRACT_GATE, EXTRACT_JOB, EXTRACT_MATCHES, EXTRACT_PAGE_STATE, type ExtractedJob, type PageState } from './extract';
import adapter, { tools } from './index';
import { MATCHES_URL, jobId, jobUrl } from './parse';

const { matches, job, matchesAndRead } = tools;
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const frDate = (days: number): string => {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCDate()} ${FR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

interface Site {
  company: string;
  offer: string;
  title: string;
  name: string;
  days: number;
  description?: string;
  salary?: boolean;
  city?: string;
}

/** The lines of a card as the site shows them (checked live on 2026-10-02). */
const cardLines = (s: Site): string[] => [
  s.title,
  s.name,
  `${s.name}, tagline of the company.`,
  'CDI',
  'Télétravail fréquent',
  ...(s.salary ? ['60K à 75K € par an'] : []),
  s.city ?? 'Paris',
  '110 collaborateurs',
  'Conseil / Audit',
  'Enregistrer',
  'Pas pour moi',
  frDate(s.days),
];

const posting = (s: Site) => ({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: s.title,
  description: `<h4>Descriptif</h4><p>${s.description ?? `Rejoignez ${s.name}. React et TypeScript.`}</p><ul><li>5 ans d'expérience</li></ul>`,
  datePosted: ago(s.days),
  hiringOrganization: { '@type': 'Organization', name: s.name },
  jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: s.city ?? 'Paris' } }],
});

const SITES: Site[] = [
  { company: 'acme', offer: 'senior-frontend_paris', title: 'Senior Frontend Engineer', name: 'Acme', days: 1, salary: true },
  { company: 'beta', offer: 'angular-developer_paris', title: 'Développeur Angular', name: 'Beta', days: 2 },
  { company: 'gamma', offer: 'tech-lead_lyon', title: 'Tech Lead Frontend', name: 'Gamma', days: 20, city: 'Lyon' },
  { company: 'delta', offer: 'fullstack_paris', title: 'Fullstack Developer', name: 'Delta', days: 40, description: 'Angular et Node.js.' },
  { company: 'acme', offer: 'data-engineer_paris', title: 'Data Engineer', name: 'Acme', days: 3 },
];
const siteId = (s: Site): string => jobId({ company: s.company, offer: s.offer });
const [S1, S2, S3, S4, S5] = SITES as [Site, Site, Site, Site, Site];

interface Behaviour {
  /** Pages of the matches list (arrays of sites); the "Next Page" button walks them. */
  pages?: Site[][];
  total?: string;
  gate?: { path: string; loginForm: boolean; challenge: boolean };
  state?: PageState;
  job?: (s: Site) => Partial<ExtractedJob>;
  clicks?: string[];
  evaluated?: string[];
}

function site(b: Behaviour = {}) {
  const pages = b.pages ?? [SITES];
  let current = 0;
  const matchesPage: FakePage = {
    evaluate: (script) => {
      b.evaluated?.push(
        script === EXTRACT_MATCHES
          ? 'matches'
          : script === CLICK_NEXT
            ? 'click-next'
            : script === EXTRACT_GATE
              ? 'gate'
              : script === EXTRACT_PAGE_STATE
                ? 'state'
                : 'other',
      );
      if (script === EXTRACT_GATE) return b.gate ?? { path: '/fr/jobs-matches', loginForm: false, challenge: false };
      if (script === EXTRACT_PAGE_STATE)
        return b.state ?? { path: '/fr/jobs-matches', title: 'Jobs', loggedIn: true, loginForm: false, challenge: false };
      if (script === EXTRACT_MATCHES)
        return {
          cards: (pages[current] ?? []).map((s) => ({ href: `/fr/companies/${s.company}/jobs/${s.offer}`, lines: cardLines(s) })),
          tab: b.total ?? 'Nouveaux matchs 32',
          hasNext: current < pages.length - 1,
        };
      if (script === CLICK_NEXT) {
        b.clicks?.push('Next Page');
        if (current >= pages.length - 1) return { moved: false };
        current += 1;
        return { moved: true };
      }
      throw new Error('unexpected script on the matches page');
    },
  };
  const all: Record<string, FakePage> = { [MATCHES_URL]: matchesPage };
  for (const s of pages.flat()) {
    all[jobUrl({ company: s.company, offer: s.offer })] = {
      evaluate: () => ({
        path: `/fr/companies/${s.company}/jobs/${s.offer}`,
        title: `${s.title} - ${s.name} - CDI à Paris`,
        blocks: [JSON.stringify({ '@type': 'FAQPage' }), JSON.stringify(posting(s))],
        descriptionText: 'fallback text',
        closed: false,
        loggedIn: true,
        loginForm: false,
        challenge: false,
        ...b.job?.(s),
      }),
    };
  }
  return all;
}

const context = (b: Behaviour = {}) => createBrowserTestContext({ allowedHosts: adapter.allowedHosts, platform: 'wttj', pages: site(b) });
type Ctx = ReturnType<typeof context>['ctx'];
const runMatches = (ctx: Ctx, over: object = {}) => matches.handler(matches.input.parse(over), ctx);
const runJob = (ctx: Ctx, over: object = {}) =>
  job.handler(job.input.parse({ urls: [jobUrl({ company: S1.company, offer: S1.offer })], ...over }), ctx);
const runRead = (ctx: Ctx, over: object = {}) => matchesAndRead.handler(matchesAndRead.input.parse(over), ctx);

interface Out {
  jobs: {
    id: string;
    source: string;
    board: string | null;
    read_from: string;
    new: boolean;
    title: string;
    company: string | null;
    locations: string[];
    posted_at: string | null;
    salary_text: string | null;
    description: string;
    remote_hints: string[];
  }[];
  cards: { id: string; known: boolean; posted_at: string | null; contract: string | null; location: string | null }[];
  excluded: { id: string; reason: string; term: string }[];
  known_ids: string[];
  remaining_ids: string[];
  not_returned_ids: string[];
  failed: { id: string; status: string }[];
  total_matches: number | null;
  pages_loaded: number;
  scanned: number;
}
const out = (r: { data: unknown }) => r.data as Out;
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    wttj_matches: { args: {}, run: (args) => matches.handler(args, context().ctx) },
    wttj_job: { args: { urls: [jobUrl({ company: S1.company, offer: S1.offer })] }, run: (args) => job.handler(args, context().ctx) },
    wttj_matches_and_read: { args: {}, run: (args) => matchesAndRead.handler(args, context().ctx) },
  },
});

describe('wttj_matches', () => {
  it('lists the cards of the first page, with the date, contract, city and the announced total, reading no job page', async () => {
    const c = context();
    const result = await runMatches(c.ctx);
    expect(ids(out(result).cards)).toEqual(SITES.map(siteId));
    expect(out(result).cards[0]).toMatchObject({ contract: 'CDI', location: 'Paris', known: false });
    expect(out(result).cards[0]?.posted_at).not.toBeNull();
    expect(out(result)).toMatchObject({ total_matches: 32, pages_loaded: 1 });
    expect(c.session.visited).toEqual([MATCHES_URL]);
    expect(c.spent()).toBe(1);
  });

  it('walks the pages with the Next Page button only, and stops at the last page or at max_results', async () => {
    const clicks: string[] = [];
    const pages = [[S1, S2], [S3, S4], [S5]];
    const all = await runMatches(context({ pages, clicks }).ctx, { max_results: 50 });
    expect(ids(out(all).cards)).toEqual(SITES.map(siteId));
    expect(out(all).pages_loaded).toBe(3);
    expect(clicks).toEqual(['Next Page', 'Next Page']);
    const clicksTwo: string[] = [];
    const some = await runMatches(context({ pages, clicks: clicksTwo }).ctx, { max_results: 3 });
    expect(out(some).cards).toHaveLength(3);
    expect(out(some).pages_loaded).toBe(2);
    expect(clicksTwo).toEqual(['Next Page']);
  });

  it('filters by the card date', async () => {
    expect(ids(out(await runMatches(context().ctx, { posted_within: 'past_week' })).cards)).toEqual([S1, S2, S5].map(siteId));
    expect(ids(out(await runMatches(context().ctx, { posted_within: 'past_month' })).cards)).toEqual([S1, S2, S3, S5].map(siteId));
  });

  it('flags stored jobs and refreshes their last_seen, even those a date filter hides', async () => {
    const c = context();
    await c.jobs.put({
      id: siteId(S4),
      board: 'delta',
      title: 'x',
      company: 'Delta',
      location: null,
      url: 'https://x.test',
      description: 'd',
    });
    const stored = c.jobs.jobs.get(siteId(S4));
    if (stored === undefined) throw new Error('not stored');
    c.jobs.jobs.set(siteId(S4), { ...stored, lastSeen: '2026-01-01T00:00:00.000Z' });
    const result = await runMatches(c.ctx, { posted_within: 'past_week' });
    expect(out(result).cards.some((card) => card.known)).toBe(false); // S4 is 40 days old: filtered out of the answer
    expect(c.jobs.jobs.get(siteId(S4))?.lastSeen).not.toBe('2026-01-01T00:00:00.000Z'); // ...but it was seen
  });

  it('says so when the first page has no cards and the tab does not announce zero', async () => {
    const result = await runMatches(context({ pages: [[]], total: 'Nouveaux matchs 12' }).ctx);
    expect(out(result).cards).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/layout may have changed/);
    expect(out(await runMatches(context({ pages: [[]], total: 'Nouveaux matchs 0' }).ctx)).cards).toEqual([]);
  });
});

describe('sign-in and bot checks', () => {
  it('raises needs_login when the site sends us to a sign-in page, before reading anything', async () => {
    await expect(runMatches(context({ gate: { path: '/fr/signin', loginForm: true, challenge: false } }).ctx)).rejects.toBeInstanceOf(
      SessionInvalid,
    );
    await expect(runMatches(context({ gate: { path: '/fr/login', loginForm: false, challenge: false } }).ctx)).rejects.toBeInstanceOf(
      SessionInvalid,
    );
  });

  it('raises a checkpoint when a verification shows, and does not click on', async () => {
    const clicks: string[] = [];
    await expect(
      runMatches(context({ gate: { path: '/fr/jobs-matches', loginForm: false, challenge: true }, clicks }).ctx),
    ).rejects.toBeInstanceOf(Checkpoint);
    expect(clicks).toEqual([]);
  });

  it('applies the same checks to a job page', async () => {
    await expect(runJob(context({ job: () => ({ path: '/fr/signin', loginForm: true }) }).ctx)).rejects.toBeInstanceOf(SessionInvalid);
    await expect(runJob(context({ job: () => ({ challenge: true }) }).ctx)).rejects.toBeInstanceOf(Checkpoint);
  });

  it('reports the session state', async () => {
    const check = adapter.sessionCheck;
    if (check === undefined) throw new Error('no sessionCheck');
    const state = (s: Partial<PageState>) =>
      check(
        context({ state: { path: '/fr/jobs-matches', title: 'x', loggedIn: false, loginForm: false, challenge: false, ...s } }).session,
      );
    expect((await state({ loggedIn: true })).state).toBe('ok');
    expect((await state({ path: '/fr/signin', loginForm: true })).state).toBe('needs_login');
    expect((await state({ challenge: true })).state).toBe('checkpoint');
    expect((await state({})).state).toBe('unknown');
  });
});

describe('wttj_job', () => {
  it('reads the JobPosting, stores the job under its company, and returns it truncated', async () => {
    const c = context();
    const result = await runJob(c.ctx, { description_max_chars: 500 });
    expect(out(result).jobs[0]).toMatchObject({
      id: siteId(S1),
      source: 'wttj',
      board: 'acme',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      read_from: 'fetched',
      new: true,
      locations: ['Paris'],
    });
    const text = out(result).jobs[0]?.description ?? '';
    expect(text).toContain('React et TypeScript.');
    expect(text).toContain("- 5 ans d'expérience");
    expect(text).not.toContain('<');
    expect(c.jobs.jobs.get(siteId(S1))).toMatchObject({ source: 'wttj', board: 'acme', location: 'Paris' });
    expect(c.spent()).toBe(1);
  });

  it('answers a stored job from the database without opening the site', async () => {
    const c = context();
    await runJob(c.ctx);
    c.session.visited.length = 0;
    const spentBefore = c.spent();
    const again = await runJob(c.ctx);
    expect(out(again).jobs[0]).toMatchObject({ read_from: 'stored', new: false, board: 'acme' });
    expect(c.session.visited).toEqual([]);
    expect(c.spent() - spentBefore).toBe(0); // a stored job costs nothing
  });

  it('falls back to the visible description when the page has no JobPosting, and reports a gone or empty job', async () => {
    const fallback = await runJob(context({ job: () => ({ blocks: [] }) }).ctx);
    expect(out(fallback).jobs[0]?.description).toBe('fallback text');
    const c = context({ job: () => ({ blocks: [], descriptionText: '', closed: true }) });
    const gone = await runJob(c.ctx);
    expect(out(gone).failed).toEqual([{ id: siteId(S1), status: 'closed' }]);
    const empty = await runJob(context({ job: () => ({ blocks: [], descriptionText: '' }) }).ctx);
    expect(out(empty).failed).toEqual([{ id: siteId(S1), status: 'not_loaded' }]);
    expect(c.jobs.jobs.size).toBe(0);
  });

  it('stores before judging', async () => {
    const c = context();
    const result = await runJob(c.ctx, {
      urls: [jobUrl({ company: S4.company, offer: S4.offer })],
      disallowed_terms: ['angular'],
      disallowed_scope: 'title_then_description',
    });
    expect(out(result).excluded).toEqual([{ id: siteId(S4), title: 'Fullstack Developer', reason: 'description', term: 'angular' }]);
    expect(c.jobs.jobs.has(siteId(S4))).toBe(true);
  });

  it('only accepts job URLs of the site', () => {
    for (const bad of [
      [],
      ['https://evil.example/fr/companies/acme/jobs/x'],
      ['http://www.welcometothejungle.com/fr/companies/acme/jobs/x'],
      ['https://www.welcometothejungle.com/fr/jobs-matches'],
      ['https://www.welcometothejungle.com/fr/companies/acme/jobs/x?next=/fr/signin'],
      Array.from({ length: 26 }, () => jobUrl({ company: 'acme', offer: 'x' })),
    ]) {
      expect(job.input.safeParse({ urls: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('wttj_matches_and_read', () => {
  it('scans, drops excluded titles without reading them, reads and stores the rest under their company', async () => {
    const evaluated: string[] = [];
    const c = context({ evaluated });
    const result = await runRead(c.ctx, { max_results: 10, disallowed_terms: ['angular', 'fullstack'] });
    expect(out(result).excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      [siteId(S2), 'title', 'angular'],
      [siteId(S4), 'title', 'fullstack'],
    ]);
    expect(c.jobs.jobs.has(siteId(S4))).toBe(false);
    expect(ids(out(result).jobs)).toEqual([S1, S3, S5].map(siteId));
    expect(out(result).jobs.map((j) => j.board)).toEqual(['acme', 'gamma', 'acme']);
    expect(out(result).jobs[0]).toMatchObject({ source: 'wttj', read_from: 'fetched', salary_text: '60K à 75K € par an' });
    expect(out(result).jobs[0]?.posted_at).not.toBeNull();
    expect(out(result).jobs[0]?.remote_hints).toContain('télétravail fréquent');
    expect(c.jobs.jobs.has(siteId(S2))).toBe(false);
    expect(c.spent()).toBe(1 + 3); // one matches page, three jobs
  });

  it('never reads a stored job again and judges it with the terms of this call', async () => {
    const c = context();
    await runRead(c.ctx);
    c.session.visited.length = 0;
    const again = await runRead(c.ctx, { disallowed_terms: ['frontend'] });
    expect(c.session.visited).toEqual([MATCHES_URL]);
    expect(out(again).excluded.map((e) => e.id)).toEqual([S1, S3].map(siteId));
    expect(out(again).jobs.every((j) => j.read_from === 'stored')).toBe(true);
  });

  it('is resumable: max_jobs stops early and the next call carries on', async () => {
    const c = context();
    const first = await runRead(c.ctx, { max_jobs: 3 });
    expect(out(first).jobs).toHaveLength(3);
    expect(out(first).remaining_ids).toHaveLength(2);
    expect(first.warnings.join(' ')).toMatch(/call again/);
    const second = await runRead(c.ctx, { max_jobs: 3 });
    expect(out(second).remaining_ids).toEqual([]);
    expect(out(second).jobs.filter((j) => j.read_from === 'fetched')).toHaveLength(2);
  });

  it('honours skip_ids, max_jobs=0, stored_jobs=skip and max_results as the cap', async () => {
    const c = context();
    const classify = await runRead(c.ctx, { max_jobs: 0, skip_ids: [siteId(S1)] });
    expect(out(classify).known_ids).toEqual([siteId(S1)]);
    expect(out(classify).remaining_ids).toHaveLength(4);
    await runRead(c.ctx);
    expect(out(await runRead(c.ctx, { stored_jobs: 'skip' })).known_ids).toHaveLength(5);
    const capped = await runRead(context().ctx, { max_results: 2 });
    expect(out(capped).scanned).toBe(2);
    expect(out(capped).jobs).toHaveLength(2);
  });

  it('applies the date range to the cards before reading', async () => {
    const result = await runRead(context().ctx, { posted_within: 'past_week' });
    expect(ids(out(result).jobs)).toEqual([S1, S2, S5].map(siteId));
    expect(out(result).scanned).toBe(3);
  });

  it('rejects out-of-range arguments', () => {
    for (const bad of [
      { max_results: 0 },
      { max_results: 51 },
      { max_jobs: 51 },
      { max_returned: 5 },
      { detail: 'everything' },
      { posted_within: '24h' },
      { skip_ids: ['a b'] },
      { stored_jobs: 'maybe' },
      { extra: 1 },
    ]) {
      expect(matchesAndRead.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('what the adapter does on the site', () => {
  it('presses only "Next Page": no script clicks anything else, and nothing else is clicked at all', () => {
    for (const [name, script] of Object.entries({ EXTRACT_PAGE_STATE, EXTRACT_GATE, EXTRACT_MATCHES, EXTRACT_JOB }))
      expect(script, name).not.toMatch(/\.click\(|dispatchEvent|submit\(/);
    expect(CLICK_NEXT.match(/\.click\(/g)).toHaveLength(1);
    expect(CLICK_NEXT).toMatch(/\^next page\$/i);
    // none of the buttons that change the account is ever named in a script that acts
    expect(CLICK_NEXT).not.toMatch(/Enregistrer|Pas pour moi|Postuler|apply|bookmark/i);
  });

  it('is a browser adapter on www.welcometothejungle.com only, with a strict budget', () => {
    expect(adapter.kind).toBe('browser');
    expect(adapter.allowedHosts).toEqual(['www.welcometothejungle.com']);
    expect(adapter.rate).toEqual({ perHour: 60, perDay: 200 });
  });

  it('never leaves the matches and job pages: only those URLs are visited', async () => {
    const c = context();
    await runRead(c.ctx);
    for (const url of c.session.visited)
      expect(
        url === MATCHES_URL || /^https:\/\/www\.welcometothejungle\.com\/fr\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9_-]+$/.test(url),
      ).toBe(true);
  });
});
