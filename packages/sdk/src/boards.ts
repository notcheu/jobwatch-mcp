import { z } from 'zod';
import type { HttpClient, JobStore } from './context';
import { AdapterBroken, HostNotAllowedError, JobwatchError } from './errors';
import { POSTED_WITHIN, containsAny, extractHints, fitToBytes, fold, matchedTerms, postedCutoff, termMatcher } from './jobtext';
import { PIPE_SEPARATOR, keywordsSchema } from './keywords';
import { salaryFilterFields, salaryFloor } from './salaryFilter';
import { DETAILS, describeJob } from './summary';

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
  /** One entry per office, `Berlin, DE` style. */
  locations: string[];
  /** Everything location-like, for matching (city, region, postal code, country). Falls back to `locations`. */
  locationText?: string;
  url: string;
  /** ISO time, or null when the ATS does not say. */
  postedAt: string | null;
  /** Plain text. */
  description: string;
}

/**
 * How much of each job's text to return. `summary` (the default of the search tools) is a few hundred characters: the start of the
 * role and of the requirements; `full` is the text, cut at `description_max_chars`; `none` leaves both out. The full text is always
 * stored, and the job tools of each platform (and `stored_job_texts`) return it in batches.
 */
export function detailFields(defaultDetail: (typeof DETAILS)[number]) {
  return {
    detail: z
      .enum(DETAILS)
      .default(defaultDetail)
      .describe('summary: a short summary of the role and requirements. full: the description (see description_max_chars). none: neither.'),
    description_max_chars: z
      .number()
      .int()
      .min(500)
      .max(6000)
      .default(3000)
      .describe('With detail=full: characters of description returned per job. The full text is stored.'),
    hint_terms: z
      .array(z.string().trim().min(1).max(60))
      .max(30)
      .default([])
      .describe(
        'Words or phrases you care about for this search (a technology, a tool, a skill, a certification...). Each job lists the ones its text contains in matched_terms. There is no built-in list: it depends on the job you look for.',
      ),
  } as const;
}

