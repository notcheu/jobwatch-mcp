import { AdapterBroken, Checkpoint, htmlToText, z, type BrowserAdapterContext, type VisitedPage } from '@jobwatch/sdk';
import { CALL_ENDPOINT, EXTRACT_PAGE_STATE, type EndpointAnswer, type PageState } from './extract';

const HOME = 'https://www.apec.fr/';
export const PAGE_SIZE = 20;
/** Apec's search is sorted newest first; five pages (100 offers) is more than a daily watch needs. */
export const MAX_SEARCH_PAGES = 5;

/** How many search pages a request for `max_results` results loads at most (the results may end sooner). */
export const searchPagesFor = (maxResults: number): number => Math.max(1, Math.min(MAX_SEARCH_PAGES, Math.ceil(maxResults / PAGE_SIZE)));

/**
 * Apec's search takes ONE phrase (`motsCles`) and does not offer an OR, so a list of keywords is searched one keyword at a time and the
 * results are merged: that is the only way to get "any of them". Each keyword costs its own search pages, hence the small cap.
 */
export const MAX_APEC_KEYWORDS = 5;

export const offerUrl = (id: string): string => `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${id}`;

export interface SearchArgs {
  /** Any of them matches: each is searched on its own and the results are merged (Apec has no OR). */
  keywords: readonly string[];
  departments: string[];
  cdi_only: boolean;
  min_salary_k: number | null;
  max_results: number;
  posted_within: 'last_24_hours' | 'past_week' | 'past_month' | 'any';
}

/** One search result, as a card. */
export interface ApecCard {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  salary_text: string | null;
  posted_at: string | null;
  contract_code: number | null;
  snippet: string;
  url: string;
}

const searchSchema = z.object({
  totalCount: z.number(),
  resultats: z.array(
    z.object({
      numeroOffre: z.string(),
      intitule: z.string(),
      nomCommercial: z.string().nullish(),
      lieuTexte: z.string().nullish(),
      salaireTexte: z.string().nullish(),
      texteOffre: z.string().nullish(),
      datePublication: z.string().nullish(),
      typeContrat: z.number().nullish(),
    }),
  ),
});

