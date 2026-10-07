import {
  AdapterBroken,
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

const place = z.object({
  name: z.string().nullish(),
  city: z.string().nullish(),
  is_remote: z.boolean().nullish(),
  country: z.object({ name: z.string().nullish() }).nullish(),
  state: z.object({ name: z.string().nullish() }).nullish(),
});

/** `GET <handle>.breezy.hr/json`: every published position, with no text. */
const listSchema = z.array(
  z.object({
    id: z.string(),
    friendly_id: z.string().regex(/^[A-Za-z0-9-]{1,120}$/),
    name: z.string(),
    published_date: z.string().nullish(),
    salary: z.string().nullish(),
    location: place.nullish(),
    locations: z.array(place).nullish(),
    company: z.object({ name: z.string().nullish() }).nullish(),
  }),
);

/** The schema.org `JobPosting` every position page carries for search engines: the only place its text is. */
const jobPostingSchema = z.object({ '@type': z.literal('JobPosting'), description: z.string() }).passthrough();

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const placeText = (entry: z.infer<typeof place>): string =>
  [entry.city, entry.state?.name, entry.country?.name].filter((part): part is string => Boolean(part)).join(', ') ||
  entry.name?.trim() ||
  '';

/** The description of a position page, from its JobPosting data; null when the page has none. */
export function descriptionFromPage(html: string): string | null {
  for (const block of html.slice(0, 600_000).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = jobPostingSchema.safeParse(JSON.parse(block[1] ?? ''));
      if (parsed.success) return htmlToText(parsed.data.description);
    } catch {
      // another block, or not JSON: not the one
    }
  }
  return null;
}

/**
 * Reads a board: the list (one request, no text), then, for the positions that pass the date, title and place filters, one request each
 * for the position page (`MAX_DETAIL_READS` at most), whose JobPosting data holds the text. A page that cannot be read is left out and
 * counted in the warnings; a page with no JobPosting data is `adapter_broken`.
 */
export async function readBoard(address: BoardAddress, http: HttpClient, filters: BoardFilters): Promise<BoardRead> {
  const handle = address.label;
  const list = expectBoardResponse(await http.get(address.feedUrl, { timeoutMs: 25_000 })).json(listSchema);
  const company = list.find((entry) => entry.company?.name)?.company?.name ?? null;
  const light = list.map((entry) => {
    const places = [...(entry.locations ?? []), ...(entry.location === null || entry.location === undefined ? [] : [entry.location])];
    const named = places.map(placeText).filter((text, index, all) => text !== '' && all.indexOf(text) === index);
    // Breezy flags remote positions: say it where location filters can see it.
    if (places.some((entry) => entry.is_remote === true) && !named.some((text) => /remote/i.test(text))) named.push('Remote');
    return {
      id: entry.id,
      friendly: entry.friendly_id,
      company,
      title: entry.name.trim(),
      locations: named,
      url: `https://${handle}.breezy.hr/p/${entry.friendly_id}`,
      postedAt: isoOrNull(entry.published_date),
      salary: entry.salary?.trim() || null,
      description: '',
    };
  });
  const { toRead, rest, unread } = selectForDetail(light, filters, Date.now(), MAX_DETAIL_READS);
  const strip = ({ friendly: _friendly, salary: _salary, ...posting }: (typeof light)[number]): Omit<BoardPosting, 'board'> => posting;
  const read: Omit<BoardPosting, 'board'>[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const posting of toRead) {
    try {
      const page = expectBoardResponse(await http.get(posting.url, { timeoutMs: 25_000 }));
      const text = descriptionFromPage(page.text);
      if (text === null) throw new AdapterBroken('A Breezy position page has no JobPosting data.');
      read.push({
        ...strip(posting),
        description: [text, posting.salary === null ? '' : `Salary: ${posting.salary}`].filter((part) => part !== '').join('\n\n'),
      });
    } catch (error) {
      if (error instanceof BoardNotFound || error instanceof BoardHttpError) skipped += 1;
      else throw error;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} position(s) could not be read (closed since the list, or an error): left out.`);
  return { name: company, postings: [...read, ...rest.map(strip)], total: list.length, unread, warnings };
}
