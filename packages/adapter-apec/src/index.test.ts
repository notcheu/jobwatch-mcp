import { Checkpoint, SessionInvalid } from '@jobwatch/sdk';
import { createBrowserTestContext, describeAdapterContract, type FakePage } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter, { tools } from './index';
import type { EndpointAnswer, PageState } from './extract';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Shaped like Apec's search results (checked live on 2026-10-02). */
const offer = (
  n: number,
  title: string,
  over: { days?: number; company?: string; place?: string; salary?: string; code?: number } = {},
) => ({
  id: 179_000_000 + n,
  numeroOffre: `${179_000_000 + n}W`,
  intitule: title,
  nomCommercial: over.company ?? 'ACME',
  lieuTexte: over.place ?? 'Paris 17 - 75',
  salaireTexte: over.salary ?? 'A négocier',
  texteOffre: `Snippet of ${title}`,
  datePublication: ago(over.days ?? 1),
  typeContrat: over.code ?? 101888,
});

const offers = [
  offer(1, 'Senior Frontend Engineer', { days: 1, salary: '70 - 85 k€ brut annuel' }),
  offer(2, 'Développeur Angular', { days: 3 }),
  offer(3, 'Tech Lead Frontend', { days: 20, company: 'BETA' }),
  offer(4, 'Fullstack Developer', { days: 40 }),
];
const [O1, O2, O3, O4] = offers.map((o) => o.numeroOffre) as [string, string, string, string];

const detail = (n: number, text = 'Vous rejoignez une équipe React et TypeScript.') => ({
  numeroOffre: `${179_000_000 + n}W`,
  intitule: offers[n - 1]?.intitule ?? 'x',
  nomCommercialEtablissement: 'ACME',
  texteHtml: `<p>${text}</p><ul><li>5 ans d'expérience</li></ul>`,
  texteHtmlProfil: '<p>Maîtrise de TypeScript.</p>',
  texteHtmlEntreprise: '<p>ACME, 200 personnes.</p>',
});

interface Behaviour {
  state?: PageState;
  /** Answer for a search; receives the body. */
  search?: (body: { pagination: { startIndex: number; range: number }; typesContrat?: string[]; lieux: string[] }) => EndpointAnswer;
  offer?: (id: string) => EndpointAnswer;
  calls?: { kind: string; arg: unknown }[];
}

function page(b: Behaviour = {}): FakePage {
  return {
    evaluate: (script, arg) => {
      const call = arg as { kind?: 'search' | 'offer'; body?: unknown; id?: string } | undefined;
      if (call?.kind === 'search') {
        b.calls?.push({ kind: 'search', arg });
        const body = call.body as Parameters<NonNullable<Behaviour['search']>>[0];
        return (
          b.search?.(body) ?? {
            status: 200,
            blocked: false,
            json: {
              totalCount: offers.length,
              resultats: offers.slice(body.pagination.startIndex, body.pagination.startIndex + body.pagination.range),
            },
          }
        );
      }
      if (call?.kind === 'offer') {
        b.calls?.push({ kind: 'offer', arg });
        const id = call.id ?? '';
        return b.offer?.(id) ?? { status: 200, blocked: false, json: detail(Number(id.slice(0, -1)) - 179_000_000) };
      }
      return b.state ?? { challenge: false, title: 'Apec', hasApp: true };
    },
  };
}

const context = (b: Behaviour = {}) =>
  createBrowserTestContext({ allowedHosts: adapter.allowedHosts, platform: 'apec', pages: { 'https://www.apec.fr/': page(b) } });