/** The filter arguments every board tool takes, to spread into the tool's input object. */
export const boardFilters = {
  title_any: keywordsSchema(PIPE_SEPARATOR, { max: 20, maxChars: 60, allowEmpty: true })
    .default([])
    .describe(
      'Keep jobs whose title contains any of these (OR, never AND; case and accents ignored, "front" matches "Frontend"). A list, or one string with a pipe between the keywords ("react | vue"). Empty keeps all.',
    ),
  location_any: z
    .array(z.string().trim().min(1).max(60))
    .max(20)
    .default([])
    .describe(
      'Keep jobs with an office matching any of these: a city, country code or postal code ("Berlin", "DE", "10115"). Empty keeps all.',
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
  ...salaryFilterFields,
  only_new: z.boolean().default(false).describe('Return only jobs this router had not stored before.'),
  max_results: z.number().int().min(1).max(200).default(50).describe('Most jobs returned.'),
  ...detailFields('summary'),
} as const;

export type BoardFilters = z.infer<z.ZodObject<typeof boardFilters>>;

export const boardExcludedSchema = z.object({
  id: z.string(),
  board: z.string(),
  title: z.string(),
  reason: z.enum(['title', 'description', 'salary']),
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
    summary: z.string().describe('With detail=summary: the start of the role and of the requirements. Empty otherwise.'),
    summary_kind: z
      .enum(['sections', 'excerpt'])
      .nullable()
      .describe('excerpt: no headings were found, the summary is only the start of the text: read the full text if it matters.'),
    description: z.string().describe('With detail=full: the description. Empty otherwise.'),
    description_truncated: z.boolean(),
    description_chars: z.number().describe('Length of the whole stored description.'),
    read_from: z.literal('fetched').describe('Always fetched: the board is read fresh on every call.'),
    new: z.boolean().describe('true when this call stored the job for the first time.'),
    first_seen: z.string(),
    fetched_at: z.string(),
    last_seen: z.string(),
    matched_terms: z.array(z.string()).describe('The hint_terms found in the job text.'),
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
  const belowSalary = salaryFloor(filters);
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
    const belowFloor = belowSalary?.(posting.description) ?? null;
    if (belowFloor !== null) {
      excluded.push({ id: posting.id, board: posting.board, title: posting.title, reason: 'salary', term: belowFloor });
      continue;
    }
    const isNew = !known.has(posting.id);
    if (filters.only_new && !isNew) continue;
    const row = await jobs.get(posting.id);
    const text = describeJob(posting.description, filters.detail, filters.description_max_chars);
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
      ...text,
      read_from: 'fetched',
      new: isNew,
      first_seen: row?.firstSeen ?? stamp,
      fetched_at: row?.fetchedAt ?? stamp,
      last_seen: row?.lastSeen ?? stamp,
      matched_terms: matchedTerms(posting.description, filters.hint_terms),
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

// ---------------------------------------------------------------------------------------------- reading boards

/** A short lower-case name for a company: `PayFit` -> `payfit`, `Société Générale` -> `societe-generale`. The `board` in the database. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Where a handle or URL points: the address of the board's job list, and a label for reports. */
export interface BoardAddress {
  feedUrl: string;
  /** The page the caller pointed at, when the input was a URL: a second chance to find the board if `feedUrl` is not one. */
  pageUrl?: string;
  /** The handle, or the host of a custom domain. */
  label: string;
}

/** What one ATS adapter knows. Everything else is shared. */
export interface BoardSource {
  /** Human name for messages: `Greenhouse`. */
  ats: string;
  /** From a handle or a URL, or null when it is neither. Must never return an address on a host the adapter may not reach. */
  resolve(input: string): BoardAddress | null;
  /** Parse the response with `parse(schema)` (a changed shape throws `adapter_broken`) into postings, without the `board`. */
  parse(parse: <T>(schema: z.ZodType<T>) => T, address: BoardAddress): { name: string | null; postings: Omit<BoardPosting, 'board'>[] };
  /**
   * Called once when `feedUrl` answered 404 or did not look like this ATS, and the input was a URL. Looks at the page the caller
   * pointed at and returns where the board really is, or null. Whatever it returns goes through the same HTTP client rules.
   */
  discover?: (address: BoardAddress, http: HttpClient) => Promise<BoardAddress | null>;
  /** Said for an input that is not a handle or a URL of this ATS. */
  invalidMessage: string;
}

const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

export function boardToolOutput<S extends string>(source: S) {
  return z.object({
    jobs: z.array(boardJobSchema(source)),
    not_returned_ids: z.array(z.string()),
    excluded: z.array(boardExcludedSchema),
    boards: z.array(boardReportSchema),
  });
}

/** The `boards` argument of a board tool. */
export function boardsInput(description: string, maxBoards = 10) {
  return z.array(z.string().trim().min(1).max(300)).min(1).max(maxBoards).describe(description);
}

/**
 * The whole body of a board tool: read each requested board (one request each, failures reported per board and never fatal),
 * then judge the postings with `judgeBoardPostings`. The cost is what the engine counts: one unit per request made.
 */
export async function runBoardTool<S extends string>(
  ctx: { http: HttpClient; jobs: JobStore },
  source: S,
  board: BoardSource,
  args: BoardFilters & { boards: readonly string[] },
): Promise<{ data: z.infer<ReturnType<typeof boardToolOutput<S>>>; warnings: string[] }> {
  const warnings: string[] = [];
  const reports: BoardReport[] = [];
  const found: { posting: BoardPosting; report: BoardReport }[] = [];
  const seen = new Set<string>();
  const requested = new Set<string>();
  const fail = (name: string, feedUrl: string | null, status: BoardReport['status'], message: string): void => {
    reports.push({ board: name, feed_url: feedUrl, status, jobs_total: null, relevant: null, message });
  };

  for (const raw of new Set(args.boards.map((entry) => entry.trim()))) {
    const address = board.resolve(raw);
    if (address === null) {
      fail(raw.slice(0, 80), null, 'invalid', board.invalidMessage);
      continue;
    }
    // The same board given as a handle and as two URLs is one request.
    if (requested.has(address.feedUrl)) continue;
    requested.add(address.feedUrl);
    let target: BoardAddress = address;
    try {
      let response = await ctx.http.get(address.feedUrl, { timeoutMs: 25_000 });
      // The address built from the input is not a board: look at the page the caller named, once, to find the real one.
      if (
        (response.status === 404 || (response.ok && !looksLikeJson(response.text))) &&
        address.pageUrl !== undefined &&
        board.discover !== undefined
      ) {
        const found = await board.discover(address, ctx.http);
        if (found !== null && found.feedUrl !== address.feedUrl && !requested.has(found.feedUrl)) {
          requested.add(found.feedUrl);
          response = await ctx.http.get(found.feedUrl, { timeoutMs: 25_000 });
          target = { ...found, label: address.label };
        }
      }
      if (response.status === 404) {
        fail(target.label, target.feedUrl, 'not_found', `No ${board.ats} job board at this address.`);
        continue;
      }
      if (!response.ok) {
        fail(target.label, target.feedUrl, 'error', `HTTP ${response.status}`);
        continue;
      }
      const parsed = board.parse((schema) => response.json(schema), target);
      const name = slugify(parsed.name ?? '') || slugify(target.label) || target.label;
      const report: BoardReport = {
        board: name,
        feed_url: target.feedUrl,
        status: 'ok',
        jobs_total: parsed.postings.length,
        relevant: null,
      };
      reports.push(report);
      let fresh = 0;
      for (const posting of parsed.postings) {
        if (seen.has(posting.id)) continue;
        seen.add(posting.id);
        fresh += 1;
        found.push({ posting: { ...posting, board: name }, report });
      }
      if (fresh < parsed.postings.length)
        warnings.push(`${name}: ${parsed.postings.length - fresh} job(s) already listed by another board of this call.`);
    } catch (error) {
      if (error instanceof HostNotAllowedError)
        fail(target.label, target.feedUrl, 'refused', 'This host cannot be read (not a public https site).');
      else if (error instanceof AdapterBroken)
        fail(target.label, target.feedUrl, 'not_this_ats', `The address does not answer like a ${board.ats} job board.`);
      else if (error instanceof JobwatchError) fail(target.label, target.feedUrl, 'error', error.message);
      else throw error;
    }
  }

  const judged = await judgeBoardPostings(
    ctx.jobs,
    source,
    found.map((entry) => entry.posting),
    args,
  );
  // what a search with these title words matched (no words = the whole board, location and date filters aside), for the history of
  // searches: the postings that did not match are not "found by" these keywords, and the discarded ones are counted against what matched
  await ctx.jobs.recordSearch({
    keywords: args.title_any,
    found: found.map((entry) => entry.posting.id).filter((id) => judged.relevantIds.has(id)),
    returned: judged.jobs.map((job) => job.id),
    disallowed: args.disallowed_terms,
    excluded: judged.excluded.map(({ id, title, reason, term }) => ({ id, title, reason, term })),
  });
  for (const report of reports) {
    if (report.status === 'ok')
      report.relevant = found.filter((entry) => entry.report === report && judged.relevantIds.has(entry.posting.id)).length;
  }
  if (judged.notReturned.length > 0)
    warnings.push(
      `${judged.notReturned.length} more job(s) passed but were not returned (max_results or size): ask again with narrower filters.`,
    );
  for (const report of reports)
    if (report.status !== 'ok') warnings.push(`${report.board}: ${report.status}${report.message ? ` (${report.message})` : ''}`);
  return {
    data: { jobs: judged.jobs, not_returned_ids: judged.notReturned, excluded: judged.excluded, boards: reports },
    warnings,
  };
}
