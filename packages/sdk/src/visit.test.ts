import { describe, expect, it } from 'vitest';
import { termMatcher } from './jobtext';
import { FakeJobStore } from './testkit/fakes';
import { readByIds, readNew, type JobCard, type ReadPlan, type VisitedPage } from './visit';

const card = (id: string, title = 'Engineer'): JobCard => ({ id, title, company: 'Acme', location: 'Paris' });
const cards = ['a1', 'a2', 'a3', 'a4'].map((id) => card(id));

/** A platform whose pages are `pages[id]`, and which remembers what was read. */
function platform(pages: Record<string, Partial<VisitedPage>> = {}) {
  const read: string[] = [];
  const visit = async (id: string): Promise<VisitedPage> => {
    read.push(id);
    return {
      status: 'ok',
      title: `Title ${id}`,
      company: 'Acme',
      url: `https://x.test/${id}`,
      description: `Text of ${id}. React.`,
      ...pages[id],
    };
  };
  return { read, visit };
}

const plan = (visit: ReadPlan['visit'], over: Partial<ReadPlan> = {}): ReadPlan => ({
  visit,
  skip: new Set(),
  stored: 'evaluate',
  maxJobs: 25,
  maxReturned: 50,
  matchTitle: termMatcher([]),
  matchDescription: null,
  deadline: Infinity,
  ...over,
});
const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id);
const store = () => new FakeJobStore(undefined, 'demo');

describe('readNew', () => {
  it('visits and stores what is new, recording the board the platform names', async () => {
    const jobs = store();
    const p = platform();
    const out = await readNew(jobs, cards, plan(p.visit, { board: 'acme' }));
    expect(ids(out.accepted)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(out.visits).toBe(4);
    expect(out.accepted[0]).toMatchObject({ readFrom: 'fetched', isNew: true, title: 'Engineer', company: 'Acme' });
    expect([...jobs.jobs.values()].every((job) => job.source === 'demo' && job.board === 'acme')).toBe(true);
  });

  it('judges in order: skip ids, then the title (never stored), then the stored copy, then a visit', async () => {
    const jobs = store();
    await jobs.put({
      id: 'a3',
      title: 'Engineer',
      company: 'Acme',
      location: null,
      url: 'https://x.test/a3',
      description: 'Stored text with Angular',
    });
    const p = platform();
    const out = await readNew(
      jobs,
      [card('a1'), card('a2', 'Frontend Engineer'), card('a3'), card('a4')],
      plan(p.visit, { skip: new Set(['a1']), matchTitle: termMatcher(['frontend']), matchDescription: termMatcher(['angular']) }),
    );
    expect(out.knownIds).toEqual(['a1']);
    expect(out.excluded.map((e) => [e.id, e.reason, e.term])).toEqual([
      ['a2', 'title', 'frontend'],
      ['a3', 'description', 'angular'],
    ]);
    expect(p.read).toEqual(['a4']);
    expect(jobs.jobs.has('a2')).toBe(false);
    expect(jobs.jobs.has('a4')).toBe(true);
  });

  it('stores a job before judging its description, so another list reads it from the database next time', async () => {
    const jobs = store();
    const p = platform({ a1: { description: 'We use Angular.' } });
    const first = await readNew(jobs, [card('a1')], plan(p.visit, { matchDescription: termMatcher(['angular']) }));
    expect(first.excluded).toEqual([{ id: 'a1', title: 'Engineer', reason: 'description', term: 'angular' }]);
    expect(jobs.jobs.has('a1')).toBe(true);
    const second = await readNew(jobs, [card('a1')], plan(p.visit, { matchDescription: termMatcher(['vue']) }));
    expect(ids(second.accepted)).toEqual(['a1']);
    expect(second.accepted[0]?.readFrom).toBe('stored');
    expect(p.read).toEqual(['a1']); // read once, from the platform
  });

  it('stored_jobs=skip lists stored jobs as known instead of judging them', async () => {
    const jobs = store();
    const p = platform();
    await readNew(jobs, cards, plan(p.visit));
    const again = await readNew(jobs, cards, plan(p.visit, { stored: 'skip' }));
    expect(again.knownIds).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(again.accepted).toEqual([]);
  });

  it('caps the visits, reports the rest as remaining, and a failed visit counts', async () => {
    const jobs = store();
    const p = platform({ a1: { status: 'not_loaded', description: '' } });
    const out = await readNew(jobs, cards, plan(p.visit, { maxJobs: 2 }));
    expect(out.visits).toBe(2);
    expect(out.failed).toEqual([{ id: 'a1', status: 'not_loaded' }]);
    expect(ids(out.accepted)).toEqual(['a2']);
    expect(out.remaining).toEqual(['a3', 'a4']);
    expect(jobs.jobs.has('a1')).toBe(false);
  });

  it('stops visiting when the time budget is spent', async () => {
    let clock = 0;
    const p = platform();
    const out = await readNew(store(), cards, plan(p.visit, { deadline: 25, now: () => (clock += 10) }));
    expect(ids(out.accepted)).toEqual(['a1', 'a2']);
    expect(out.remaining).toEqual(['a3', 'a4']);
  });

  it('hands back newly read jobs first, caps the answer and names the rest', async () => {
    const jobs = store();
    await jobs.put({ id: 'a1', title: 'Engineer', company: 'Acme', location: null, url: 'https://x.test/a1', description: 'old' });
    const out = await readNew(jobs, cards, plan(platform().visit, { maxReturned: 2 }));
    expect(ids(out.accepted)).toEqual(['a2', 'a3']);
    expect(out.notReturned).toEqual(['a4', 'a1']);
  });

  it('keeps what was stored when a later visit throws', async () => {
    const jobs = store();
    const visit = async (id: string): Promise<VisitedPage> => {
      if (id === 'a2') throw new Error('session lost');
      return { status: 'ok', title: 't', company: 'c', url: 'https://x.test', description: 'd' };
    };
    await expect(readNew(jobs, cards, plan(visit))).rejects.toThrow('session lost');
    expect([...jobs.jobs.keys()]).toEqual(['a1']);
  });
});

describe('readByIds', () => {
  it('answers stored ids from the database and visits only the others', async () => {
    const jobs = store();
    const p = platform();
    await readByIds(jobs, ['a1'], { visit: p.visit, refresh: false, matchTitle: termMatcher([]), matchDescription: null });
    p.read.length = 0;
    const out = await readByIds(jobs, ['a1', 'a2', 'a1'], {
      visit: p.visit,
      refresh: false,
      matchTitle: termMatcher([]),
      matchDescription: null,
    });
    expect(out.accepted.map((j) => [j.id, j.readFrom])).toEqual([
      ['a1', 'stored'],
      ['a2', 'fetched'],
    ]);
    expect(out.visits).toBe(1);
    expect(p.read).toEqual(['a2']);
  });

  it('refresh visits again but keeps the job marked as not new; a title match is neither stored nor returned', async () => {
    const jobs = store();
    const p = platform();
    const terms = { matchTitle: termMatcher(['title a2']), matchDescription: null };
    await readByIds(jobs, ['a1'], { visit: p.visit, refresh: false, ...terms });
    const out = await readByIds(jobs, ['a1', 'a2'], { visit: p.visit, refresh: true, ...terms });
    expect(out.accepted.map((j) => [j.id, j.readFrom, j.isNew])).toEqual([['a1', 'fetched', false]]);
    expect(out.excluded).toEqual([{ id: 'a2', title: 'Title a2', reason: 'title', term: 'title a2' }]);
    expect(jobs.jobs.has('a2')).toBe(false);
  });
});