const { search, job } = tools;
type Ctx = ReturnType<typeof context>['ctx'];
/** A plain listing: max_jobs=0 reads no offer. */
const runSearch = (ctx: Ctx, over: object = {}) => search.handler(search.input.parse({ keywords: 'frontend', max_jobs: 0, ...over }), ctx);
const runJob = (ctx: Ctx, over: object = {}) => job.handler(job.input.parse({ ids: [O1], ...over }), ctx);
const runRead = (ctx: Ctx, over: object = {}) => search.handler(search.input.parse({ keywords: 'frontend', ...over }), ctx);
interface Out {
  jobs: {
    id: string;
    source: string;
    board: null;
    read_from: string;
    new: boolean;
    title: string;
    salary_text: string | null;
    posted_at: string | null;
    description: string;
    summary: string;
    summary_kind: string | null;
    locations: string[];
  }[];
  cards: { id: string; known: boolean; posted_at: string | null }[];
  excluded: { id: string; reason: string; term: string }[];
  known_ids: string[];
  remaining_ids: string[];
  not_returned_ids: string[];
  failed: { id: string; status: string }[];
  total: number;
  pages_loaded: number;
  scanned: number;
}
const out = (result: { data: unknown }) => result.data as Out;
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    apec_job: { args: { ids: [O1] }, run: (args) => job.handler(args, context().ctx) },
    apec_search: { args: { keywords: 'frontend' }, run: (args) => search.handler(args, context().ctx) },
  },
});

