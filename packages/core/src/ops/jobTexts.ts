import { PARTS, defineHttpTool, partsOf, summarizeJob, z, type Part } from '@jobwatch/sdk';
import type { Store } from '../store/store';

const MAX_JOBS = 25;
/** Room for the texts in one result (the engine counts the payload twice against a 256 KiB ceiling). */
const TEXTS_JSON_BUDGET = 100_000;
/** Sections a caller can ask for on their own (`other` is a leftover, not something to ask for). */
const SECTION_PARTS = PARTS.filter((part): part is Exclude<Part, 'other'> => part !== 'other');

const jobRef = z
  .object({
    source: z
      .string()
      .max(32)
      .regex(/^[a-z][a-z0-9-]*$/, 'a platform name such as linkedin, apec, wttj, teamtailor'),
    id: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'the id the job tool returned'),
  })
  .strict();

const input = z
  .object({
    jobs: z.array(jobRef).min(1).max(MAX_JOBS).describe('Jobs to read, each as returned by a search or job tool: its source and its id.'),
    part: z
      .enum(['summary', 'full', 'outline', ...SECTION_PARTS])
      .default('full')
      .describe(
        'full: the description (see max_chars). summary: the short summary. outline: only the list of sections and their size. Or one section on its own: role, requirements, nice_to_have, offer, about, process, legal, intro.',
      ),
    max_chars: z.number().int().min(200).max(6000).default(3000).describe('With part=full or a section: characters returned per job.'),
  })
  .strict();

const textSchema = z.object({
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
  part: z.string(),
  part_found: z.boolean().describe('false when the description has no such section.'),
  text: z.string(),
  text_truncated: z.boolean(),
  summary_kind: z
    .enum(['sections', 'excerpt'])
    .nullable()
    .describe('With part=summary: excerpt means the text has no recognisable headings and the summary is only a guess.'),
  outline: z.array(z.object({ part: z.string(), chars: z.number() })),
});

const output = z.object({
  jobs: z.array(textSchema),
  missing: z
    .array(jobRef)
    .describe('Not in the router database: never read, or evicted after the retention. Read them with the platform job tool.'),
  not_returned: z.array(jobRef).describe('Found but over the size of one answer: ask for them again in a smaller batch or a shorter part.'),
});

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * `stored_job_texts`: the text of jobs earlier calls already read, straight from the router's database. Nothing is fetched from a
 * site, no browser is started and no platform budget is spent, which is what the platform job tools cannot promise (a browser
 * adapter leases the browser before it looks at the database). It exists so that a search can stay short (`detail: summary`) and
 * the full text of the few jobs worth reading is one cheap call away, in a batch.
 */
export function createStoredJobTextsTool(store: Store) {
  return defineHttpTool({
    name: 'stored_job_texts',
    title: 'Stored job texts (read-only)',
    description:
      'Read-only. Returns the text of up to 25 jobs that earlier searches already read, from the router database: the full description, a short summary, the outline of its sections, or one section (role, requirements...). Visits no site, starts no browser, spends no budget.',
    input,
    output,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    limits: { timeoutS: 20, cost: 1, outputMaxBytes: 262_144 },
    handler: async (args) => {
      const encoder = new TextEncoder();
      const jobs: z.infer<typeof textSchema>[] = [];
      const missing: z.infer<typeof jobRef>[] = [];
      const notReturned: z.infer<typeof jobRef>[] = [];
      const seen = new Set<string>();
      let bytes = 0;
      for (const ref of args.jobs) {
        const key = `${ref.source}\u0000${ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = store.getJob(ref.source, ref.id);
        if (row === null) {
          missing.push(ref);
          continue;
        }
        const { summary, kind, outline } = summarizeJob(row.description);
        let text: string;
        let found = true;
        let summaryKind: 'sections' | 'excerpt' | null = null;
        if (args.part === 'full') {
          text = row.description;
        } else if (args.part === 'summary') {
          text = summary;
          summaryKind = kind;
        } else if (args.part === 'outline') {
          text = '';
        } else {
          text = partsOf(row.description, [args.part]);
          found = text !== '';
        }
        const clipped = args.part === 'summary' || args.part === 'outline' ? text : text.slice(0, args.max_chars);
        const entry: z.infer<typeof textSchema> = {
          source: ref.source,
          id: ref.id,
          board: row.board ?? null,
          company: row.company ?? null,
          title: row.title ?? null,
          location: row.location ?? null,
          url: row.url,
          first_seen: iso(row.firstSeen),
          fetched_at: iso(row.fetchedAt),
          last_seen: iso(row.lastSeen),
          description_chars: row.description.length,
          part: args.part,
          part_found: found,
          text: clipped,
          text_truncated: clipped.length < text.length,
          summary_kind: summaryKind,
          outline,
        };
        const size = encoder.encode(JSON.stringify(entry)).length;
        if (jobs.length > 0 && bytes + size > TEXTS_JSON_BUDGET) {
          notReturned.push(ref);
          continue;
        }
        bytes += size;
        jobs.push(entry);
      }
      const warnings = [
        ...(missing.length > 0 ? [`${missing.length} job(s) are not in the database: read them with the platform job tool.`] : []),
        ...(notReturned.length > 0 ? [`${notReturned.length} job(s) did not fit in one answer: ask for them in a smaller batch.`] : []),
      ];
      return { data: { jobs, missing, not_returned: notReturned }, warnings, cost: 0 };
    },
  });
}
