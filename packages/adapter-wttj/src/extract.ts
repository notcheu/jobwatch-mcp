/**
 * Scripts that run INSIDE a welcometothejungle.com page. They read and return raw data; decisions are made in TypeScript.
 * The site is client-rendered and answers plain HTTP with 403, so everything goes through the signed-in browser page. The ONE
 * thing a script does besides reading is `CLICK_NEXT`, which presses the "Next Page" pagination button and nothing else: it never
 * touches the buttons that change the account (save a job, "Pas pour moi", apply). Each is an async function expression that
 * `BrowserSession.evaluate` calls. The markup was observed in the owner's own session on 2026-10-02.
 */

/** Signed-in state and bot-check state of the current page. */
export const EXTRACT_PAGE_STATE = `() => ({
  path: location.pathname,
  title: document.title || '',
  loggedIn: !!document.querySelector('[data-testid="nav-logout-button"], [data-testid="nav-my-space-button"], [data-testid="nav-applications-button"]'),
  loginForm: !!document.querySelector('input[type="password"]'),
  challenge: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="challenges.cloudflare"], #challenge-form, #cf-challenge-running') || /^just a moment|un instant/i.test(document.title || ''),
})`;

/** Just the login and bot-check signals, for the page the matches were read from. */
export const EXTRACT_GATE = `() => ({
  path: location.pathname,
  loginForm: !!document.querySelector('input[type="password"]'),
  challenge: /^just a moment|un instant/i.test(document.title || '') || !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="challenges.cloudflare"]'),
})`;

/** The anchors that point to a job of a company, one per card at least (a card has two). */
const JOB_LINKS = `a[href*="/companies/"][href*="/jobs/"]`;

/**
 * The match cards on the page now: for every distinct job link, the smallest ancestor that holds only that job, and its text
 * lines. Waits up to 10 s for the first cards. Also returns the header of the first tab ("Nouveaux matchs 32") and whether a
 * usable "Next Page" button exists.
 */
export const EXTRACT_MATCHES = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isJob = (href) => /\\/companies\\/[^/]+\\/jobs\\/[^/?#]+/.test(href || '');
  const keyOf = (a) => a.getAttribute('href').split('?')[0];
  const anchors = () => [...document.querySelectorAll('${JOB_LINKS}')].filter((a) => isJob(a.getAttribute('href')));
  const started = Date.now();
  while (Date.now() - started < 10000 && anchors().length === 0) await sleep(400);
  await sleep(600);
  const list = anchors();
  const keys = [...new Set(list.map(keyOf))];
  const cardOf = (anchor) => {
    let best = anchor;
    let node = anchor;
    while (node.parentElement) {
      const inside = new Set([...node.parentElement.querySelectorAll('${JOB_LINKS}')].filter((a) => isJob(a.getAttribute('href'))).map(keyOf));
      if (inside.size > 1) break;
      node = node.parentElement;
      best = node;
    }
    return best;
  };
  const cards = keys.map((key) => {
    const card = cardOf(list.find((a) => keyOf(a) === key));
    return { href: key, lines: (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 20) };
  });
  const tab = document.querySelector('[role="tab"]');
  const next = [...document.querySelectorAll('button')].find((b) => /^next page$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  return {
    cards,
    tab: tab ? (tab.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
    hasNext: !!next && !next.disabled && next.getAttribute('aria-disabled') !== 'true',
  };
}`;

/**
 * Press "Next Page" (exactly that button) and wait, up to 10 s, until the first job on the page is a different one. Returns
 * whether the page moved. Never clicks anything else.
 */
export const CLICK_NEXT = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = () => {
    const a = [...document.querySelectorAll('${JOB_LINKS}')].find((x) => /\\/companies\\/[^/]+\\/jobs\\/[^/?#]+/.test(x.getAttribute('href') || ''));
    return a ? a.getAttribute('href').split('?')[0] : '';
  };
  const next = [...document.querySelectorAll('button')].find((b) => /^next page$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return { moved: false };
  const before = first();
  next.click();
  const started = Date.now();
  while (Date.now() - started < 10000) {
    await sleep(400);
    if (first() !== before) return { moved: true };
  }
  return { moved: false };
}`;

/**
 * A job page: the JSON-LD blocks (WTTJ embeds a schema.org JobPosting with the full description and an ISO date), the visible
 * description as a fallback, and the signals that the job is gone or the session is not signed in. Waits up to 10 s for the posting.
 */
export const EXTRACT_JOB = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const blocks = () => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').filter((t) => t.includes('JobPosting'));
  const started = Date.now();
  while (Date.now() - started < 10000 && blocks().length === 0 && !document.querySelector('[data-testid="job-section-description"]')) await sleep(400);
  const description = document.querySelector('[data-testid="job-section-description"]');
  const head = (document.body.innerText || '').slice(0, 3000);
  return {
    path: location.pathname,
    title: document.title || '',
    blocks: blocks().slice(0, 2).map((t) => t.slice(0, 120000)),
    descriptionText: description ? (description.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30000) : '',
    closed: /n'est plus disponible|offre (n'est plus|a expiré|expirée)|cette offre n'existe plus|page introuvable|404/i.test(head),
    loggedIn: !!document.querySelector('[data-testid="nav-logout-button"], [data-testid="nav-my-space-button"], [data-testid="nav-applications-button"]'),
    loginForm: !!document.querySelector('input[type="password"]'),
    challenge: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="challenges.cloudflare"], #challenge-form') || /^just a moment|un instant/i.test(document.title || ''),
  };
}`;

export interface PageState {
  path: string;
  title: string;
  loggedIn: boolean;
  loginForm: boolean;
  challenge: boolean;
}

export interface ExtractedMatches {
  cards: { href: string; lines: string[] }[];
  tab: string;
  hasNext: boolean;
}

export interface ExtractedJob {
  path: string;
  title: string;
  blocks: string[];
  descriptionText: string;
  closed: boolean;
  loggedIn: boolean;
  loginForm: boolean;
  challenge: boolean;
}
