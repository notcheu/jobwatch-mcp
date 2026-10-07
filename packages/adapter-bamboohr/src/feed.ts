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
import { originOf } from './board';

/** `GET <handle>.bamboohr.com/careers/list`: every open position, with no text and no date. */
const listSchema = z.object({
  result: z.array(
    z.object({
      id: z.string().regex(/^[0-9]{1,12}$/),
      jobOpeningName: z.string(),
      location: z.object({ city: z.string().nullish(), state: z.string().nullish() }).nullish(),
      isRemote: z.boolean().nullish(),
    }),
  ),
});

/** `GET <handle>.bamboohr.com/careers/<id>/detail`: the text, the date and the pay of one position. */
const detailSchema = z.object({
  result: z.object({
    jobOpening: z.object({
      jobOpeningShareUrl: z.string().nullish(),
      description: z.string().nullish(),
      compensation: z.string().nullish(),
      datePosted: z.string().nullish(),
      location: z.object({ city: z.string().nullish(), state: z.string().nullish(), addressCountry: z.string().nullish() }).nullish(),
    }),
  }),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

/**
 * Reads a board: the list (one request, no text and no date), then, for the positions that pass the title and place filters, one request
 * each for the detail (`MAX_DETAIL_READS` at most, the newest first: BambooHR numbers its openings in the order they were made). The date
 * range is applied afterwards, on the date each detail gives. An unknown company is redirected to bamboohr.com's own site, which is not
 * JSON: that is a board that does not exist. A position whose detail cannot be read is left out and counted in the warnings.
 */
export async function readBoard(address: BoardAddress, http: HttpClient, filters: BoardFilters): Promise<BoardRead> {
  const handle = address.label;
  const response = expectBoardResponse(await http.get(address.feedUrl, { timeoutMs: 25_000 }));
  if (!looksLikeJson(response.text)) throw new BoardNotFound();
  const list = response.json(listSchema).result;
  const light = list
    .map((entry) => ({
      id: entry.id,
      company: null,
      title: entry.jobOpeningName.trim(),
      locations: [
        [entry.location?.city, entry.location?.state].filter(Boolean).join(', '),
        ...(entry.isRemote === true ? ['Remote'] : []),
      ].filter((text) => text !== ''),
      url: `${originOf(handle)}/careers/${entry.id}`,
      postedAt: null as string | null,
      description: '',
    }))
    .sort((a, b) => Number(b.id) - Number(a.id));
  // the date filter waits for the details: ask `selectForDetail` about the other filters only
  const { toRead, rest, unread } = selectForDetail(light, { ...filters, posted_within: 'any' }, Date.now(), MAX_DETAIL_READS);
  const read: Omit<BoardPosting, 'board'>[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const posting of toRead) {
    try {
      const detail = expectBoardResponse(await http.get(`${originOf(handle)}/careers/${posting.id}/detail`, { timeoutMs: 25_000 })).json(
        detailSchema,
      ).result.jobOpening;
      const where = [detail.location?.city, detail.location?.state, detail.location?.addressCountry].filter(Boolean).join(', ');
      read.push({
        ...posting,
        locations: [...new Set([where, ...posting.locations].filter((text) => text !== ''))],
        url: detail.jobOpeningShareUrl?.startsWith(`${originOf(handle)}/`) ? detail.jobOpeningShareUrl : posting.url,
        postedAt: isoOrNull(detail.datePosted),
        description: [htmlToText(detail.description ?? ''), detail.compensation ? `Salary: ${detail.compensation}` : '']
          .filter((part) => part.trim() !== '')
          .join('\n\n'),
      });
    } catch (error) {
      if (error instanceof BoardNotFound || error instanceof BoardHttpError) skipped += 1;
      else throw error;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} position(s) could not be read (closed since the list, or an error): left out.`);
  return { name: null, postings: [...read, ...rest], total: list.length, unread, warnings };
}
