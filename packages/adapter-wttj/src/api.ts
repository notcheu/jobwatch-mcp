import { Checkpoint, SessionInvalid, type BrowserAdapterContext, type VisitedPage } from '@jobwatch/sdk';
import { CLICK_NEXT, EXTRACT_GATE, EXTRACT_JOB, EXTRACT_MATCHES, type ExtractedJob, type ExtractedMatches } from './extract';
import { MATCHES_URL, findJobPosting, jobUrl, parseCard, postingDescription, postingLocation, type Card, type JobRef } from './parse';

/** WTTJ lists 10 matches per page. */
export const PAGE_SIZE = 10;
export const MAX_PAGES = 5;

/** How many match pages a request for `max_results` results loads at most (the list may end sooner). */
export const pagesFor = (maxResults: number): number => Math.max(1, Math.min(MAX_PAGES, Math.ceil(maxResults / PAGE_SIZE)));

/** A login page or a bot check instead of what we asked for: stop, and let the engine open the breaker. */
export function assertUsable(path: string, state: { loginForm: boolean; challenge: boolean }): void {
  if (state.challenge)
    throw new Checkpoint('Welcome to the Jungle showed a verification instead of its page. Nothing was worked around: try again later.');
  if (state.loginForm || /^\/[a-z]{2}\/(signin|login|signup|sign-in|sign-up)\b/.test(path) || /^\/(signin|login|signup)\b/.test(path))
    throw new SessionInvalid('Welcome to the Jungle is asking to sign in.');
}

const tabTotal = (tab: string): number | null => {
  const match = /(\d+)\s*$/.exec(tab);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export interface MatchesResult {
  cards: Card[];
  /** The number of new matches the first tab announces, when it does. */
  total: number | null;
  pages: number;
  warnings: string[];
}

/**
 * Read up to `maxResults` matches of the signed-in account, newest page first, 10 per page. Opens the matches page the way a
 * visitor does (no query string: the site's robots.txt disallows them) and moves on with the "Next Page" button.
 */
export async function readMatches(ctx: BrowserAdapterContext, maxResults: number, now = Date.now()): Promise<MatchesResult> {
  const warnings: string[] = [];
  const cards: Card[] = [];
  const seen = new Set<string>();
  await ctx.pace('page');
  await ctx.session.goto(MATCHES_URL, { timeoutMs: 45_000 });
  let page = await ctx.session.evaluate<ExtractedMatches>(EXTRACT_MATCHES);
  const state = await ctx.session.evaluate<{ path: string; loginForm: boolean; challenge: boolean }>(EXTRACT_GATE);
  assertUsable(state.path, state);
  const total = tabTotal(page.tab);
  let pages = 0;
  for (;;) {
    pages += 1;
    let unreadable = 0;
    for (const raw of page.cards) {
      const card = parseCard(raw, now);
      if (card === null) unreadable += 1;
      else if (!seen.has(card.id)) {
        seen.add(card.id);
        cards.push(card);
      }
    }
    if (unreadable > 0) warnings.push(`${unreadable} card(s) on page ${pages} could not be read and were skipped.`);
    if (page.cards.length === 0) {
      // An empty first page is only honest when the tab says there is nothing; otherwise the markup changed.
      if (pages === 1 && total !== 0)
        warnings.push('No match cards were found on the first page: the page layout may have changed, or there are no matches.');
      break;
    }
    if (cards.length >= maxResults || pages >= MAX_PAGES || !page.hasNext) break;
    await ctx.pace('page');
    ctx.spend(); // pressing "Next Page" loads the next list: a page view the engine cannot see
    const moved = await ctx.session.evaluate<{ moved: boolean }>(CLICK_NEXT);
    if (!moved.moved) break;
    page = await ctx.session.evaluate<ExtractedMatches>(EXTRACT_MATCHES);
  }
  return { cards: cards.slice(0, maxResults), total, pages, warnings };
}

/** Read one job page: the JSON-LD `JobPosting` first, the visible description when it is missing. */
export async function readJobPage(ctx: BrowserAdapterContext, ref: JobRef): Promise<VisitedPage> {
  await ctx.pace('detail');
  await ctx.session.goto(jobUrl(ref), { timeoutMs: 45_000 });
  const page = await ctx.session.evaluate<ExtractedJob>(EXTRACT_JOB);
  assertUsable(page.path, page);
  const posting = findJobPosting(page.blocks);
  const description = posting === null ? page.descriptionText : postingDescription(posting);
  const base = { board: ref.company, url: jobUrl(ref) };
  if (description.trim() === '')
    return { ...base, status: page.closed ? 'closed' : 'not_loaded', title: null, company: null, description: '' };
  return {
    ...base,
    status: page.closed && posting === null ? 'closed' : 'ok',
    title: posting?.title?.trim() || page.title.split(' - ')[0]?.trim() || null,
    company: posting?.hiringOrganization?.name?.trim() || null,
    description,
    ...(posting === null ? {} : { location: postingLocation(posting) }),
  };
}
