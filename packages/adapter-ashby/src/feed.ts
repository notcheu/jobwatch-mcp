import { z, type BoardPosting } from '@jobwatch/sdk';

/** `GET api.ashbyhq.com/posting-api/job-board/<name>`: every listed posting with its description (plain text included). */
const schema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      location: z.string().nullish(),
      secondaryLocations: z.array(z.unknown()).nullish(),
      publishedAt: z.string().nullish(),
      isListed: z.boolean().nullish(),
      isRemote: z.boolean().nullish(),
      jobUrl: z.string(),
      descriptionPlain: z.string().nullish(),
    }),
  ),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** A secondary location is a string or an object with a `location` string; anything else is ignored. */
const secondary = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null && 'location' in value && typeof value.location === 'string') return [value.location];
  return [];
};

export function parseBoard(parse: <T>(schema: z.ZodType<T>) => T): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const postings = parse(schema)
    .jobs.filter((job) => job.isListed !== false)
    .map((job) => {
      const places = [job.location ?? '', ...(job.secondaryLocations ?? []).flatMap(secondary)]
        .map((place) => place.trim())
        .filter((place, index, list) => place !== '' && list.indexOf(place) === index);
      // Ashby has a remote flag of its own: say it where location filters can see it.
      if (job.isRemote === true && !places.some((place) => /remote/i.test(place))) places.push('Remote');
      return {
        id: job.id,
        title: job.title.trim(),
        // Ashby postings carry no company name: the board is named after the handle.
        company: null,
        locations: places,
        url: job.jobUrl,
        postedAt: isoOrNull(job.publishedAt),
        description: (job.descriptionPlain ?? '').trim(),
      };
    });
  return { name: null, postings };
}
