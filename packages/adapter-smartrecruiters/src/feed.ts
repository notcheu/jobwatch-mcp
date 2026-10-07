import {
  BoardHttpError,
  BoardNotFound,
  MAX_DETAIL_READS,
  expectBoardResponse,
  htmlToText,
  selectForDetail,
  z,
  type BoardAddress,
  type BoardFilters,
  type BoardPosting,
  type BoardRead,
  type HttpClient,
} from '@jobwatch/sdk';
import { apiBase } from './board';

/** Postings asked for per list request (the most the API gives). */
const PAGE_SIZE = 100;
/** List requests per board and call: the list is newest first, so a big company shows its latest 500 postings. */
export const MAX_LIST_PAGES = 5;

const location = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  remote: z.boolean().nullish(),
  fullLocation: z.string().nullish(),
});

/** `GET api.smartrecruiters.com/v1/companies/<id>/postings?limit=100&offset=N`: newest first, with no text. */
const listSchema = z.object({
  totalFound: z.number(),
  content: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      releasedDate: z.string().nullish(),
      location: location.nullish(),
      company: z.object({ name: z.string().nullish() }).nullish(),
    }),
  ),
});

const section = z.object({ title: z.string().nullish(), text: z.string().nullish() }).nullish();

/** `GET api.smartrecruiters.com/v1/companies/<id>/postings/<postingId>`: the text of one posting, in sections of HTML. */
const detailSchema = z.object({
  postingUrl: z.string().nullish(),
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: section,
          jobDescription: section,
          qualifications: section,
          additionalInformation: section,
        })
        .nullish(),
    })
    .nullish(),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const placesOf = (place: z.infer<typeof location> | null | undefined): string[] => {
  if (place === null || place === undefined) return [];
  const text = place.fullLocation ?? [place.city, place.region, place.country?.toUpperCase()].filter(Boolean).join(', ');
  const places = text.trim() === '' ? [] : [text.trim()];
  // SmartRecruiters states remote work in a flag of its own: say it where location filters can see it.
  if (place.remote === true && !places.some((entry) => /remote/i.test(entry))) places.push('Remote');
  return places;
};

/**
 * Reads a board: the newest postings in up to `MAX_LIST_PAGES` list requests (no text), then, for the ones that pass the date, title and
 * place filters, one request each for the text (`MAX_DETAIL_READS` at most). A posting whose text cannot be read (closed since the list)
 * is left out and counted in the warnings.
 */
export async function readBoard(address: BoardAddress, http: HttpClient, filters: BoardFilters): Promise<BoardRead> {
  const handle = address.label;
  const listed: z.infer<typeof listSchema>['content'] = [];
  let total = 0;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response = expectBoardResponse(
      await http.get(`${address.feedUrl}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { timeoutMs: 25_000 }),
    );
    const body = response.json(listSchema);
    total = body.totalFound;
    listed.push(...body.content);
    if (body.content.length < PAGE_SIZE || listed.length >= total) break;
  }
  const warnings: string[] = [];
  if (total > listed.length)
    warnings.push(
      `only the newest ${listed.length} of ${total} postings were listed (${MAX_LIST_PAGES} requests at most): narrow the search by title or place.`,
    );
  const company = listed.find((posting) => posting.company?.name)?.company?.name ?? null;
  const light = listed.map((posting) => ({
    id: posting.id,
    company,
    title: posting.name.trim(),
    locations: placesOf(posting.location),
    url: `https://jobs.smartrecruiters.com/${handle}/${posting.id}`,
    postedAt: isoOrNull(posting.releasedDate),
    description: '',
  }));
  const { toRead, rest, unread } = selectForDetail(light, filters, Date.now(), MAX_DETAIL_READS);
  const read: Omit<BoardPosting, 'board'>[] = [];
  let skipped = 0;
  for (const posting of toRead) {
    try {
      const detail = expectBoardResponse(await http.get(`${apiBase(handle)}/postings/${posting.id}`, { timeoutMs: 25_000 })).json(
        detailSchema,
      );
      const sections = detail.jobAd?.sections;
      const text = [sections?.companyDescription, sections?.jobDescription, sections?.qualifications, sections?.additionalInformation]
        .map((part) => (part?.text ? `${part.title ?? ''}\n${htmlToText(part.text)}`.trim() : ''))
        .filter((part) => part !== '')
        .join('\n\n');
      read.push({ ...posting, url: detail.postingUrl ?? posting.url, description: text });
    } catch (error) {
      if (error instanceof BoardNotFound || error instanceof BoardHttpError) skipped += 1;
      else throw error;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} posting(s) could not be read (closed since the list, or an error): left out.`);
  return { name: company, postings: [...read, ...rest], total, unread, warnings };
}
