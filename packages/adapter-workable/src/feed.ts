import { htmlToText, z, type BoardPosting } from '@jobwatch/sdk';

/** `GET apply.workable.com/api/v1/widget/accounts/<account>?details=true`: every published job, with its description as HTML. */
const schema = z.object({
  name: z.string().nullish(),
  jobs: z.array(
    z.object({
      shortcode: z.string(),
      title: z.string(),
      url: z.string(),
      published_on: z.string().nullish(),
      created_at: z.string().nullish(),
      telecommuting: z.boolean().nullish(),
      employment_type: z.string().nullish(),
      country: z.string().nullish(),
      city: z.string().nullish(),
      state: z.string().nullish(),
      description: z.string().nullish(),
      locations: z
        .array(
          z.object({
            country: z.string().nullish(),
            city: z.string().nullish(),
            region: z.string().nullish(),
            hidden: z.boolean().nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function parseBoard(parse: <T>(schema: z.ZodType<T>) => T): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const feed = parse(schema);
  const postings = feed.jobs.map((job) => {
    const named = (job.locations ?? [])
      .filter((place) => place.hidden !== true)
      .map((place) => [place.city, place.country].filter(Boolean).join(', '));
    const places = [...named, [job.city, job.country].filter(Boolean).join(', ')]
      .map((place) => place.trim())
      .filter((place, index, list) => place !== '' && list.indexOf(place) === index);
    // Workable states remote work in a flag of its own: say it where location filters can see it.
    if (job.telecommuting === true && !places.some((place) => /remote/i.test(place))) places.push('Remote');
    return {
      id: job.shortcode,
      title: job.title.trim(),
      company: feed.name?.trim() || null,
      locations: places,
      url: job.url,
      postedAt: isoOrNull(job.published_on ?? job.created_at),
      description: htmlToText(job.description ?? ''),
    };
  });
  return { name: feed.name ?? null, postings };
}
