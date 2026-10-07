import { describe, expect, it } from 'vitest';
import { boardFilters, judgeBoardPostings, runBoardTool, type BoardPosting } from './boards';
import { z } from 'zod';
import { AdapterBroken } from './errors';
import { FakeCompanyBoards, FakeJobStore } from './testkit/fakes';

const filters = (over: object = {}) => z.object(boardFilters).parse(over);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12);
const at = (days: number): string => new Date(NOW - days * DAY).toISOString();

const posting = (id: string, title: string, over: Partial<BoardPosting> = {}): BoardPosting => ({
  id,
  board: 'acme',
  company: 'Acme',
  title,
  locations: ['Paris, FR'],
  url: `https://jobs.example.com/${id}`,
  postedAt: at(1),
  description: 'We use React and TypeScript. 5 years of experience.',
  ...over,
});

const postings = [
  posting('1', 'Senior Frontend Engineer', { postedAt: at(2) }),
  posting('2', 'Backend Engineer (Java)', { postedAt: at(10) }),
  posting('3', 'Frontend Tech Lead', { locations: ['Barcelona, ES'], postedAt: at(60) }),
  posting('4', 'Fullstack Developer', { description: 'Angular and Node.js.', postedAt: at(1) }),
  posting('5', 'Platform Engineer', { postedAt: null }),
];

const judge = (over: object = {}, store = new FakeJobStore(() => new Date(NOW), 'ats')) =>
  judgeBoardPostings(store, 'ats', postings, filters(over), NOW).then((judged) => ({ judged, store }));
const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id);

