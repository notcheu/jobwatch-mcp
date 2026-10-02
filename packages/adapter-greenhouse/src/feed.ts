import { htmlToText, z, type BoardPosting } from '@jobwatch/sdk';

/** The public job list of a Greenhouse board (`?content=true` includes each description, entity-encoded HTML). */
const schema = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      absolute_url: z.string(),
      company_name: z.string().nullish(),
      location: z.object({ name: z.string().nullish() }).nullish(),
      first_published: z.string().nullish(),
      updated_at: z.string().nullish(),
      content: z.string().nullish(),
    }),
  ),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function parseBoard(parse: <T>(schema: z.ZodType<T>) => T): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const board = parse(schema);
  const postings = board.jobs.map((job) => {
    const where = job.location?.name?.trim() ?? '';
    return {
      id: String(job.id),
      title: job.title.trim(),
      company: job.company_name?.trim() || null,
      locations: where === '' ? [] : [where],
      locationText: where,
      url: job.absolute_url,
      postedAt: isoOrNull(job.first_published ?? job.updated_at),
      description: htmlToText(job.content ?? ''),
    };
  });
  return { name: board.jobs.find((job) => job.company_name)?.company_name ?? null, postings };
}
