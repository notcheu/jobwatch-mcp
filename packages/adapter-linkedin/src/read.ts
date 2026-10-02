import type { BrowserAdapterContext, StoredJob } from '@jobwatch/sdk';
import { extractHints, type Card, type Hints } from './parse';
import { readJob } from './search';

export type ExcludedBy = 'title' | 'description';

export interface Excluded {
  id: string;
  title: string;
  reason: ExcludedBy;
  /** The disallowed term that matched, as the caller wrote it. */
  term: string;
}

/** The caller's disallowed terms for this call. There is no built-in list. */
export interface Terms {
  /** Returns the matched term, or null. */
  matchTitle: (title: string) => string | null;
  /** Null when terms apply to titles only. */
  matchDescription: ((description: string) => string | null) | null;
}

/** A job that passed the terms, from the page just read (`fetched`) or from the database (`stored`). Full description. */
export interface AcceptedJob extends Hints {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string;
  description: string;
  /** Where this call got the text: the page just read, or the router database. */
  readFrom: 'fetched' | 'stored';
  /** First time this job was stored: true when this very call stored it. */
  isNew: boolean;
  firstSeen: string;
  fetchedAt: string;
  lastSeen: string;
}

export interface Failed {
  id: string;
  status: string;
}

const fromStored = (row: StoredJob): AcceptedJob => ({
  id: row.id,
  title: row.title,
  company: row.company,
  location: row.location,
  url: row.url,
  description: row.description,
  readFrom: 'stored',
  isNew: false,
  firstSeen: row.firstSeen,
  fetchedAt: row.fetchedAt,
  lastSeen: row.lastSeen,
  ...extractHints(row.description),
});

const descriptionVerdict = (id: string, title: string, description: string, terms: Terms): Excluded | null => {
  const term = terms.matchDescription?.(description) ?? null;
  return term === null ? null : { id, title, reason: 'description', term };
};

/**
 * Judge ONE job whose description is not stored yet: visit the page, STORE it as soon as its title passes (a description that
 * later matches a disallowed term does not stop it being stored: another call with other terms will read it from the
 * database instead of the page), then apply the description terms. A title that holds a disallowed term is never stored;
 * a card is free to read again.
 */
async function visit(
  ctx: BrowserAdapterContext,
  id: string,
  card: { title: string; company: string; location: string } | null,
  terms: Terms,
  known: boolean,
): Promise<{ accepted: AcceptedJob } | { excluded: Excluded } | { failed: Failed }> {
  const page = await readJob(ctx, id);
  if (page.status !== 'ok') return { failed: { id, status: page.status } };
  const title = card?.title ?? page.title ?? '';
  const termInTitle = card === null ? terms.matchTitle(title) : null; // a card title was judged before the visit
  if (termInTitle !== null) return { excluded: { id, title, reason: 'title', term: termInTitle } };
  const row = {
    id,
    title: card?.title ?? page.title,
    company: card?.company ?? page.company,
    location: card?.location ?? null,
    url: page.url,
    description: page.description,
  };
  await ctx.jobs.put(row);
  const excluded = descriptionVerdict(id, title, page.description, terms);
  if (excluded !== null) return { excluded };
  const now = new Date().toISOString();
  return {
    accepted: {
      ...row,
      readFrom: 'fetched',
      isNew: !known,
      firstSeen: now,
      fetchedAt: now,
      lastSeen: now,
      ...extractHints(page.description),
    },
  };
}

export interface ReadPlan extends Terms {
  /** Ids to leave alone (the caller's own "seen" list). */
  skip: ReadonlySet<string>;
  /** `evaluate`: judge stored jobs with the current terms, from the database. `skip`: list them in known_ids, untouched. */
  stored: 'evaluate' | 'skip';
  /** Most job pages to visit (failed visits included). */
  maxJobs: number;
  /** Most accepted jobs handed back; the rest are named in `notReturned` (they are all in the database). */
  maxReturned: number;
  /** Stop visiting when `now()` passes this; the rest is reported as `remaining`. */
  deadline: number;
  now?: () => number;
}

export interface ReadOutcome {
  /** Job pages actually visited (the budget units spent on jobs). */
  visits: number;
  /** Accepted jobs, newly read ones first. At most `maxReturned`. */
  accepted: AcceptedJob[];
  /** Accepted but over `maxReturned`: read them with `linkedin_job`, which answers from the database for free. */
  notReturned: string[];
  /** Left alone: in `skip`, or stored when `stored` is `skip`. */
  knownIds: string[];
  excluded: Excluded[];
  failed: Failed[];
  /** Candidates not visited because of `maxJobs` or the time budget. Call again to continue: visited jobs are in the database. */
  remaining: string[];
}

