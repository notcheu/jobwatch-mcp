import { AdapterBroken, Checkpoint, SessionInvalid, type BrowserAdapterContext } from '@jobwatch/sdk';
import { EXTRACT_CARDS, EXTRACT_JOB, type ExtractedCards, type ExtractedJob } from './extract';
import type { SearchLayout } from './layouts/layout';
import { PAGE_SIZE, classifyPage, extractHints, jobUrl, parseCard, type Card, type Hints, type PostedWithin } from './parse';

export interface SearchArgs {
  keywords: string;
  geo: string;
  posted_within: PostedWithin;
  remote_only: boolean;
  /** First result page to load (25 results each). */
  page: number;
  /** How many results to examine; the pages needed are loaded one after the other. */
  max_results: number;
}

export interface SearchResult {
  cards: Card[];
  /** First page loaded. */
  page: number;
  /** Search pages actually loaded (each is one budget unit). */
  pages_loaded: number;
  has_more: boolean;
  truncated: boolean;
  warnings: string[];
}

/** LinkedIn serves about 1000 results per search; more than 10 pages is never useful for a daily watch. */
export const MAX_PAGE = 10;

export type JobStatus = 'ok' | 'not_loaded' | 'closed';

export interface JobDetail extends Hints {
  id: string;
  title: string | null;
  company: string | null;
  description: string;
  status: JobStatus;
  url: string;
}

const NAVIGATION_TIMEOUT_MS = 45_000;
const CARDS_WAIT_MS = 15_000;

/** Throw the right engine error when LinkedIn shows a login wall or a security check instead of the page we asked for. */
export function assertSignedIn(url: string, hasLoginForm: boolean): void {
  const verdict = classifyPage(url, hasLoginForm);
  if (verdict === 'checkpoint') throw new Checkpoint('LinkedIn asked for a security verification.');
  if (verdict === 'needs_login') throw new SessionInvalid('LinkedIn is asking to sign in.');
}

interface PageResult {
  cards: Card[];
  fullPage: boolean;
  warnings: string[];
}

/** Load ONE search page and return its normalized cards (no filtering). */
async function loadPage(ctx: BrowserAdapterContext, layout: SearchLayout, args: SearchArgs, page: number): Promise<PageResult> {
  const { session } = ctx;
  const warnings: string[] = [];
  await ctx.pace('page');
  await session.goto(layout.searchUrl({ ...args, page }), { timeoutMs: NAVIGATION_TIMEOUT_MS });
  await session.waitForSelector('li[data-occludable-job-id], [componentKey^="job-card-component-ref-"], h2', CARDS_WAIT_MS);
  const extracted = await session.evaluate<ExtractedCards>(EXTRACT_CARDS);
  assertSignedIn(session.url(), extracted.loginForm);

  if (extracted.cards.length === 0) {
    // An empty list is only acceptable when the page SAYS there are no results. Otherwise the markup changed (drift).
    if (extracted.noResults) return { cards: [], fullPage: false, warnings: ['LinkedIn reports no results for this search.'] };
    throw new AdapterBroken('No job cards were found and the page does not say "no results": the LinkedIn layout may have changed.');
  }
  const parsed = extracted.cards.map(parseCard);
  const cards = parsed.filter((card): card is Card => card !== null);
  if (cards.length === 0)
    throw new AdapterBroken(
      'Job cards were found but none could be read (title, company, location): the LinkedIn layout may have changed.',
    );
  if (cards.length < parsed.length) warnings.push(`${parsed.length - cards.length} card(s) could not be read and were skipped.`);
  if (extracted.ai > 0 && layout.id === 'classic') warnings.push('LinkedIn served the AI search layout; cards were still read.');
  if (extracted.classic > 0 && layout.id === 'ai') warnings.push('LinkedIn served the classic search layout; cards were still read.');
  return { cards, fullPage: extracted.cards.length >= PAGE_SIZE, warnings };
}

/**
 * Examine `max_results` search results, starting at page `page`: loads as many 25-result pages as needed, one after the other
 * (paced), and stops early when a page is not full (the end of the results). Duplicates across pages are dropped. The remote
 * filter is applied last, so `max_results` counts what was examined, not what was kept.
 */
export async function searchCards(ctx: BrowserAdapterContext, layout: SearchLayout, args: SearchArgs): Promise<SearchResult> {
  const warnings: string[] = [];
  const wanted = Math.ceil(args.max_results / PAGE_SIZE);
  const last = Math.min(args.page + wanted - 1, MAX_PAGE);
  if (last < args.page + wanted - 1)
    warnings.push(`Only pages up to ${MAX_PAGE} are read; ${args.page + wanted - 1 - MAX_PAGE} page(s) of the request were not loaded.`);

  const seen = new Set<string>();
  const examined: Card[] = [];
  let pagesLoaded = 0;
  let more = false;
  for (let page = args.page; page <= last; page += 1) {
    let loaded: PageResult;
    try {
      loaded = await loadPage(ctx, layout, args, page);
    } catch (error) {
      // The first page proves the layout works; a later empty page just means the results ended.
      if (page > args.page && error instanceof AdapterBroken) {
        warnings.push(`Page ${page} returned no cards; stopped there.`);
        break;
      }
      throw error;
    }
    pagesLoaded += 1;
    // Seeing a stored job on a search page keeps it alive, whatever the filters say about it afterwards.
    await ctx.jobs.touch(loaded.cards.map((card) => card.id));
    warnings.push(...loaded.warnings.filter((warning) => !warnings.includes(warning)));
    for (const card of loaded.cards) {
      if (!seen.has(card.id)) {
        seen.add(card.id);
        examined.push(card);
      }
    }
    more = loaded.fullPage;
    if (!loaded.fullPage || examined.length >= args.max_results) break;
  }

  let result = examined.slice(0, args.max_results);
  const truncated = examined.length > args.max_results;
  if (args.remote_only) {
    result = result.filter((card) => card.work_mode === 'remote');
    warnings.push('remote filter is not applied by LinkedIn; cards were post-filtered on the location.');
  }
  return {
    cards: result,
    page: args.page,
    pages_loaded: pagesLoaded,
    has_more: (more || truncated) && args.page + pagesLoaded - 1 < MAX_PAGE,
    truncated,
    warnings,
  };
}

/** `Senior Frontend Engineer | Acme | LinkedIn` -> title and company, best effort. */
export function titleParts(pageTitle: string): { title: string | null; company: string | null } {
  const parts = pageTitle
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^linkedin$/i.test(part));
  return { title: parts[0]?.slice(0, 200) ?? null, company: parts.length >= 2 ? (parts[1]?.slice(0, 200) ?? null) : null };
}

/** Most of a description kept (and stored); the engine caps it again at the same value. */
export const MAX_STORED_DESCRIPTION = 20_000;

/** Open ONE job page by navigation (never by clicking) and read its full description (hints are computed from it). */
export async function readJob(ctx: BrowserAdapterContext, id: string): Promise<JobDetail> {
  const { session } = ctx;
  await ctx.pace('detail');
  await session.goto(jobUrl(id), { timeoutMs: NAVIGATION_TIMEOUT_MS });
  const page = await session.evaluate<ExtractedJob>(EXTRACT_JOB);
  assertSignedIn(session.url(), page.loginForm);
  const { title, company } = titleParts(page.title);
  const description = (page.description ?? '').slice(0, MAX_STORED_DESCRIPTION);
  const status: JobStatus = page.description === null ? 'not_loaded' : page.closed ? 'closed' : 'ok';
  return { id, title, company, description, status, url: jobUrl(id), ...extractHints(description) };
}