describe('judgeBoardPostings', () => {
  it('returns every job newest first, undated ones last, and stores them with the board', async () => {
    const { judged, store } = await judge();
    expect(ids(judged.jobs)).toEqual(['4', '1', '2', '3', '5']);
    expect(judged.jobs[0]).toMatchObject({ source: 'ats', board: 'acme', read_from: 'fetched', new: true });
    expect([...store.jobs.values()].every((job) => job.source === 'ats' && job.board === 'acme')).toBe(true);
    expect(store.jobs.size).toBe(5);
  });

  it('filters by date range (undated kept), title words, and office, accents and case ignored', async () => {
    expect(ids((await judge({ posted_within: 'past_week' })).judged.jobs)).toEqual(['4', '1', '5']);
    expect(ids((await judge({ posted_within: 'past_month' })).judged.jobs)).toEqual(['4', '1', '2', '5']);
    expect(ids((await judge({ title_any: ['FRONT'] })).judged.jobs)).toEqual(['1', '3']);
    expect(ids((await judge({ location_any: ['barcelona'] })).judged.jobs)).toEqual(['3']);
    expect(ids((await judge({ location_any: ['paris'], title_any: ['tech lead'] })).judged.jobs)).toEqual([]);
  });

  it('reports which postings were relevant, for per-board counts', async () => {
    const { judged } = await judge({ title_any: ['engineer'] });
    expect([...judged.relevantIds].sort()).toEqual(['1', '2', '5']);
  });

  it('a disallowed title is neither stored nor returned; a disallowed description is stored but not returned', async () => {
    const { judged, store } = await judge({ disallowed_terms: ['java', 'angular'], disallowed_scope: 'title_then_description' });
    expect(judged.excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      ['4', 'description', 'angular'],
      ['2', 'title', 'java'],
    ]);
    expect(store.jobs.has('2')).toBe(false);
    expect(store.jobs.has('4')).toBe(true);
    expect(ids(judged.jobs)).toEqual(['1', '3', '5']);
    const titleOnly = await judge({ disallowed_terms: ['angular'] });
    expect(ids(titleOnly.judged.jobs)).toContain('4'); // scope title: the description is not looked at
  });

  it('marks new jobs, and only_new drops the ones stored before', async () => {
    const store = new FakeJobStore(() => new Date(NOW), 'ats');
    await judgeBoardPostings(store, 'ats', postings, filters(), NOW);
    const again = await judgeBoardPostings(store, 'ats', postings, filters(), NOW);
    expect(again.jobs.every((job) => job.new === false)).toBe(true);
    const more = [...postings, posting('6', 'Design System Engineer')];
    const onlyNew = await judgeBoardPostings(store, 'ats', more, filters({ only_new: true }), NOW);
    expect(ids(onlyNew.jobs)).toEqual(['6']);
  });

  it('refreshes last_seen of every posting still listed, even the filtered-out ones', async () => {
    const store = new FakeJobStore(() => new Date(NOW), 'ats');
    await judgeBoardPostings(store, 'ats', postings, filters(), NOW);
    for (const [id, job] of store.jobs) store.jobs.set(id, { ...job, lastSeen: '2026-01-01T00:00:00.000Z' });
    await judgeBoardPostings(store, 'ats', postings, filters({ title_any: ['zzz'] }), NOW);
    expect([...store.jobs.values()].every((job) => job.lastSeen === new Date(NOW).toISOString())).toBe(true);
  });

  it('caps the results and names the rest', async () => {
    const { judged } = await judge({ max_results: 2 });
    expect(judged.jobs).toHaveLength(2);
    expect(judged.notReturned).toHaveLength(3);
  });

  const longText = `Intro of the company.\n\nWhat you'll do\n- ${'Build the design system. '.repeat(40)}\n\nWhat we're looking for\n- ${'Five years of React. '.repeat(40)}`;
  const longPostings = [posting('L1', 'Engineer', { description: longText })];

  it('returns a summary by default and not the text, and still stores the whole text', async () => {
    const store = new FakeJobStore(() => new Date(NOW), 'ats');
    const judged = await judgeBoardPostings(store, 'ats', longPostings, filters(), NOW);
    expect(judged.jobs[0]).toMatchObject({
      description: '',
      description_truncated: false,
      summary_kind: 'sections',
      description_chars: longText.length,
    });
    expect(judged.jobs[0]?.summary).toMatch(/^Role: Build the design system.*Requirements: Five years of React/);
    expect(judged.jobs[0]?.summary.length).toBeLessThan(800);
    expect(store.jobs.get('L1')?.description).toBe(longText);
  });

  it('detail=full returns the text cut at the limit, detail=none neither', async () => {
    const store = new FakeJobStore(() => new Date(NOW), 'ats');
    const full = await judgeBoardPostings(store, 'ats', longPostings, filters({ detail: 'full', description_max_chars: 500 }), NOW);
    expect(full.jobs[0]).toMatchObject({ summary: '', summary_kind: null, description_truncated: true });
    expect(full.jobs[0]?.description).toHaveLength(500);
    expect((store.jobs.get('L1')?.description.length ?? 0) > 500).toBe(true);
    const none = await judgeBoardPostings(store, 'ats', longPostings, filters({ detail: 'none' }), NOW);
    expect(none.jobs[0]).toMatchObject({ summary: '', description: '', summary_kind: null, description_chars: longText.length });
  });

  it('hands back fewer jobs rather than failing when many long descriptions do not fit', async () => {
    const big = Array.from({ length: 40 }, (_, i) => posting(`b${i}`, `Engineer ${i}`, { description: 'x'.repeat(6000) }));
    const judged = await judgeBoardPostings(
      new FakeJobStore(),
      'ats',
      big,
      filters({ detail: 'full', description_max_chars: 6000, max_results: 200 }),
      NOW,
    );
    expect(judged.jobs.length).toBeGreaterThan(5);
    expect(judged.jobs.length).toBeLessThan(40);
    expect(judged.jobs.length + judged.notReturned.length).toBe(40);
  });

  it('validates the filter arguments', () => {
    const parse = (over: object) => z.object(boardFilters).safeParse(over).success;
    expect(parse({})).toBe(true);
    expect(parse({ posted_within: '24h' })).toBe(false);
    expect(parse({ max_results: 201 })).toBe(false);
    expect(parse({ detail: 'everything' })).toBe(false);
    expect(parse({ description_max_chars: 10 })).toBe(false);
    expect(parse({ disallowed_scope: 'everywhere' })).toBe(false);
    expect(parse({ title_any: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false);
  });
});

describe('runBoardTool', () => {
  const source = {
    ats: 'Demo',
    resolve: (input: string) =>
      /^[a-z]+$/.test(input)
        ? { feedUrl: `https://demo.example.com/${input}.json`, label: input }
        : { feedUrl: `https://demo.example.com/${input.split('/').pop()}.json`, label: input },
    parse: (parse: <T>(schema: z.ZodType<T>) => T) => {
      const body = parse(z.object({ name: z.string(), jobs: z.array(z.object({ id: z.string(), title: z.string() })) }));
      return {
        name: body.name,
        postings: body.jobs.map((j) => ({
          id: j.id,
          company: body.name,
          title: j.title,
          locations: [],
          url: 'https://x.test',
          postedAt: null,
          description: 'text',
        })),
      };
    },
    invalidMessage: 'nope',
  };
  const http = (answers: Record<string, { status: number; body: unknown }>) => {
    const seen: string[] = [];
    return {
      seen,
      get: async (url: string) => {
        seen.push(url);
        const a = answers[url] ?? { status: 404, body: '' };
        const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
        return {
          status: a.status,
          ok: a.status < 300,
          headers: {},
          text,
          json: <T>(schema: z.ZodType<T>): T => {
            const parsed = schema.safeParse(JSON.parse(text));
            if (!parsed.success) throw new AdapterBroken('Response does not match the expected shape.');
            return parsed.data;
          },
        };
      },
      postJson: async () => {
        throw new Error('unused');
      },
    };
  };
  const args = (over: object = {}) => ({ boards: ['acme'], ...z.object(boardFilters).parse(over) });

  it('requests a board once however many ways it was named, and charges one unit', async () => {
    const h = http({
      'https://demo.example.com/acme.json': { status: 200, body: { name: 'Acme', jobs: [{ id: '1', title: 'Engineer' }] } },
    });
    const result = await runBoardTool({ http: h, jobs: new FakeJobStore(), companies: new FakeCompanyBoards() }, 'demo', source, {
      ...args(),
      boards: ['acme', ' acme ', 'https://demo.example.com/x/acme'],
    });
    expect(h.seen).toEqual(['https://demo.example.com/acme.json']);
    expect(h.seen).toHaveLength(1); // one request, one unit: the engine counts requests
    expect(result.data.boards).toHaveLength(1);
    expect(result.data.jobs).toHaveLength(1);
  });

  it('reads a company name from the board the operator mapped it to, and still checks what that board answers', async () => {
    const h = http({
      'https://demo.example.com/sg.json': { status: 200, body: { name: 'Société Générale', jobs: [{ id: '1', title: 'Engineer' }] } },
    });
    const companies = new FakeCompanyBoards();
    companies.set('Société Générale', 'demo', 'sg');
    const result = await runBoardTool({ http: h, jobs: new FakeJobStore(), companies }, 'demo', source, {
      ...args(),
      boards: ['societe generale', 'https://demo.example.com/x/other'],
    });
    expect(h.seen).toEqual(['https://demo.example.com/sg.json', 'https://demo.example.com/other.json']);
    expect(result.data.jobs).toHaveLength(1);
    // a mapping on another ATS is not used here
    companies.set('Other', 'greenhouse', 'other');
    const again = await runBoardTool({ http: h, jobs: new FakeJobStore(), companies }, 'demo', source, { ...args(), boards: ['Other'] });
    expect(again.data.boards[0]?.status).toBe('not_found');
  });

  it('maps failures to a status per board and counts only real requests', async () => {
    const h = http({
      'https://demo.example.com/acme.json': { status: 200, body: { name: 'Acme', jobs: [] } },
      'https://demo.example.com/odd.json': { status: 200, body: { nope: 1 } },
    });
    const result = await runBoardTool({ http: h, jobs: new FakeJobStore(), companies: new FakeCompanyBoards() }, 'demo', source, {
      ...args(),
      boards: ['acme', 'ghost', 'odd'],
    });
    expect(result.data.boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['odd', 'not_this_ats'],
    ]);
    expect(h.seen).toHaveLength(3);
    expect(result.warnings.join(' ')).toMatch(/ghost: not_found/);
  });
});
