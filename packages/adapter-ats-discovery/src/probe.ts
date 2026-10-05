import { AdapterBroken, HostNotAllowedError, JobwatchError, z, type HttpClient } from '@jobwatch/sdk';
import type { AtsId } from './handles';

const feedUrl = (ats: AtsId, handle: string): string =>
  ({
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${handle}/jobs`,
    lever: `https://api.lever.co/v0/postings/${handle}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${handle}`,
    teamtailor: `https://${handle}.teamtailor.com/jobs.json`,
  })[ats];

const title = z.object({ title: z.string().nullish(), text: z.string().nullish(), name: z.string().nullish() }).passthrough();
const titleOf = (job: z.infer<typeof title>): string => (job.title ?? job.text ?? job.name ?? '').slice(0, 120);

/** Only what is needed to tell a job board from any other JSON: a list of jobs, with titles. */
const SCHEMAS: Record<AtsId, z.ZodType<string[]>> = {
  greenhouse: z.object({ jobs: z.array(title) }).transform((feed) => feed.jobs.map(titleOf)),
  lever: z.array(title).transform((jobs) => jobs.map(titleOf)),
  ashby: z.object({ jobs: z.array(title) }).transform((feed) => feed.jobs.map(titleOf)),
  teamtailor: z.object({ items: z.array(title) }).transform((feed) => feed.items.map(titleOf)),
};

export interface Probe {
  ats: AtsId;
  handle: string;
  jobs: number;
  sample_titles: string[];
}

/**
 * Asks one ATS whether a handle is a company board: one request. Null when it is not (not found, or an answer that is not a job
 * list), and also when the host does not answer: a probe never fails the call.
 */
export async function probe(http: HttpClient, ats: AtsId, handle: string): Promise<Probe | null> {
  try {
    const response = await http.get(feedUrl(ats, handle), { timeoutMs: 15_000 });
    if (!response.ok) return null;
    const titles = response.json(SCHEMAS[ats]);
    return { ats, handle, jobs: titles.length, sample_titles: titles.slice(0, 3) };
  } catch (error) {
    if (error instanceof AdapterBroken || error instanceof HostNotAllowedError || error instanceof JobwatchError) return null;
    throw error;
  }
}
