import { htmlToText, z } from '@jobwatch/sdk';

/** One posting from a Teamtailor feed, in the shape the tool works with. */
export interface Posting {
  /** Teamtailor's numeric job id (the number in the job URL): unique across all Teamtailor boards. */
  id: string;
  title: string;
  company: string | null;
  /** `Paris, FR` style, one entry per office. */
  locations: string[];
  /** Everything location-like, for matching: city, region, postal code, country. */
  locationText: string;
  url: string;
  /** ISO time, or null. */
  postedAt: string | null;
  description: string;
}

export interface Feed {
  /** The company name the feed announces (`bsport`, `PayFit`). */
  title: string | null;
  postings: Posting[];
}

const address = z.object({
  addressLocality: z.string().nullish(),
  addressRegion: z.string().nullish(),
  addressCountry: z.string().nullish(),
  postalCode: z.string().nullish(),
});

/** The JSON Feed Teamtailor serves at `/jobs.json`. A changed shape is `adapter_broken`, never an empty list. */
const feedSchema = z.object({
  title: z.string().nullish(),
  items: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      date_published: z.string().nullish(),
      content_html: z.string().nullish(),
      _jobposting: z
        .object({
          identifier: z.object({ value: z.union([z.number(), z.string()]) }).nullish(),
          datePosted: z.string().nullish(),
          description: z.string().nullish(),
          hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
          jobLocation: z.array(z.object({ address: address.nullish() })).nullish(),
        })
        .nullish(),
    }),
  ),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The numeric id from `.../jobs/8429717-vp-of-engineering`. */
const idFromUrl = (url: string): string | null => /\/jobs\/(\d{3,12})(?:-|\/|$)/.exec(url)?.[1] ?? null;

export function parseFeed(parse: <T>(schema: z.ZodType<T>) => T): Feed {
  const feed = parse(feedSchema);
  const postings: Posting[] = [];
  for (const item of feed.items) {
    const job = item._jobposting;
    const id = job?.identifier?.value !== undefined ? String(job.identifier.value) : idFromUrl(item.url);
    if (id === null || !/^\d{3,12}$/.test(id)) continue; // no usable id: it cannot be tracked, so it is not returned
    const places = (job?.jobLocation ?? []).map((place) => place.address).filter((place) => place !== null && place !== undefined);
    const locations = places
      .map((place) => [place.addressLocality, place.addressCountry].filter((part) => part).join(', '))
      .filter((text, index, list) => text !== '' && list.indexOf(text) === index);
    const html = job?.description ?? item.content_html ?? '';
    postings.push({
      id,
      title: item.title.trim(),
      company: job?.hiringOrganization?.name?.trim() || feed.title?.trim() || null,
      locations,
      locationText: places
        .flatMap((place) => [place.addressLocality, place.addressRegion, place.postalCode, place.addressCountry])
        .filter(Boolean)
        .join(' '),
      url: item.url,
      postedAt: isoOrNull(job?.datePosted ?? item.date_published),
      description: htmlToText(html),
    });
  }
  return { title: feed.title?.trim() || null, postings };
}
