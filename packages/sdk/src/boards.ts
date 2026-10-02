import { z } from 'zod';
import type { JobStore } from './context';
import { POSTED_WITHIN, containsAny, extractHints, fitToBytes, fold, postedCutoff, termMatcher } from './jobtext';

/**
 * What every "company board" adapter (Teamtailor, Greenhouse, Lever, Ashby...) shares: the same filters, the same judging rules,
 * the same job and board shapes. An adapter only resolves a handle or URL, fetches the board and turns the provider's response
 * into `BoardPosting`s; `judgeBoardPostings` does the rest, so a rule changed here changes for all of them.
 */

/** A posting from any ATS, in one shape. */
export interface BoardPosting {
  /** The id used in the job store: unique within the platform (the adapter's source). */
  id: string;
  /** Lower-case company name; the `board` of the stored job. */
  board: string;
  company: string | null;
  title: string;
  /** One entry per office, `Paris, FR` style. */
  locations: string[];
  /** Everything location-like, for matching (city, region, postal code, country). Falls back to `locations`. */
  locationText?: string;
  url: string;
  /** ISO time, or null when the ATS does not say. */
  postedAt: string | null;
  /** Plain text. */
  description: string;
}

/** The filter arguments every board tool takes, to spread into the tool's input object. */
export const boardFilters = {
  title_any: z
    .array(z.string().trim().min(1).max(60))
    .max(20)
    .default([])
    .describe('Keep jobs whose title contains any of these (case and accents ignored, "front" matches "Frontend"). Empty keeps all.'),
  location_any: z
    .array(z.string().trim().min(1).max(60))
    .max(20)
    .default([])
    .describe(
      'Keep jobs with an office matching any of these: a city, country code or postal code ("Paris", "FR", "75"). Empty keeps all.',
    ),
  posted_within: z
    .enum(POSTED_WITHIN)
    .default('any')
    .describe('last_24_hours, past_week, past_month, or any. Jobs without a date are kept.'),
  disallowed_terms: z
    .array(z.string().trim().min(1).max(60))
    .max(60)
    .default([])
    .describe('Whole words or phrases to reject, case-insensitive, plain text, not a regex.'),
  disallowed_scope: z
    .enum(['title', 'title_then_description'])
    .default('title')
    .describe(
      'title: reject on the title (such a job is neither stored nor returned). title_then_description: then also reject on the description (such a job is stored, not returned).',
    ),
  only_new: z.boolean().default(false).describe('Return only jobs this router had not stored before.'),
  max_results: z.number().int().min(1).max(200).default(50),
  description_max_chars: z
    .number()
    .int()
    .min(0)
    .max(6000)
    .default(1500)
    .describe('0 leaves the descriptions out. The full text is stored.'),
} as const;

export type BoardFilters = z.infer<z.ZodObject<typeof boardFilters>>;

export const boardExcludedSchema = z.object({
  id: z.string(),
  board: z.string(),
  title: z.string(),
  reason: z.enum(['title', 'description']),
  term: z.string(),
});
export type BoardExcluded = z.infer<typeof boardExcludedSchema>;

/** What the tool says about each company it was asked for. */
export const boardReportSchema = z.object({
  board: z.string(),
  feed_url: z.string().nullable(),
  status: z.enum(['ok', 'not_found', 'not_this_ats', 'invalid', 'refused', 'error']),
  jobs_total: z.number().nullable(),
  relevant: z.number().nullable().describe('Jobs left after the date range, title_any and location_any filters.'),
  message: z.string().optional(),
});
export type BoardReport = z.infer<typeof boardReportSchema>;

/** The job shape every board tool returns. */
export function boardJobSchema<S extends string>(source: S) {
  return z.object({
    id: z.string(),
    source: z.literal(source),
    board: z.string().describe('The company board the job was found on (lower-case company name).'),
    company: z.string().nullable(),
    title: z.string(),
    locations: z.array(z.string()),
    url: z.string(),
    posted_at: z.string().nullable(),
    description: z.string(),
    description_truncated: z.boolean(),
    read_from: z.literal('fetched').describe('Always fetched: the board is read fresh on every call.'),
    new: z.boolean().describe('true when this call stored the job for the first time.'),
    first_seen: z.string(),
    fetched_at: z.string(),
    last_seen: z.string(),
    stack_hints: z.array(z.string()),
    years_hints: z.array(z.number()),
    remote_hints: z.array(z.string()),
    salary_text: z.string().nullable(),
  });
}
export type BoardJob<S extends string = string> = z.infer<ReturnType<typeof boardJobSchema<S>>>;

