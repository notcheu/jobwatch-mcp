import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { createStoredJobTextsTool } from './jobTexts';

const DESCRIPTION = `Acme builds search for the web, used by thousands of companies.

What you'll do
- Own the design system used by 40 engineers
- Review code and mentor two junior developers

What we're looking for
- 5+ years of experience with React and TypeScript
- Experience with accessibility

Benefits
- Remote friendly`;

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
  store.putJob(
    'linkedin',
    {
      id: '4000000001',
      board: null,
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      location: 'Paris',
      url: 'https://www.linkedin.com/jobs/view/4000000001/',
      description: DESCRIPTION,
    },
    Date.UTC(2026, 9, 1),
  );
  store.putJob(
    'teamtailor',
    {
      id: '8429717',
      board: 'bsport',
      title: 'VP of Engineering',
      company: 'bsport',
      location: 'Paris, FR',
      url: 'https://careers.bsport.io/jobs/8429717',
      description: 'Short ad without headings.',
    },
    Date.UTC(2026, 9, 2),
  );
});
afterEach(() => store.close());

const tool = () => createStoredJobTextsTool(store);
const run = async (args: object) => {
  const t = tool();
  return t.handler(t.input.parse(args), {} as never);
};
const refs = [
  { source: 'linkedin', id: '4000000001' },
  { source: 'teamtailor', id: '8429717' },
];
type Out = {
  jobs: {
    source: string;
    id: string;
    text: string;
    part_found: boolean;
    text_truncated: boolean;
    summary_kind: string | null;
    description_chars: number;
    board: string | null;
    outline: { part: string; chars: number }[];
  }[];
  missing: unknown[];
  not_returned: unknown[];
};
const out = (r: { data: unknown }) => r.data as Out;

describe('stored_job_texts', () => {
  it('returns the whole text of jobs of several platforms, with where each came from, and spends nothing', async () => {
    const result = await run({ jobs: refs });
    expect(out(result).jobs.map((j) => [j.source, j.id, j.board])).toEqual([
      ['linkedin', '4000000001', null],
      ['teamtailor', '8429717', 'bsport'],
    ]);
    expect(out(result).jobs[0]?.text).toBe(DESCRIPTION);
    expect(out(result).jobs[0]).toMatchObject({
      part: 'full',
      part_found: true,
      text_truncated: false,
      description_chars: DESCRIPTION.length,
    });
    expect(result.cost).toBe(0);
  });

  it('cuts the full text at max_chars and says so', async () => {
    const result = await run({ jobs: [refs[0]], max_chars: 200 });
    expect(out(result).jobs[0]?.text).toHaveLength(200);
    expect(out(result).jobs[0]?.text_truncated).toBe(true);
  });

  it('returns the summary, saying when it is only a guess', async () => {
    const result = await run({ jobs: refs, part: 'summary' });
    expect(out(result).jobs[0]).toMatchObject({ summary_kind: 'sections' });
    expect(out(result).jobs[0]?.text).toMatch(/^Role: Own the design system.*Requirements: 5\+ years/);
    expect(out(result).jobs[1]).toMatchObject({ summary_kind: 'excerpt', text: 'Short ad without headings.' });
  });

  it('returns one section on its own, and reports a section the text does not have', async () => {
    const result = await run({ jobs: refs, part: 'requirements' });
    expect(out(result).jobs[0]?.text).toBe(
      "What we're looking for\n- 5+ years of experience with React and TypeScript\n- Experience with accessibility",
    );
    expect(out(result).jobs[0]?.part_found).toBe(true);
    expect(out(result).jobs[1]).toMatchObject({ part_found: false, text: '' });
  });

  it('returns only the outline when asked', async () => {
    const result = await run({ jobs: [refs[0]], part: 'outline' });
    expect(out(result).jobs[0]?.text).toBe('');
    expect(out(result).jobs[0]?.outline.map((o) => o.part)).toEqual(['intro', 'role', 'requirements', 'offer']);
  });

  it('names the jobs it does not have instead of failing, and keeps platforms apart', async () => {
    const result = await run({ jobs: [{ source: 'apec', id: '4000000001' }, refs[0], { source: 'linkedin', id: '9999999999' }] });
    expect(out(result).jobs.map((j) => j.id)).toEqual(['4000000001']);
    expect(out(result).missing).toEqual([
      { source: 'apec', id: '4000000001' },
      { source: 'linkedin', id: '9999999999' },
    ]);
    expect(result.warnings.join(' ')).toMatch(/not in the database/);
  });

  it('answers a repeated reference once', async () => {
    expect(out(await run({ jobs: [refs[0], refs[0], refs[0]] })).jobs).toHaveLength(1);
  });

  it('hands back fewer jobs rather than failing when the texts do not fit one answer', async () => {
    const big = 'x'.repeat(5900);
    for (let n = 0; n < 25; n += 1)
      store.putJob(
        'linkedin',
        {
          id: `500000000${n}`.slice(0, 10).padEnd(10, '0') + String(n),
          board: null,
          title: 't',
          company: 'c',
          location: null,
          url: 'https://x.test',
          description: big,
        },
        1,
      );
    const jobs = Array.from({ length: 25 }, (_, n) => ({
      source: 'linkedin',
      id: `500000000${n}`.slice(0, 10).padEnd(10, '0') + String(n),
    }));
    const result = await run({ jobs, max_chars: 6000 });
    expect(out(result).jobs.length).toBeGreaterThan(5);
    expect(out(result).jobs.length).toBeLessThan(25);
    expect(out(result).jobs.length + out(result).not_returned.length).toBe(25);
    expect(JSON.stringify(result.data).length * 2).toBeLessThan(262_144);
  });

  it('only reads: it has no way to write, and its schema bounds every field', () => {
    const t = tool();
    expect(t.annotations.readOnlyHint).toBe(true);
    for (const bad of [
      {},
      { jobs: [] },
      { jobs: Array.from({ length: 26 }, () => refs[0]) },
      { jobs: [{ source: 'Linked In', id: '1' }] },
      { jobs: [{ source: 'linkedin', id: '../../etc' }] },
      { jobs: [{ source: 'linkedin', id: 'x'.repeat(65) }] },
      { jobs: [refs[0]], part: 'everything' },
      { jobs: [refs[0]], max_chars: 100 },
      { jobs: [refs[0]], extra: 1 },
    ]) {
      expect(t.input.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});
