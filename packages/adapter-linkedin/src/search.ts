import { AdapterBroken, Checkpoint, SessionInvalid, type BrowserAdapterContext } from '@jobwatch/sdk';
import { DESCRIPTION_SELECTOR, EXTRACT_CARDS, EXTRACT_JOB, type ExtractedCards, type ExtractedJob } from './extract';
import type { SearchLayout } from './layouts/layout';
import { PAGE_SIZE, classifyPage, extractHints, jobUrl, parseCard, type Card, type Hints } from './parse';

export interface SearchArgs {
  keywords: string;
  geo: string;
  posted_within: '24h' | 'any';
  remote_only: boolean;
  page: number;
  max_cards: number;
}

export interface SearchResult {
  cards: Card[];
  page: number;
  has_more: boolean;
  truncated: boolean;
  warnings: string[];
}

export type JobStatus = 'ok' | 'not_loaded' | 'closed';

export interface JobDetail extends Hints {
  id: string;
  title: string | null;
  company: string | null;
  description: string;
  description_truncated: boolean;
  status: JobStatus;
  url: string;
}

const NAVIGATION_TIMEOUT_MS = 45_000;
const CARDS_WAIT_MS = 15_000;
const DESCRIPTION_WAIT_MS = 12_000;

/** Throw the right engine error when LinkedIn shows a login wall or a security check instead of the page we asked for. */
export function assertSignedIn(url: string, hasLoginForm: boolean): void {
  const verdict = classifyPage(url, hasLoginForm);
  if (verdict === 'checkpoint') throw new Checkpoint('LinkedIn asked for a security verification.');
  if (verdict === 'needs_login') throw new SessionInvalid('LinkedIn is asking to sign in.');
}

/** Load one search page and return normalized cards. */
export async function searchCards(ctx: BrowserAdapterContext, layout: SearchLayout, args: SearchArgs): Promise<SearchResult> {
  const { session } = ctx;
  const warnings: string[] = [];
  await ctx.pace('page');
  await session.goto(layout.searchUrl(args), { timeoutMs: NAVIGATION_TIMEOUT_MS });
  await session.waitForSelector('li[data-occludable-job-id], [componentKey^="job-card-component-ref-"], h2', CARDS_WAIT_MS);
  const extracted = await session.evaluate<ExtractedCards>(EXTRACT_CARDS);
  assertSignedIn(session.url(), extracted.loginForm);

  if (extracted.cards.length === 0) {
    // An empty list is only acceptable when the page SAYS there are no results. Otherwise the markup changed (drift).
    if (extracted.noResults)
      return { cards: [], page: args.page, has_more: false, truncated: false, warnings: ['LinkedIn reports no results for this search.'] };
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

  let result = cards;
  if (args.remote_only) {
    result = result.filter((card) => card.work_mode === 'remote');
    warnings.push('remote filter is not applied by LinkedIn; cards were post-filtered on the location.');
  }
  const truncated = result.length > args.max_cards;
  return {
    cards: result.slice(0, args.max_cards),
    page: args.page,
    has_more: extracted.cards.length >= PAGE_SIZE && args.page < 5,
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

/** Open ONE job page by navigation (never by clicking) and read its description. */
export async function readJob(ctx: BrowserAdapterContext, id: string, descriptionMaxChars: number): Promise<JobDetail> {
  const { session } = ctx;
  await ctx.pace('detail');
  await session.goto(jobUrl(id), { timeoutMs: NAVIGATION_TIMEOUT_MS });
  await session.waitForSelector(DESCRIPTION_SELECTOR, DESCRIPTION_WAIT_MS);
  const page = await session.evaluate<ExtractedJob>(EXTRACT_JOB);
  assertSignedIn(session.url(), page.loginForm);
  const { title, company } = titleParts(page.title);
  const description = page.description ?? '';
  const status: JobStatus = page.description === null ? 'not_loaded' : page.closed ? 'closed' : 'ok';
  return {
    id,
    title,
    company,
    description: description.slice(0, descriptionMaxChars),
    description_truncated: description.length > descriptionMaxChars,
    status,
    url: jobUrl(id),
    ...extractHints(description),
  };
}