/** Room for the job list in one result (the engine counts the payload twice against a 256 KiB ceiling). */
const JOBS_JSON_BUDGET = 100_000;

export interface Judged<S extends string> {
  jobs: BoardJob<S>[];
  excluded: BoardExcluded[];
  /** Passed every filter but were not returned (`max_results` or size). All are in the database. */
  notReturned: string[];
  /** Ids that passed the date, title_any and location_any filters (before the disallowed terms), for per-board counts. */
  relevantIds: Set<string>;
}

/**
 * The rules, in order, for the postings a call has just read (all of them fresh, so the job store is only used to remember):
 *  1. every posting still listed gets its `last_seen` refreshed (a stored job that is still online is never evicted);
 *  2. keep those in the date range (a job without a date is kept), matching `title_any` and `location_any`;
 *  3. a disallowed term in the TITLE: excluded, neither stored nor returned;
 *  4. the rest are STORED at once, with their full description (source and board recorded by the engine and the adapter);
 *  5. with `title_then_description`, a disallowed term in the DESCRIPTION: excluded, but it stays stored, so another call with
 *     other terms judges it again without reading anything;
 *  6. `only_new` drops what was stored before; the first `max_results` newest are returned, as many as fit one answer.
 */
export async function judgeBoardPostings<S extends string>(
  jobs: JobStore,
  source: S,
  postings: readonly BoardPosting[],
  filters: BoardFilters,
  now: number = Date.now(),
): Promise<Judged<S>> {
  await jobs.touch(postings.map((posting) => posting.id));

  const cutoff = postedCutoff(filters.posted_within, now);
  const titleWords = filters.title_any.map(fold);
  const places = filters.location_any.map(fold);
  const relevant = postings
    .filter((posting) => cutoff === null || posting.postedAt === null || Date.parse(posting.postedAt) >= cutoff)
    .filter((posting) => containsAny(posting.title, titleWords) && containsAny(posting.locationText ?? posting.locations.join(' '), places))
    .sort((a, b) => (Date.parse(b.postedAt ?? '') || 0) - (Date.parse(a.postedAt ?? '') || 0));

  const matches = termMatcher(filters.disallowed_terms);
  const known = await jobs.known(relevant.map((posting) => posting.id));
  const excluded: BoardExcluded[] = [];
  const accepted: BoardJob<S>[] = [];
  for (const posting of relevant) {
    const inTitle = matches(posting.title);
    if (inTitle !== null) {
      excluded.push({ id: posting.id, board: posting.board, title: posting.title, reason: 'title', term: inTitle });
      continue;
    }
    await jobs.put({
      id: posting.id,
      board: posting.board,
      title: posting.title,
      company: posting.company,
      location: posting.locations.join('; ') || null,
      url: posting.url,
      description: posting.description,
    });
    const inDescription = filters.disallowed_scope === 'title_then_description' ? matches(posting.description) : null;
    if (inDescription !== null) {
      excluded.push({ id: posting.id, board: posting.board, title: posting.title, reason: 'description', term: inDescription });
      continue;
    }
    const isNew = !known.has(posting.id);
    if (filters.only_new && !isNew) continue;
    const row = await jobs.get(posting.id);
    const text = posting.description.slice(0, filters.description_max_chars);
    const stamp = new Date(now).toISOString();
    accepted.push({
      id: posting.id,
      source,
      board: posting.board,
      company: posting.company,
      title: posting.title,
      locations: posting.locations,
      url: posting.url,
      posted_at: posting.postedAt,
      description: text,
      description_truncated: posting.description.length > text.length,
      read_from: 'fetched',
      new: isNew,
      first_seen: row?.firstSeen ?? stamp,
      fetched_at: row?.fetchedAt ?? stamp,
      last_seen: row?.lastSeen ?? stamp,
      ...extractHints(posting.description),
    });
  }

  const wanted = accepted.slice(0, filters.max_results);
  const { fit, rest } = fitToBytes(wanted, JOBS_JSON_BUDGET);
  return {
    jobs: fit,
    excluded,
    notReturned: [...rest, ...accepted.slice(filters.max_results).map((job) => job.id)],
    relevantIds: new Set(relevant.map((posting) => posting.id)),
  };
}