const offerSchema = z.object({
  numeroOffre: z.string().nullish(),
  intitule: z.string().nullish(),
  nomCommercialEtablissement: z.string().nullish(),
  texteHtml: z.string().nullish(),
  texteHtmlProfil: z.string().nullish(),
  texteHtmlEntreprise: z.string().nullish(),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const BLOCKED = 'Apec showed a verification instead of its data (bot protection). Nothing was worked around: try again later.';

/**
 * Open one apec.fr page, the way a visitor arrives, so the site's own scripts run and the endpoints answer. Stops with a
 * checkpoint if a verification challenge is showing.
 */
export async function openApec(ctx: BrowserAdapterContext): Promise<void> {
  await ctx.pace('page');
  await ctx.session.goto(HOME, { timeoutMs: 45_000 });
  const state = await ctx.session.evaluate<PageState>(EXTRACT_PAGE_STATE);
  if (state.challenge) throw new Checkpoint(BLOCKED);
}

async function call(
  ctx: BrowserAdapterContext,
  arg: { kind: 'search'; body: unknown } | { kind: 'offer'; id: string },
): Promise<EndpointAnswer> {
  // a request made from inside the page: the engine cannot see it, so it is reported (before it can fail)
  ctx.spend();
  const answer = await ctx.session.evaluate<EndpointAnswer, typeof arg>(CALL_ENDPOINT, arg);
  if (answer.blocked) throw new Checkpoint(BLOCKED);
  return answer;
}

/** One keyword's search: newest first, up to `max_results` cards (newer than the date range when one is asked). */
async function searchKeyword(
  ctx: BrowserAdapterContext,
  args: SearchArgs,
  keyword: string,
  now = Date.now(),
): Promise<{ cards: ApecCard[]; total: number; pages: number; warnings: string[] }> {
  const cutoff =
    args.posted_within === 'any'
      ? null
      : now - { last_24_hours: 86_400_000, past_week: 7 * 86_400_000, past_month: 30 * 86_400_000 }[args.posted_within];
  const wanted = Math.min(args.max_results, MAX_SEARCH_PAGES * PAGE_SIZE);
  const warnings: string[] = [];
  const cards: ApecCard[] = [];
  let total = 0;
  let pages = 0;
  for (let index = 0; pages < MAX_SEARCH_PAGES && cards.length < wanted; index += PAGE_SIZE) {
    if (pages > 0) await ctx.pace('page');
    const body = {
      motsCles: keyword,
      lieux: args.departments,
      ...(args.cdi_only ? { typesContrat: ['101888'] } : {}),
      ...(args.min_salary_k === null ? {} : { salaireMinimum: String(args.min_salary_k), salaireMaximum: '500' }),
      pagination: { range: PAGE_SIZE, startIndex: index },
      sorts: [{ type: 'DATE', direction: 'DESCENDING' }],
      typeClient: 'CADRE',
    };
    const answer = await call(ctx, { kind: 'search', body });
    if (answer.status === 404 || answer.json === null)
      throw new AdapterBroken(`Apec's search answered HTTP ${answer.status} without data.`);
    const parsed = searchSchema.safeParse(answer.json);
    if (!parsed.success) throw new AdapterBroken("Apec's search answer no longer has the expected shape.", { cause: parsed.error });
    pages += 1;
    total = parsed.data.totalCount;
    let reachedOld = false;
    for (const result of parsed.data.resultats) {
      const posted = isoOrNull(result.datePublication);
      if (cutoff !== null && posted !== null && Date.parse(posted) < cutoff) {
        reachedOld = true; // sorted newest first: everything after this is older
        break;
      }
      cards.push({
        id: result.numeroOffre,
        title: result.intitule.trim(),
        company: result.nomCommercial?.trim() || null,
        location: result.lieuTexte?.trim() || null,
        salary_text: result.salaireTexte?.trim() || null,
        posted_at: posted,
        contract_code: result.typeContrat ?? null,
        snippet: (result.texteOffre ?? '').trim(),
        url: offerUrl(result.numeroOffre),
      });
    }
    if (reachedOld || parsed.data.resultats.length < PAGE_SIZE || index + PAGE_SIZE >= total) break;
  }
  if (cards.length === 0 && total > 0 && cutoff === null) warnings.push('Apec reports results but none could be read.');
  return { cards: cards.slice(0, wanted), total, pages, warnings };
}

/**
 * Search Apec for a list of keywords (any of them), newest first: up to `max_results` cards, one search per keyword, an offer found by
 * several keywords listed once. `total` is the sum of what each keyword reports, so an offer found twice counts twice there.
 */
export async function searchOffers(
  ctx: BrowserAdapterContext,
  args: SearchArgs,
  now = Date.now(),
): Promise<{ cards: ApecCard[]; total: number; pages: number; warnings: string[] }> {
  const wanted = Math.min(args.max_results, MAX_SEARCH_PAGES * PAGE_SIZE);
  const seen = new Map<string, ApecCard>();
  const warnings: string[] = [];
  let total = 0;
  let pages = 0;
  for (const keyword of args.keywords) {
    const found = await searchKeyword(ctx, args, keyword, now);
    total += found.total;
    pages += found.pages;
    for (const warning of found.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    for (const card of found.cards) if (!seen.has(card.id)) seen.set(card.id, card);
  }
  // newest first across the keywords; an offer with no date goes last
  const cards = [...seen.values()].sort((a, b) => Date.parse(b.posted_at ?? '') - Date.parse(a.posted_at ?? '') || 0);
  const dated = cards.filter((card) => card.posted_at !== null);
  const undated = cards.filter((card) => card.posted_at === null);
  return { cards: [...dated, ...undated].slice(0, wanted), total, pages, warnings };
}

/** Read one offer's full text from its public JSON, from the page. */
export async function readOffer(ctx: BrowserAdapterContext, id: string): Promise<VisitedPage> {
  await ctx.pace('detail');
  const answer = await call(ctx, { kind: 'offer', id });
  const url = offerUrl(id);
  if (answer.status === 404) return { status: 'closed', title: null, company: null, url, description: '' };
  const parsed = offerSchema.safeParse(answer.json);
  if (!parsed.success || answer.json === null) return { status: 'not_loaded', title: null, company: null, url, description: '' };
  const offer = parsed.data;
  const sections = [
    htmlToText(offer.texteHtml ?? ''),
    offer.texteHtmlProfil ? `Profil recherché\n${htmlToText(offer.texteHtmlProfil)}` : '',
    offer.texteHtmlEntreprise ? `Entreprise\n${htmlToText(offer.texteHtmlEntreprise)}` : '',
  ].filter((part) => part.trim() !== '');
  return {
    status: sections.length === 0 ? 'not_loaded' : 'ok',
    title: offer.intitule?.trim() || null,
    company: offer.nomCommercialEtablissement?.trim() || null,
    url,
    description: sections.join('\n\n').slice(0, 20_000),
  };
}
