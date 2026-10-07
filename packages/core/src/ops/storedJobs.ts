import { ANY_SEPARATOR, JobwatchError, defineHttpTool, describeJob, detailFields, keywordsSchema, termMatcher, z } from '@jobwatch/sdk';
import type { Clock, Store } from '../store/store';

const MAX_PAGE = 200;
/** Most rows read to build the statistics; a longer window is reported as cut, never silently. */
const MAX_SCAN = 5_000;
/** Room for the jobs in one result (the engine counts the payload twice against a 256 KiB ceiling). */
const JOBS_JSON_BUDGET = 100_000;
const DAY_MS = 24 * 3600 * 1000;
const TOP_BOARDS = 20;

const source = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, 'a platform name such as linkedin, apec, wttj, teamtailor');

const input = z
  .object({
    since: z
      .string()
      .max(32)
      .optional()
      .describe('Start of the window, inclusive: an ISO date (2026-10-05) or date-time (UTC). Default: 7 days before `until`.'),
    until: z
      .string()
      .max(32)
      .optional()
      .describe('End of the window, exclusive: an ISO date or date-time (UTC). Default: now. A bare date means midnight at its start.'),
    date_field: z
      .enum(['first_seen', 'fetched_at', 'last_seen'])
      .default('first_seen')
      .describe(
        "Which date the window applies to. first_seen: when a call first stored the job (the week's new jobs). last_seen: when a search last listed or read it. fetched_at: when its text was last read.",
      ),
    sources: z.array(source).max(10).default([]).describe('Only these platforms (the `source` of a job). Empty = all.'),
    boards: z.array(z.string().max(120)).max(20).default([]).describe('Only these company boards (the `board` of a job). Empty = all.'),
    terms: z
      .array(z.string().trim().min(1).max(60))
      .max(20)
      .default([])
      .describe(
        'Keywords to check against each job, one per entry (a phrase counts as one): whole words, case-insensitive, in the title and the stored description. Each job then lists the terms it contains, and `stats.terms` counts them over the whole window.',
      ),
    found_by: keywordsSchema(ANY_SEPARATOR, { allowEmpty: true })
      .optional()
      .describe(
        'Only jobs that a search with exactly these keywords listed (a list; any order, case-insensitive), from the history of searches, whatever its disallowed terms. One string with OR or a pipe between the keywords is split into the list.',
      ),
    only_matching: z
      .boolean()
      .default(false)
      .describe('With terms: list only the jobs that contain at least one term (the statistics still count all).'),
    ...detailFields('none'),
    limit: z.number().int().min(1).max(MAX_PAGE).default(50).describe('Most jobs listed in this answer.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .default(0)
      .describe('Jobs to skip, to read the next page (use next_offset of the previous answer).'),
  })
  .strict();

const jobSchema = z.object({
  source: z.string(),
  id: z.string(),
  board: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string(),
  first_seen: z.string(),
  fetched_at: z.string(),
  last_seen: z.string(),
  description_chars: z.number(),
  summary: z.string().describe('With detail=summary. Empty otherwise.'),
  summary_kind: z.enum(['sections', 'excerpt']).nullable(),
  description: z.string().describe('With detail=full. Empty otherwise.'),
  description_truncated: z.boolean(),
  found_by: z
    .array(z.object({ keywords: z.array(z.string()), disallowed_terms: z.array(z.string()) }))
    .describe(
      'The searches that listed this job (the history of searches), each as its keywords and its disallowed terms (the same keywords with other terms are another search). Empty when none is recorded.',
    ),
  title_terms: z.array(z.string()).describe('Terms found in the title.'),
  description_terms: z.array(z.string()).describe('Terms found in the stored description.'),
});

const output = z.object({
  jobs: z.array(jobSchema),
  total: z.number().describe('Jobs in the window that pass the source, board and only_matching filters.'),
  offset: z.number(),
  next_offset: z.number().nullable().describe('Pass it as `offset` for the next page; null when this is the last.'),
  window: z.object({ since: z.string(), until: z.string(), date_field: z.string() }),
  stats: z
    .object({
      jobs: z.number().describe('Every job of the window and filters, before only_matching and paging.'),
      scan_truncated: z.boolean().describe('true: the window holds more than the statistics read; narrow it.'),
      by_source: z.array(z.object({ source: z.string(), jobs: z.number() })),
      by_board: z.array(z.object({ source: z.string(), board: z.string(), jobs: z.number() })).describe('The busiest company boards.'),
      by_day: z.array(z.object({ day: z.string(), jobs: z.number() })).describe('Jobs per UTC day of the chosen date, oldest first.'),
      terms: z
        .array(z.object({ term: z.string(), jobs: z.number(), in_title: z.number(), in_description_only: z.number() }))
        .describe('Per term: jobs containing it, how many in the title, how many only in the description.'),
      matching_any_term: z.number().nullable().describe('Jobs containing at least one term; null without terms.'),
    })
    .strict(),
});

/** An ISO date or date-time as milliseconds (a date without a zone is UTC). */
function parseWhen(name: string, value: string): number {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new JobwatchError('invalid_arguments', `${name} is not a date: use 2026-10-05 or 2026-10-05T08:00:00Z.`);
  return ms;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * `stored_jobs`: list the jobs the router stored in a date window, without calling any site: the input of a weekly summary of
 * what the searches brought in, and of how well the search keywords match. Text is optional (`detail`), so a listing stays small;
 * the text of chosen jobs comes from `stored_job_texts`. Costs no platform budget and starts no browser.
 */
export function createStoredJobsTool(store: Store, clock: Clock) {
  return defineHttpTool({
    name: 'stored_jobs',
    title: 'Stored jobs in a date window (read-only)',
    description:
      'Read-only. Lists the jobs earlier searches stored in the router database between two dates (default: the last 7 days, by first_seen), newest first, WITHOUT contacting any site. detail=none (default) lists only title, company, place, url and dates; summary or full add text. Add `terms` to see which keywords each job contains and, in stats, how many jobs each keyword and platform brought in per day. Page with limit/offset. Read chosen jobs in full with stored_job_texts. Jobs older than the retention (JOB_RETENTION_DAYS, default 30) are gone.',
    input,
    output,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    limits: { timeoutS: 20, cost: 1, outputMaxBytes: 262_144 },
    handler: async (args) => {
      const now = clock();
      const until = args.until === undefined ? now : parseWhen('until', args.until);
      const since = args.since === undefined ? until - 7 * DAY_MS : parseWhen('since', args.since);
      if (since >= until) throw new JobwatchError('invalid_arguments', 'since must be before until.');

      const terms = [...new Set(args.terms.map((term) => term.trim().toLowerCase()))].map(
        (lower) => args.terms.find((term) => term.trim().toLowerCase() === lower)?.trim() ?? lower,
      );
      const matchers = terms.map((term) => ({ term, matches: termMatcher([term]) }));
      const { rows, total } = store.listJobs({
        field: args.date_field,
        since,
        until,
        sources: args.sources,
        boards: args.boards,
        ...(args.found_by === undefined || args.found_by.length === 0 ? {} : { search: { keywords: args.found_by } }),
        limit: MAX_SCAN,
        withDescription: matchers.length > 0,
      });

      const dateOf = (row: (typeof rows)[number]): number =>
        args.date_field === 'first_seen' ? row.firstSeen : args.date_field === 'fetched_at' ? row.fetchedAt : row.lastSeen;
      const bySource = new Map<string, number>();
      const byBoard = new Map<string, { source: string; board: string; jobs: number }>();
      const byDay = new Map<string, number>();
      const termStats = new Map(terms.map((term) => [term, { term, jobs: 0, in_title: 0, in_description_only: 0 }]));
      let matchingAny = 0;
      const analysed = rows.map((row) => {
        const titleTerms = matchers.filter(({ matches }) => matches(row.title ?? '') !== null).map(({ term }) => term);
        const descriptionTerms = matchers.filter(({ matches }) => matches(row.description) !== null).map(({ term }) => term);
        const found = new Set([...titleTerms, ...descriptionTerms]);
        if (found.size > 0) matchingAny += 1;
        for (const term of found) {
          const stat = termStats.get(term);
          if (stat === undefined) continue;
          stat.jobs += 1;
          if (titleTerms.includes(term)) stat.in_title += 1;
          else stat.in_description_only += 1;
        }
        bySource.set(row.platform, (bySource.get(row.platform) ?? 0) + 1);
        if (row.board) {
          const key = `${row.platform}\u0000${row.board}`;
          const entry = byBoard.get(key) ?? { source: row.platform, board: row.board, jobs: 0 };
          entry.jobs += 1;
          byBoard.set(key, entry);
        }
        const day = iso(dateOf(row)).slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
        return { row, titleTerms, descriptionTerms, matched: found.size > 0 };
      });

      const listed = args.only_matching && terms.length > 0 ? analysed.filter((entry) => entry.matched) : analysed;
      const page = listed.slice(args.offset, args.offset + args.limit);
      const jobs: z.infer<typeof jobSchema>[] = [];
      const encoder = new TextEncoder();
      let bytes = 0;
      const foundBy = new Map<string, { keywords: string[]; disallowed_terms: string[] }[]>();
      for (const platform of new Set(page.map((entry) => entry.row.platform)))
        for (const [id, queries] of store.foundBy(
          platform,
          page.filter((entry) => entry.row.platform === platform).map((entry) => entry.row.id),
        ))
          foundBy.set(
            `${platform}\u0000${id}`,
            queries
              .filter((search) => search.keywords.length > 0)
              .map((search) => ({ keywords: search.keywords, disallowed_terms: search.disallowed })),
          );
      for (const { row, titleTerms, descriptionTerms } of page) {
        // the description is only read from SQLite for the jobs that are listed, unless the terms already needed it
        const text =
          args.detail === 'none' ? '' : matchers.length > 0 ? row.description : (store.getJob(row.platform, row.id)?.description ?? '');
        const entry: z.infer<typeof jobSchema> = {
          source: row.platform,
          id: row.id,
          board: row.board ?? null,
          company: row.company,
          title: row.title,
          location: row.location,
          url: row.url,
          first_seen: iso(row.firstSeen),
          fetched_at: iso(row.fetchedAt),
          last_seen: iso(row.lastSeen),
          ...describeJob(text, args.detail, args.description_max_chars),
          description_chars: row.descriptionChars,
          found_by: foundBy.get(`${row.platform}\u0000${row.id}`) ?? [],
          title_terms: titleTerms,
          description_terms: descriptionTerms,
        };
        const size = encoder.encode(JSON.stringify(entry)).length;
        if (jobs.length > 0 && bytes + size > JOBS_JSON_BUDGET) break;
        bytes += size;
        jobs.push(entry);
      }
      const nextOffset = args.offset + jobs.length < listed.length ? args.offset + jobs.length : null;
      const scanTruncated = total > rows.length;
      const warnings = [
        ...(scanTruncated
          ? [`The window holds ${total} jobs; only the newest ${rows.length} are listed and counted. Narrow the dates.`]
          : []),
        ...(nextOffset !== null ? [`${listed.length - args.offset - jobs.length} more job(s): call again with offset=${nextOffset}.`] : []),
      ];
      return {
        data: {
          jobs,
          total: listed.length,
          offset: args.offset,
          next_offset: nextOffset,
          window: { since: iso(since), until: iso(until), date_field: args.date_field },
          stats: {
            jobs: rows.length,
            scan_truncated: scanTruncated,
            by_source: [...bySource]
              .map(([name, count]) => ({ source: name, jobs: count }))
              .sort((a, b) => b.jobs - a.jobs || a.source.localeCompare(b.source)),
            by_board: [...byBoard.values()].sort((a, b) => b.jobs - a.jobs || a.board.localeCompare(b.board)).slice(0, TOP_BOARDS),
            by_day: [...byDay].map(([day, count]) => ({ day, jobs: count })).sort((a, b) => a.day.localeCompare(b.day)),
            terms: [...termStats.values()],
            matching_any_term: terms.length > 0 ? matchingAny : null,
          },
        },
        warnings,
        cost: 0,
      };
    },
  });
}