/**
 * The visiting strategy of `linkedin_search_and_read`, cheapest first, for every search card in order:
 *  1. in `skip` -> left alone;
 *  2. a disallowed term in the card title -> excluded, NOT stored, no visit (the card is free to read again with other terms);
 *  3. already stored -> judged from the database with the current terms, no visit;
 *  4. otherwise visited (up to `maxJobs` and the time budget), stored at once, then judged on its description.
 * Stored jobs are never read from the page again, whatever the terms were when they were stored.
 */
export async function readNew(ctx: BrowserAdapterContext, cards: readonly Card[], plan: ReadPlan): Promise<ReadOutcome> {
  const now = plan.now ?? Date.now;
  const outcome: ReadOutcome = { visits: 0, accepted: [], notReturned: [], knownIds: [], excluded: [], failed: [], remaining: [] };
  const stored = await ctx.jobs.known(cards.map((card) => card.id));
  const accepted: AcceptedJob[] = [];

  for (const card of cards) {
    if (plan.skip.has(card.id)) {
      outcome.knownIds.push(card.id);
      continue;
    }
    const termInTitle = plan.matchTitle(card.title);
    if (termInTitle !== null) {
      outcome.excluded.push({ id: card.id, title: card.title, reason: 'title', term: termInTitle });
      continue;
    }
    if (stored.has(card.id)) {
      if (plan.stored === 'skip') {
        outcome.knownIds.push(card.id);
        continue;
      }
      const row = await ctx.jobs.get(card.id);
      if (row !== null) {
        const excluded = descriptionVerdict(card.id, card.title, row.description, plan);
        if (excluded !== null) outcome.excluded.push(excluded);
        else accepted.push({ ...fromStored(row), title: card.title, company: card.company, location: card.location });
        continue;
      }
      // evicted between the two reads: treat it as new
    }
    if (outcome.visits >= plan.maxJobs || now() >= plan.deadline) {
      outcome.remaining.push(card.id);
      continue;
    }
    outcome.visits += 1;
    const result = await visit(
      ctx,
      card.id,
      { title: card.title, company: card.company, location: card.location },
      plan,
      stored.has(card.id),
    );
    if ('failed' in result) outcome.failed.push(result.failed);
    else if ('excluded' in result) outcome.excluded.push(result.excluded);
    else accepted.push(result.accepted);
  }

  const ordered = [...accepted.filter((job) => job.isNew), ...accepted.filter((job) => !job.isNew)];
  outcome.accepted = ordered.slice(0, plan.maxReturned);
  outcome.notReturned = ordered.slice(plan.maxReturned).map((job) => job.id);
  return outcome;
}

export interface ByIdPlan extends Terms {
  refresh: boolean;
}

export interface ByIdOutcome {
  visits: number;
  accepted: AcceptedJob[];
  excluded: Excluded[];
  failed: Failed[];
}

/** `linkedin_job`: the same judging for ids you already have. A stored job is answered from the database unless `refresh`. */
export async function readByIds(ctx: BrowserAdapterContext, ids: readonly string[], plan: ByIdPlan): Promise<ByIdOutcome> {
  const outcome: ByIdOutcome = { visits: 0, accepted: [], excluded: [], failed: [] };
  for (const id of new Set(ids)) {
    const row = plan.refresh ? null : await ctx.jobs.get(id);
    if (row !== null) {
      const title = row.title ?? '';
      const termInTitle = plan.matchTitle(title);
      const excluded =
        termInTitle !== null
          ? ({ id, title, reason: 'title', term: termInTitle } as const)
          : descriptionVerdict(id, title, row.description, plan);
      if (excluded !== null) outcome.excluded.push(excluded);
      else outcome.accepted.push(fromStored(row));
      continue;
    }
    outcome.visits += 1;
    const wasStored = plan.refresh && (await ctx.jobs.known([id])).has(id);
    const result = await visit(ctx, id, null, plan, wasStored);
    if ('failed' in result) outcome.failed.push(result.failed);
    else if ('excluded' in result) outcome.excluded.push(result.excluded);
    else outcome.accepted.push(result.accepted);
  }
  return outcome;
}