describe('apec_search with max_jobs=0 (listing)', () => {
  it('lists cards newest first with the card salary and date, flags stored ones, and reads no offer', async () => {
    const calls: Behaviour['calls'] = [];
    const c = context({ calls });
    await c.jobs.put({
      id: O2,
      title: 'Développeur Angular',
      company: 'ACME',
      location: null,
      url: 'https://x.test',
      description: 'stored',
    });
    const result = await runSearch(c.ctx);
    expect(ids(out(result).cards)).toEqual([O1, O2, O3, O4]);
    expect(out(result).cards.map((card) => card.known)).toEqual([false, true, false, false]);
    expect(out(result).cards[0]).toMatchObject({
      company: 'ACME',
      location: 'Paris 17 - 75',
      salary_text: '70 - 85 k€ brut annuel',
      contract_code: 101888,
    });
    expect(out(result)).toMatchObject({ total: 4, pages_loaded: 1 });
    expect(calls.map((x) => x.kind)).toEqual(['search']);
    expect(c.spent()).toBe(2); // the page + one search page
  });

  it('sends the filters Apec understands, and nothing the caller did not ask for', async () => {
    const calls: Behaviour['calls'] = [];
    await runSearch(context({ calls }).ctx, { departments: ['75', '92'], cdi_only: true, min_salary_k: 70 });
    const body = (calls[0]?.arg as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      motsCles: 'frontend',
      lieux: ['75', '92'],
      typesContrat: ['101888'],
      salaireMinimum: '70',
      typeClient: 'CADRE',
    });
    const plain: Behaviour['calls'] = [];
    await runSearch(context({ calls: plain }).ctx);
    const plainBody = (plain[0]?.arg as { body: Record<string, unknown> }).body;
    expect(plainBody).not.toHaveProperty('typesContrat');
    expect(plainBody).not.toHaveProperty('salaireMinimum');
    expect(plainBody).toMatchObject({ lieux: ['75'], sorts: [{ type: 'DATE', direction: 'DESCENDING' }] });
  });

  it('stops at the date range: results are newest first, so the first old one ends the search', async () => {
    const result = await runSearch(context().ctx, { posted_within: 'past_week' });
    expect(ids(out(result).cards)).toEqual([O1, O2]);
    expect(ids(out(await runSearch(context().ctx, { posted_within: 'past_month' })).cards)).toEqual([O1, O2, O3]);
  });

  it('loads several pages for more results, 20 at a time, and stops at the end', async () => {
    const many = Array.from({ length: 45 }, (_, i) => offer(100 + i, `Engineer ${i}`));
    const calls: Behaviour['calls'] = [];
    const c = context({
      calls,
      search: (body) => ({
        status: 200,
        blocked: false,
        json: {
          totalCount: many.length,
          resultats: many.slice(body.pagination.startIndex, body.pagination.startIndex + body.pagination.range),
        },
      }),
    });
    const result = await runSearch(c.ctx, { max_results: 100 });
    expect(out(result).cards).toHaveLength(45);
    expect(out(result).pages_loaded).toBe(3);
    expect(calls.map((x) => (x.arg as { body: { pagination: { startIndex: number } } }).body.pagination.startIndex)).toEqual([0, 20, 40]);
    const few = await runSearch(
      context({
        search: (body) => ({
          status: 200,
          blocked: false,
          json: {
            totalCount: many.length,
            resultats: many.slice(body.pagination.startIndex, body.pagination.startIndex + body.pagination.range),
          },
        }),
      }).ctx,
      { max_results: 25 },
    );
    expect(out(few).cards).toHaveLength(25);
  });

  it('refreshes last_seen of stored offers it lists', async () => {
    const c = context();
    await c.jobs.put({ id: O1, title: 'x', company: 'ACME', location: null, url: 'https://x.test', description: 'd' });
    const stored = c.jobs.jobs.get(O1);
    if (stored === undefined) throw new Error('not stored');
    c.jobs.jobs.set(O1, { ...stored, lastSeen: '2026-01-01T00:00:00.000Z' });
    await runSearch(c.ctx);
    expect(c.jobs.jobs.get(O1)?.lastSeen).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('bot protection', () => {
  const blocked: EndpointAnswer = { status: 403, json: null, blocked: true };

  it('stops with a checkpoint when a verification shows on the page, before asking for anything', async () => {
    const calls: Behaviour['calls'] = [];
    const c = context({ state: { challenge: true, title: 'apec.fr', hasApp: false }, calls });
    await expect(runSearch(c.ctx)).rejects.toBeInstanceOf(Checkpoint);
    expect(calls).toEqual([]);
  });

  it('stops with a checkpoint when an endpoint answers with the challenge, and never retries it itself', async () => {
    await expect(runSearch(context({ search: () => blocked }).ctx)).rejects.toBeInstanceOf(Checkpoint);
    await expect(runJob(context({ offer: () => blocked }).ctx)).rejects.toBeInstanceOf(Checkpoint);
  });

  it('is not a login problem: no SessionInvalid', async () => {
    await expect(runSearch(context({ search: () => blocked }).ctx)).rejects.not.toBeInstanceOf(SessionInvalid);
  });

  it('reports the session state: ok, or checkpoint while the challenge shows', async () => {
    const check = adapter.sessionCheck;
    if (check === undefined) throw new Error('no sessionCheck');
    const state = (s: PageState) => check(context({ state: s }).session);
    expect((await state({ challenge: false, title: 'Apec', hasApp: true })).state).toBe('ok');
    expect((await state({ challenge: true, title: 'apec.fr', hasApp: false })).state).toBe('checkpoint');
    expect((await state({ challenge: false, title: 'x', hasApp: false })).state).toBe('unknown');
  });
});

describe('apec_job', () => {
  it('reads the full text from the offer, stores it, and returns it truncated', async () => {
    const c = context();
    const result = await runJob(c.ctx, { description_max_chars: 500 });
    expect(out(result).jobs[0]).toMatchObject({
      id: O1,
      source: 'apec',
      board: null,
      read_from: 'fetched',
      new: true,
      title: 'Senior Frontend Engineer',
    });
    const text = out(result).jobs[0]?.description ?? '';
    expect(text).toContain('React et TypeScript');
    expect(text).toContain('Profil recherché');
    expect(text).toContain('Entreprise');
    expect(text).not.toContain('<');
    expect(c.jobs.jobs.get(O1)).toMatchObject({ source: 'apec', board: null });
    expect(c.spent()).toBe(2); // the page + one offer
  });

  it('answers a stored offer from the database without opening Apec at all', async () => {
    const c = context();
    await runJob(c.ctx);
    c.session.visited.length = 0;
    const spentBefore = c.spent();
    const again = await runJob(c.ctx);
    expect(out(again).jobs[0]).toMatchObject({ read_from: 'stored', new: false });
    expect(c.session.visited).toEqual([]);
    expect(c.spent() - spentBefore).toBe(0); // a stored offer costs nothing
  });

  it('reports an offer that is gone or empty, and does not store it', async () => {
    const c = context({
      offer: (id) => (id === O1 ? { status: 404, json: null, blocked: false } : { status: 200, json: { numeroOffre: id }, blocked: false }),
    });
    const result = await runJob(c.ctx, { ids: [O1, O2] });
    expect(out(result).failed).toEqual([
      { id: O1, status: 'closed' },
      { id: O2, status: 'not_loaded' },
    ]);
    expect(c.jobs.jobs.size).toBe(0);
  });

  it('stores before judging: a description match is excluded but kept, a title match is neither', async () => {
    const c = context({
      offer: (id) => ({ status: 200, blocked: false, json: detail(Number(id.slice(0, -1)) - 179_000_000, 'Stack Angular et Node.') }),
    });
    const byDescription = await runJob(c.ctx, { ids: [O1], disallowed_terms: ['angular'], disallowed_scope: 'title_then_description' });
    expect(out(byDescription).excluded).toEqual([{ id: O1, title: 'Senior Frontend Engineer', reason: 'description', term: 'angular' }]);
    expect(c.jobs.jobs.has(O1)).toBe(true);
    const byTitle = await runJob(c.ctx, { ids: [O2], disallowed_terms: ['angular'] });
    expect(out(byTitle).excluded[0]).toMatchObject({ id: O2, reason: 'title' });
    expect(c.jobs.jobs.has(O2)).toBe(false);
  });

  it('rejects malformed offer numbers', () => {
    for (const bad of [[], ['abc'], ['179519481W; drop'], ['../x'], Array.from({ length: 26 }, () => O1)]) {
      expect(job.input.safeParse({ ids: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('apec_search with several keywords', () => {
  const sent = (calls: Behaviour['calls']): string[] =>
    (calls ?? []).filter((x) => x.kind === 'search').map((x) => String((x.arg as { body: { motsCles: string } }).body.motsCles));

  it('searches each keyword on its own (Apec has no OR), once each, and lists an offer found twice once', async () => {
    const calls: Behaviour['calls'] = [];
    const result = await runSearch(context({ calls }).ctx, { keywords: ['react', 'vue'] });
    expect(sent(calls)).toEqual(['react', 'vue']);
    const ids = out(result).cards.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length); // the same four offers came back for both keywords
    expect(out(result)).toMatchObject({ scanned: ids.length, pages_loaded: 2 });
  });

  it('splits one string with a pipe into the list, and keeps a single keyword as it was', async () => {
    const calls: Behaviour['calls'] = [];
    await runSearch(context({ calls }).ctx, { keywords: 'react | vue |  react' });
    expect(sent(calls)).toEqual(['react', 'vue']); // split, trimmed, no duplicate
    const one: Behaviour['calls'] = [];
    await runSearch(context({ calls: one }).ctx, { keywords: 'développeur react' });
    expect(sent(one)).toEqual(['développeur react']); // a phrase without the separator is one keyword
  });

  it('records the list, in the order given, and reserves the search pages of every keyword', () => {
    const args = search.input.parse({ keywords: ['a', 'b', 'c'], max_results: 40 });
    expect(args.keywords).toEqual(['a', 'b', 'c']);
    expect(search.limits.estimate?.(args)).toBe(1 + 2 * 3 + 40); // the page, 2 pages for each of 3 keywords, and the offers it may read
  });

  it('refuses more than five keywords: each is a search of its own', () => {
    expect(search.input.safeParse({ keywords: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(true);
    expect(search.input.safeParse({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
  });
});

describe('apec_search (read)', () => {
  it('records the keywords and the offers the search listed', async () => {
    const c = context();
    await runRead(c.ctx, { keywords: 'react engineer' });
    expect(c.jobs.searches).toHaveLength(1);
    expect(c.jobs.searches[0]?.keywords).toEqual(['react engineer']);
    expect(c.jobs.searches[0]?.disallowed).toEqual([]);
    expect(c.jobs.searches[0]?.found.length).toBeGreaterThan(0);
  });

  it('returns no cards while it reads offers: the cards are for max_jobs=0', async () => {
    const result = await runRead(context().ctx);
    expect(result.data.cards).toEqual([]);
    expect(result.data.jobs.length).toBeGreaterThan(0);
  });

  it('scans, drops excluded titles without reading them, reads and stores the rest', async () => {
    const calls: Behaviour['calls'] = [];
    const c = context({ calls });
    const result = await runRead(c.ctx, { disallowed_terms: ['angular', 'fullstack'] });
    expect(out(result).excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      [O2, 'title', 'angular'],
      [O4, 'title', 'fullstack'],
    ]);
    expect(ids(out(result).jobs)).toEqual([O1, O3]);
    expect(calls.filter((x) => x.kind === 'offer')).toHaveLength(2);
    expect([...c.jobs.jobs.keys()].sort()).toEqual([O1, O3]);
    expect(out(result).jobs[0]).toMatchObject({ source: 'apec', board: null, read_from: 'fetched', salary_text: '70 - 85 k€ brut annuel' });
    expect(out(result).jobs[0]?.posted_at).not.toBeNull();
    expect(c.spent()).toBe(1 + 1 + 2); // the page, one search page, two offers
  });

  it('never reads a stored offer again, and judges it with the terms of this call', async () => {
    const calls: Behaviour['calls'] = [];
    const c = context({ calls });
    await runRead(c.ctx);
    calls.length = 0;
    const again = await runRead(c.ctx, { disallowed_terms: ['frontend'] });
    expect(calls.filter((x) => x.kind === 'offer')).toEqual([]);
    expect(out(again).excluded.map((e) => e.id)).toEqual([O1, O3]);
    expect(ids(out(again).jobs)).toEqual([O2, O4]);
    expect(out(again).jobs.every((j) => j.read_from === 'stored')).toBe(true);
  });

  it('is resumable: max_jobs stops early and the next call carries on', async () => {
    const c = context();
    const first = await runRead(c.ctx, { max_jobs: 3 });
    expect(out(first).jobs).toHaveLength(3);
    expect(out(first).remaining_ids).toEqual([O4]);
    expect(first.warnings.join(' ')).toMatch(/call again/);
    const second = await runRead(c.ctx, { max_jobs: 3 });
    expect(out(second).remaining_ids).toEqual([]);
    expect(
      out(second)
        .jobs.filter((j) => j.read_from === 'fetched')
        .map((j) => j.id),
    ).toEqual([O4]);
  });

  it('max_jobs=0 only classifies; skip_ids are left alone; stored_jobs=skip lists stored ones as known', async () => {
    const calls: Behaviour['calls'] = [];
    const c = context({ calls });
    const classify = await runRead(c.ctx, { max_jobs: 0, skip_ids: [O1] });
    expect(out(classify).known_ids).toEqual([O1]);
    expect(out(classify).remaining_ids).toEqual([O2, O3, O4]);
    expect(calls.filter((x) => x.kind === 'offer')).toEqual([]);
    await runRead(c.ctx);
    const onlyNew = await runRead(c.ctx, { stored_jobs: 'skip' });
    expect(out(onlyNew).known_ids).toEqual([O1, O2, O3, O4]);
    expect(out(onlyNew).jobs).toEqual([]);
  });

  it('max_results caps what is examined and therefore what is shown: ask for 2 and see at most 2', async () => {
    const result = await runRead(context().ctx, { max_results: 2 });
    expect(out(result).scanned).toBe(2);
    expect(out(result).jobs).toHaveLength(2);
    expect(out(result).remaining_ids).toEqual([]);
  });

  it('returns a summary by default and the text only when asked, and a job is stored whole either way', async () => {
    const c = context();
    const brief = await runRead(c.ctx, { max_results: 1 });
    expect(out(brief).jobs[0]).toMatchObject({ description: '', summary_kind: 'sections' });
    expect(out(brief).jobs[0]?.summary).toContain('Requirements: Maîtrise de TypeScript');
    expect((c.jobs.jobs.get(O1)?.description.length ?? 0) > (out(brief).jobs[0]?.summary.length ?? 0)).toBe(true);
    const full = await runRead(c.ctx, { max_results: 1, detail: 'full' });
    expect(out(full).jobs[0]?.description).toContain('React et TypeScript');
    expect(out(full).jobs[0]?.summary).toBe('');
  });

  it('rejects out-of-range arguments', () => {
    for (const bad of [
      { keywords: '' },
      { keywords: 'x', departments: [] },
      { keywords: 'x', departments: ['Paris'] },
      { keywords: 'x', max_jobs: 51 },
      { keywords: 'x', max_returned: 5 },
      { keywords: 'x', detail: 'everything' },
      { keywords: 'x', max_results: 101 },
      { keywords: 'x', min_salary_k: -1 },
      { keywords: 'x', posted_within: '24h' },
    ]) {
      expect(search.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('what the adapter reaches', () => {
  it('is a browser adapter on www.apec.fr only, with its own budget', () => {
    expect(adapter.kind).toBe('browser');
    expect(adapter.allowedHosts).toEqual(['www.apec.fr']);
  });
});
