import { htmlToText, z, type BoardPosting } from '@jobwatch/sdk';

/** `GET <handle>.recruitee.com/api/offers/`: every published offer, with its description and requirements as HTML. */
const schema = z.object({
  offers: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      status: z.string().nullish(),
      careers_url: z.string(),
      company_name: z.string().nullish(),
      published_at: z.string().nullish(),
      location: z.string().nullish(),
      city: z.string().nullish(),
      country: z.string().nullish(),
      remote: z.boolean().nullish(),
      hybrid: z.boolean().nullish(),
      description: z.string().nullish(),
      requirements: z.string().nullish(),
      locations: z.array(z.object({ name: z.string().nullish(), city: z.string().nullish(), country: z.string().nullish() })).nullish(),
    }),
  ),
});

/** `2026-10-05 15:07:51 UTC` -> an ISO time, or null. */
const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function parseBoard(parse: <T>(schema: z.ZodType<T>) => T): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const feed = parse(schema);
  const offers = feed.offers.filter((offer) => offer.status === undefined || offer.status === null || offer.status === 'published');
  const postings = offers.map((offer) => {
    const named = (offer.locations ?? []).map((place) => [place.city ?? place.name, place.country].filter(Boolean).join(', '));
    const places = [...named, offer.location ?? [offer.city, offer.country].filter(Boolean).join(', ')]
      .map((place) => place.trim())
      .filter((place, index, list) => place !== '' && list.indexOf(place) === index);
    // Recruitee has remote and hybrid flags of its own: say it where location filters can see it.
    if (offer.remote === true && !places.some((place) => /remote/i.test(place))) places.push('Remote');
    return {
      id: String(offer.id),
      title: offer.title.trim(),
      company: offer.company_name?.trim() || null,
      locations: places,
      url: offer.careers_url,
      postedAt: isoOrNull(offer.published_at),
      description: [htmlToText(offer.description ?? ''), htmlToText(offer.requirements ?? '')]
        .filter((part) => part.trim() !== '')
        .join('\n\n'),
    };
  });
  return { name: offers[0]?.company_name ?? null, postings };
}
