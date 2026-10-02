/**
 * Scripts that run INSIDE the LinkedIn page. They only read and return raw text: no decisions, no clicks, no typing, no
 * navigation (scrolling the results list is the one thing they do, and reading needs it). Each is an async function expression
 * that `BrowserSession.evaluate` calls. Ported from the proven `linkedin-extract.js` and `linkedin-read-job.js` of the
 * job-search routine, whose notes explain both scripts: the classic list is VIRTUALIZED (LinkedIn renders only the cards near
 * the viewport, and removes far ones), and a job description is rendered lazily, after its container already exists.
 * The markup was observed in the owner's own session on 2026-10-01. The real-browser behaviour of these scripts is checked by
 * hand (see docs/plans/07-adapter-linkedin.md, "Verification status"); the unit tests give the adapter canned results instead.
 */

/**
 * Cards of both search layouts. Layout A (classic): li[data-occludable-job-id]. Layout B (AI search): [componentKey^=job-card-component-ref-].
 * Layout A is virtualized: scrolls the result list in steps of 80 % of its height, keeping the fullest read of each card (a card
 * is empty until it is near the viewport), until every card is read or two steps in a row add nothing; then scrolls back to the top.
 */
export const EXTRACT_CARDS = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = (el) => (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 14);
  const found = new Map();
  const order = [];
  let classic = 0;
  let ai = 0;
  const snapshot = () => {
    classic = 0;
    ai = 0;
    const sources = [
      [document.querySelectorAll('li[data-occludable-job-id]'), (el) => el.getAttribute('data-occludable-job-id'), true],
      [document.querySelectorAll('[componentKey^="job-card-component-ref-"]'), (el) => (el.getAttribute('componentKey') || '').split('-').pop(), false],
    ];
    for (const [nodes, idOf, isClassic] of sources) {
      for (const el of nodes) {
        const id = idOf(el);
        if (!id) continue;
        if (isClassic) classic += 1; else ai += 1;
        if (!found.has(id)) { found.set(id, []); order.push(id); }
        const lines = read(el);
        if (lines.length > found.get(id).length) found.set(id, lines);
      }
    }
  };
  const hydrated = () => [...found.values()].filter((lines) => lines.length >= 3).length;
  const scroller = (el) => {
    let p = el ? el.parentElement : null;
    while (p) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 5) return p;
      p = p.parentElement;
    }
    return null;
  };
  snapshot();
  const sc = scroller(document.querySelector('li[data-occludable-job-id]'));
  let stagnant = 0;
  for (let step = 0; step < 14 && sc; step += 1) {
    const before = hydrated();
    snapshot();
    stagnant = hydrated() === before ? stagnant + 1 : 0;
    if (hydrated() >= found.size) break;
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5;
    if ((atBottom && stagnant >= 2) || stagnant >= 4) break;
    sc.scrollTop = Math.min(sc.scrollTop + Math.round(sc.clientHeight * 0.8), sc.scrollHeight);
    await sleep(700);
  }
  snapshot();
  if (sc) sc.scrollTop = 0;
  const head = (document.body.innerText || '').slice(0, 3000);
  return {
    classic,
    ai,
    cards: order.map((id) => ({ id, lines: found.get(id) })),
    noResults: /no results found|no matching jobs|aucun r.sultat/i.test(head),
    loginForm: !!document.querySelector('input[name="session_key"], #username'),
  };
}`;

/**
 * The job description and a few facts of a /jobs/view/<id>/ page (new markup) or a classic split view. The description container
 * exists before its text is rendered, so this POLLS (up to 10 s) until the text is not empty instead of reading once.
 */
export const EXTRACT_JOB = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const selectors = [
    '[componentKey^=JobDetails_AboutTheJob_] [data-testid=expandable-text-box]',
    '[componentKey^=JobDetails_AboutTheJob_]',
    '#job-details',
    '.jobs-description__content',
    '.jobs-box__html-content',
    '.show-more-less-html__markup',
  ];
  const read = () => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el ? norm(el.textContent).replace(/^About the job\\s*/i, '') : '';
      if (text) return text;
    }
    return '';
  };
  let description = '';
  const started = Date.now();
  while (Date.now() - started < 10000 && !(description = read())) await sleep(400);
  const head = (document.body.innerText || '').slice(0, 4000);
  return {
    description: description || null,
    closed: /no longer accepting applications|n.accepte plus de candidatures/i.test(head),
    title: document.title || '',
    loginForm: !!document.querySelector('input[name="session_key"], #username'),
  };
}`;

/** Light page state for the session check: the sign-in form, the top navigation bar. */
export const EXTRACT_PAGE_STATE = `() => ({
  loginForm: !!document.querySelector('input[name="session_key"], #username'),
  nav: !!document.querySelector('nav, header'),
  title: document.title || '',
})`;

export interface ExtractedCards {
  classic: number;
  ai: number;
  cards: { id: string; lines: string[] }[];
  noResults: boolean;
  loginForm: boolean;
}

export interface ExtractedJob {
  description: string | null;
  closed: boolean;
  title: string;
  loginForm: boolean;
}

export interface ExtractedPageState {
  loginForm: boolean;
  nav: boolean;
  title: string;
}
