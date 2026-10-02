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
const { search, job, searchAndRead } = tools;
type Ctx = ReturnType<typeof context>['ctx'];
const runSearch = (ctx: Ctx, over: object = {}) => search.handler(search.input.parse({ keywords: 'frontend', ...over }), ctx);
const runJob = (ctx: Ctx, over: object = {}) => job.handler(job.input.parse({ ids: [O1], ...over }), ctx);
const runRead = (ctx: Ctx, over: object = {}) => searchAndRead.handler(searchAndRead.input.parse({ keywords: 'frontend', ...over }), ctx);
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
    apec_search: { args: { keywords: 'frontend' }, run: (args) => search.handler(args, context().ctx) },
    apec_job: { args: { ids: [O1] }, run: (args) => job.handler(args, context().ctx) },
    apec_search_and_read: { args: { keywords: 'frontend' }, run: (args) => searchAndRead.handler(args, context().ctx) },
  },
});

describe('apec_search', () => {
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
    expect(result.cost).toBe(2); // the page + one search page
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
    expect(result.cost).toBe(2); // the page + one offer
  });

  it('answers a stored offer from the database without opening Apec at all', async () => {
    const c = context();
    await runJob(c.ctx);
    c.session.visited.length = 0;
    const again = await runJob(c.ctx);
    expect(out(again).jobs[0]).toMatchObject({ read_from: 'stored', new: false });
    expect(c.session.visited).toEqual([]);
    expect(again.cost).toBe(0);
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

describe('apec_search_and_read', () => {
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
    expect(result.cost).toBe(1 + 1 + 2); // the page, one search page, two offers
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

  it('caps the answer with max_returned and names the rest', async () => {
    const result = await runRead(context().ctx, { max_returned: 2 });
    expect(out(result).jobs).toHaveLength(2);
    expect(out(result).not_returned_ids).toHaveLength(2);
    expect(result.warnings.join(' ')).toMatch(/apec_job/);
  });

  it('rejects out-of-range arguments', () => {
    for (const bad of [
      { keywords: '' },
      { keywords: 'x', departments: [] },
      { keywords: 'x', departments: ['Paris'] },
      { keywords: 'x', max_jobs: 26 },
      { keywords: 'x', max_results: 101 },
      { keywords: 'x', min_salary_k: -1 },
      { keywords: 'x', posted_within: '24h' },
    ]) {
      expect(searchAndRead.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('what the adapter reaches', () => {
  it('is a browser adapter on www.apec.fr only, with its own budget', () => {
    expect(adapter.kind).toBe('browser');
    expect(adapter.allowedHosts).toEqual(['www.apec.fr']);
    expect(adapter.rate).toEqual({ perHour: 100, perDay: 300 });
  });
});
