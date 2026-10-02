import { JobwatchError, defineHttpTool, z } from '@jobwatch/sdk';
import type { Clock, Store } from '../store/store';

const DAY_MS = 24 * 3600 * 1000;

const input = z
  .object({
    since: z
      .string()
      .max(32)
      .optional()
      .describe('Start of the window, inclusive: an ISO date or date-time (UTC). Default: 7 days before `until`.'),
    until: z.string().max(32).optional().describe('End of the window, exclusive. Default: now.'),
    source: z
      .string()
      .max(32)
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe('Only searches of this platform (linkedin, apec, wttj, teamtailor...). Default: all.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Most keywords listed.'),
  })
  .strict();

const output = z.object({
  window: z.object({ since: z.string(), until: z.string() }),
  searches: z.array(
    z.object({
      source: z.string(),
      query: z.string().describe('The search keywords; empty for a search without any (WTTJ matches, a whole company board).'),
      runs: z.number().describe('How many times this search ran in the window.'),
      last_run: z.string(),
      jobs_found: z.number().describe('Distinct jobs the search listed in the window.'),
      jobs_returned: z.number().describe('Of those, the ones it handed back (not dropped by the title or the limits).'),
      jobs_new: z.number().describe('Of those, the ones first stored in the window: what the search brought in that was new.'),
    }),
  ),
});

function parseWhen(name: string, value: string): number {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new JobwatchError('invalid_arguments', `${name} is not a date: use 2026-10-05 or 2026-10-05T08:00:00Z.`);
  return ms;
}

/**
 * `stored_searches`: how each search keyword did over a window (runs, jobs listed, returned, new), from the history of searches the
 * router keeps next to the stored jobs. It answers "which of my keywords bring in jobs, and which only bring the same ones back".
 * Reads the database only; no site, no browser, no platform budget.
 */
export function createStoredSearchesTool(store: Store, clock: Clock) {
  return defineHttpTool({
    name: 'stored_searches',
    title: 'Stored search history (read-only)',
    description:
      'Read-only. For each search keyword used in a window (default: the last 7 days), how many times it ran and how many distinct jobs it listed, returned and found for the first time, from the router database and without contacting any site. Use it to refine the keywords of the routine. List the jobs of one keyword with stored_jobs(found_by=...). Kept for JW_JOB_RETENTION_DAYS (default 30).',
    input,
    output,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    limits: { timeoutS: 20, cost: 1, outputMaxBytes: 65_536 },
    handler: async (args) => {
      const until = args.until === undefined ? clock() : parseWhen('until', args.until);
      const since = args.since === undefined ? until - 7 * DAY_MS : parseWhen('since', args.since);
      if (since >= until) throw new JobwatchError('invalid_arguments', 'since must be before until.');
      const rows = store.searchStats({ since, until, ...(args.source === undefined ? {} : { platform: args.source }), limit: args.limit });
      return {
        data: {
          window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
          searches: rows.map((row) => ({
            source: row.platform,
            query: row.query,
            runs: row.runs,
            last_run: new Date(row.lastRun).toISOString(),
            jobs_found: row.jobsFound,
            jobs_returned: row.jobsReturned,
            jobs_new: row.jobsNew,
          })),
        },
        warnings: [],
        cost: 0,
      };
    },
  });
}
