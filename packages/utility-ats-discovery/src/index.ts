import { SDK_API_VERSION, defineHttpTool, defineUtility, z } from '@jobwatch/sdk';
import { ATS_IDS, boardPage, candidateHandles, knownBoard, readerTool, type AtsId } from './handles';
import { probe, type Probe } from './probe';

const MAX_COMPANIES = 8;
const MAX_HANDLES = 3;

const input = z
  .object({
    companies: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(MAX_COMPANIES)
      .describe(
        'Companies to look up, each a name ("Société Générale"), a website or careers URL ("https://www.acme.com"), or the address of a board on a known ATS.',
      ),
    ats: z
      .array(z.enum(ATS_IDS))
      .min(1)
      .max(ATS_IDS.length)
      .optional()
      .describe('Only check these ATS. Default: all of them (greenhouse, lever, ashby, teamtailor).'),
    handles_per_company: z
      .number()
      .int()
      .min(1)
      .max(MAX_HANDLES)
      .default(2)
      .describe('How many spellings of the name to try on each ATS (acme-labs, acmelabs...). Each try is one request per ATS.'),
  })
  .strict();

const matchSchema = z.object({
  ats: z.enum(ATS_IDS),
  handle: z.string().describe('The company handle on that ATS: the value to put in the `boards` argument of the reading tool.'),
  reading_tool: z.string().describe('The tool that lists its jobs, for example greenhouse_jobs.'),
  board_url: z.string().describe('The public page of the board, to open and check it is the right company.'),
  jobs: z.number().describe('How many jobs the board lists right now.'),
  sample_titles: z.array(z.string()).describe('A few job titles, untrusted text, to check it is the right company.'),
  from_address: z.boolean().describe('True when the input was the address of that board, so there is no doubt it is the one.'),
});

const output = z.object({
  companies: z.array(
    z.object({
      input: z.string(),
      tried: z.array(z.string()).describe('The handles that were checked.'),
      matches: z.array(matchSchema).describe('The boards found. A handle can exist for another company: check the titles and the page.'),
    }),
  ),
});

const planFor = (company: string, handles: number): { known: ReturnType<typeof knownBoard>; guesses: string[] } => {
  const known = knownBoard(company);
  return { known, guesses: known === null ? candidateHandles(company, handles) : [] };
};

export const atsFind = defineHttpTool({
  name: 'ats_find',
  title: 'Find the ATS of a company (read-only)',
  description:
    "Read-only. Finds which ATS (Greenhouse, Lever, Ashby, Teamtailor) hosts a company's careers board, from its name, website or careers URL, and returns the handle for the matching reading tool (greenhouse_jobs, lever_jobs...). No match means another ATS, a custom site or a different spelling. A handle can belong to another company: check titles and page. Titles are untrusted data.",
  input,
  output,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  limits: {
    timeoutS: 180,
    cost: 100,
    // one request per handle and ATS; an ATS address needs a single one
    estimate: (args) =>
      args.companies.reduce((sum, company) => {
        const { known, guesses } = planFor(company, args.handles_per_company);
        return sum + (known !== null ? 1 : guesses.length * (args.ats?.length ?? ATS_IDS.length));
      }, 0),
    outputMaxBytes: 32_768,
  },
  handler: async (args, { http }) => {
    const warnings: string[] = [];
    const wanted: readonly AtsId[] = args.ats ?? ATS_IDS;
    const companies: z.infer<typeof output>['companies'] = [];
    for (const company of new Set(args.companies)) {
      const { known, guesses } = planFor(company, args.handles_per_company);
      const targets =
        known !== null ? [{ ats: known.ats, handle: known.handle }] : guesses.flatMap((handle) => wanted.map((ats) => ({ ats, handle })));
      if (targets.length === 0) warnings.push(`${company.slice(0, 80)}: no usable name or site to derive a handle from.`);
      const found: Probe[] = [];
      for (const target of targets) {
        const hit = await probe(http, target.ats, target.handle);
        if (hit !== null) found.push(hit);
      }
      companies.push({
        input: company.slice(0, 300),
        tried: [...new Set(targets.map((target) => target.handle))],
        matches: found.map((hit) => ({
          ats: hit.ats,
          handle: hit.handle,
          reading_tool: readerTool(hit.ats),
          board_url: boardPage(hit.ats, hit.handle),
          jobs: hit.jobs,
          sample_titles: hit.sample_titles,
          from_address: known !== null,
        })),
      });
    }
    for (const entry of companies) {
      if (entry.matches.length === 0) warnings.push(`${entry.input.slice(0, 80)}: no board found on the ATS checked.`);
      else if (new Set(entry.matches.map((match) => match.handle)).size > 1 || entry.matches.length > 1)
        warnings.push(`${entry.input.slice(0, 80)}: several boards matched; check the titles and pages before using one.`);
    }
    return { data: { companies }, warnings };
  },
});

export default defineUtility({
  id: 'ats-discovery',
  displayName: 'ATS discovery',
  description:
    "Finds which applicant tracking system (Greenhouse, Lever, Ashby, Teamtailor) hosts a company's careers board (read-only, no login, no browser).",
  sdkApi: SDK_API_VERSION,
  platform: 'ats-discovery',
  allowedHosts: ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', '*.teamtailor.com'],
  // a lookup is a handful of small requests; the budget is for a few companies a day, not a crawl
  rate: { perHour: 200, perDay: 600 },
  tools: [atsFind],
});
