import { htmlToText, z, type BoardPosting } from '@jobwatch/sdk';

/** `GET api.lever.co/v0/postings/<site>?mode=json`: a plain array of postings, descriptions included. */
const schema = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    createdAt: z.number().nullish(),
    workplaceType: z.string().nullish(),
    categories: z.object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() }).nullish(),
    descriptionPlain: z.string().nullish(),
    additionalPlain: z.string().nullish(),
    lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  }),
);

const isoOrNull = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function parseBoard(parse: <T>(schema: z.ZodType<T>) => T): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const postings = parse(schema).map((job) => {
    const places = [job.categories?.location ?? '', ...(job.categories?.allLocations ?? [])]
      .map((place) => place.trim())
      .filter((place, index, list) => place !== '' && list.indexOf(place) === index);
    // Lever states remote work in a field of its own, not in the location: say it where location filters can see it.
    if (job.workplaceType === 'remote' && !places.some((place) => /remote/i.test(place))) places.push('Remote');
    const sections = (job.lists ?? []).map((list) => `${list.text ?? ''}\n${htmlToText(list.content ?? '')}`.trim());
    return {
      id: job.id,
      title: job.text.trim(),
      // Lever postings carry no company name: the board is named after the handle.
      company: null,
      locations: places,
      url: job.hostedUrl,
      postedAt: isoOrNull(job.createdAt),
      description: [job.descriptionPlain ?? '', ...sections, job.additionalPlain ?? ''].filter((part) => part.trim() !== '').join('\n\n'),
    };
  });
  return { name: null, postings };
}
