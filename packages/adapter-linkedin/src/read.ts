import type { BrowserAdapterContext } from '@jobwatch/sdk';
import type { Card } from './parse';
import { readJob, type JobDetail } from './search';

export type ExcludedBy = 'title' | 'description';

export interface Excluded {
  id: string;
  title: string;
  reason: ExcludedBy;
  /** The disallowed term that matched, as the caller wrote it. */
  term: string;
}

export interface OpenedJob extends JobDetail {
  /** From the search card when there is one (more reliable than the page title). */
  location: string | null;
}

export interface ReadPlan {
  /** Ids to leave alone: stored already, or listed by the caller. */
  known: ReadonlySet<string>;
  maxJobs: number;
  /** Returns the matched disallowed term, or null. */
  matchTitle: (title: string) => string | null;
  /** Null when terms apply to titles only. */
  matchDescription: ((description: string) => string | null) | null;
  /** Stop opening when `now()` passes this; the rest is reported as `remaining`. */
  deadline: number;
  now?: () => number;
}

export interface ReadOutcome {
  /** Job pages actually visited (the budget units spent on jobs). */
  visits: number;
  /** Opened, accepted and stored. */
  opened: OpenedJob[];
  /** Left alone because already stored or listed by the caller. */
  knownIds: string[];
  excluded: Excluded[];
  /** Opened but the page did not give a usable description (closed, not rendered): not stored, will be tried again. */
  failed: { id: string; status: string }[];
  /** Candidates not visited because of `maxJobs` (page visits, failed ones included) or the time budget. Call again to continue: stored jobs are skipped. */
  remaining: string[];
}

/**
 * The visiting strategy of `linkedin_search_and_read`, in order, and cheapest first:
 *  1. a job already stored (or listed in skip_ids) is never opened again;
 *  2. a card whose title holds a disallowed term is dropped without opening it (costs nothing);
 *  3. the rest are opened one by one, up to `maxJobs` and the time budget;
 *  4. an opened job whose description holds a disallowed term (when asked) is dropped, NOT stored;
 *  5. every other opened job is stored with its description before the next one is opened, so a call that dies half way
 *     loses nothing and the next call carries on with what is left.
 */
export async function readNew(ctx: BrowserAdapterContext, cards: readonly Card[], plan: ReadPlan): Promise<ReadOutcome> {
  const now = plan.now ?? Date.now;
  const outcome: ReadOutcome = { visits: 0, opened: [], knownIds: [], excluded: [], failed: [], remaining: [] };
  const stored = await ctx.jobs.known(cards.map((card) => card.id));

  const candidates: Card[] = [];
  for (const card of cards) {
    if (stored.has(card.id) || plan.known.has(card.id)) {
      outcome.knownIds.push(card.id);
      continue;
    }
    const term = plan.matchTitle(card.title);
    if (term !== null) outcome.excluded.push({ id: card.id, title: card.title, reason: 'title', term });
    else candidates.push(card);
  }

  for (const card of candidates) {
    if (outcome.visits >= plan.maxJobs || now() >= plan.deadline) {
      outcome.remaining.push(card.id);
      continue;
    }
    outcome.visits += 1;
    const job = await readJob(ctx, card.id);
    if (job.status !== 'ok') {
      outcome.failed.push({ id: card.id, status: job.status });
      continue;
    }
    const term = plan.matchDescription?.(job.description) ?? null;
    if (term !== null) {
      outcome.excluded.push({ id: card.id, title: card.title, reason: 'description', term });
      continue;
    }
    await ctx.jobs.put({
      id: card.id,
      title: card.title,
      company: card.company,
      location: card.location,
      url: job.url,
      description: job.description,
    });
    outcome.opened.push({ ...job, title: card.title, company: card.company, location: card.location });
  }
  return outcome;
}
