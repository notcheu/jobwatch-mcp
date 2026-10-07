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
import { apiBase, siteOf, type WorkdaySite } from './board';

/** Postings per search request: the most Workday gives (it answers 400 above). */
const PAGE_SIZE = 20;
/** Search requests per title word, and title words searched: the cost of the list stays under `MAX_SEARCHES` per board and call. */
const PAGES_PER_SEARCH = 2;
const MAX_TERMS = 3;
/** Search requests per board and call. */
export const MAX_SEARCHES = 6;

const DAY = 86_400_000;

/** `POST <site>/jobs`: a page of postings, with a relative date ("Posted 3 Days Ago") and no text. */
const searchSchema = z.object({
  total: z.number(),
  jobPostings: z.array(
    z.object({
      title: z.string(),
      externalPath: z.string().regex(/^\/job\/[A-Za-z0-9._~%/-]{1,300}$/),
      locationsText: z.string().nullish(),
      postedOn: z.string().nullish(),
    }),
  ),
});

/** `GET <site>/job/...`: the text and the exact start date of one posting. */
const detailSchema = z.object({
  jobPostingInfo: z.object({
    title: z.string().nullish(),
    jobDescription: z.string().nullish(),
    location: z.string().nullish(),
    additionalLocations: z.array(z.string()).nullish(),
    startDate: z.string().nullish(),
    timeType: z.string().nullish(),
    externalUrl: z.string().nullish(),
    jobReqId: z.string().nullish(),
  }),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
});

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago" -> a time; null when it is not one of these. */
export function postedAt(text: string | null | undefined, now: number): string | null {
  const said = text?.toLowerCase() ?? '';
  if (said.includes('today')) return new Date(now).toISOString();
  if (said.includes('yesterday')) return new Date(now - DAY).toISOString();
  const days = /(\d+)\+?\s+days?\s+ago/.exec(said);
  // "30+ days ago" is a lower bound: the posting is at least that old
  return days === null ? null : new Date(now - Number(days[1]) * DAY).toISOString();
}

/** The requisition number at the end of the posting path (`..._JR2024711`), which is what a person calls the job. */
const requisition = (path: string): string => {
  const last = decodeURIComponent(path.split('/').pop() ?? '');
  const tail = last.includes('_') ? last.slice(last.lastIndexOf('_') + 1) : last;
  return tail.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
};

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** A not-found for Workday: an unknown site is 404, an unknown company 422. */
const gone = (status: number): boolean => status === 404 || status === 422;

/**
 * Reads a site: a few pages of the search (20 postings each, newest first when there is no word; one search per title word otherwise,
 * `MAX_TERMS` at most), then, for the postings that pass the date, title and place filters, one request each for the text
 * (`MAX_DETAIL_READS` at most). A posting whose text cannot be read is left out and counted in the warnings.
 */
export async function readBoard(address: BoardAddress, http: HttpClient, filters: BoardFilters): Promise<BoardRead> {
  const site = siteOf(address.label) as WorkdaySite;
  const base = apiBase(site);
  const now = Date.now();
  const terms = filters.title_any.slice(0, MAX_TERMS);
  const searches = terms.length === 0 ? [''] : terms;
  const pages = terms.length === 0 ? MAX_SEARCHES - 1 : PAGES_PER_SEARCH;
  const listed = new Map<string, z.infer<typeof searchSchema>['jobPostings'][number]>();
  let total = 0;
  for (const text of searches) {
    for (let page = 0; page < pages; page += 1) {
      const response = await http.postJson(
        address.feedUrl,
        { appliedFacets: {}, limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchText: text },
        { timeoutMs: 25_000 },
      );
      if (gone(response.status)) throw new BoardNotFound();
      const body = expectBoardResponse(response).json(searchSchema);
      total = Math.max(total, body.total);
      for (const posting of body.jobPostings) listed.set(posting.externalPath, posting);
      if (body.jobPostings.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= body.total) break;
    }
  }
  const warnings: string[] = [];
  if (terms.length > MAX_TERMS) warnings.push(`only the first ${MAX_TERMS} title words were searched on the site.`);
  if (total > listed.size && terms.length === 0)
    warnings.push(`only the newest ${listed.size} of ${total} postings were listed: narrow the search by title or place.`);
  const light = [...listed.values()].map((posting) => ({
    id: `${site.tenant}-${requisition(posting.externalPath)}`,
    path: posting.externalPath,
    company: null,
    title: posting.title.trim(),
    locations: posting.locationsText ? [posting.locationsText.trim()] : [],
    url: `https://${site.tenant}.${site.shard}.myworkdayjobs.com/${site.site}${posting.externalPath}`,
    postedAt: postedAt(posting.postedOn, now),
    description: '',
  }));
  const { toRead, rest, unread } = selectForDetail(light, filters, now, MAX_DETAIL_READS);
  const strip = ({ path: _path, ...posting }: (typeof light)[number]): Omit<BoardPosting, 'board'> => posting;
  const read: Omit<BoardPosting, 'board'>[] = [];
  let skipped = 0;
  for (const posting of toRead) {
    try {
      const response = await http.get(`${base}${posting.path}`, { timeoutMs: 25_000 });
      if (gone(response.status)) throw new BoardNotFound();
      const info = expectBoardResponse(response).json(detailSchema).jobPostingInfo;
      const places = [info.location, ...(info.additionalLocations ?? [])].filter((text): text is string => Boolean(text));
      read.push({
        ...strip(posting),
        locations: places.length > 0 ? [...new Set(places)] : posting.locations,
        postedAt: isoOrNull(info.startDate) ?? posting.postedAt,
        description: [htmlToText(info.jobDescription ?? ''), info.timeType ? `Time type: ${info.timeType}` : '']
          .filter((part) => part.trim() !== '')
          .join('\n\n'),
      });
    } catch (error) {
      if (error instanceof BoardNotFound || error instanceof BoardHttpError) skipped += 1;
      else throw error;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} posting(s) could not be read (closed since the list, or an error): left out.`);
  return { name: site.tenant, postings: [...read, ...rest.map(strip)], total, unread, warnings };
}
