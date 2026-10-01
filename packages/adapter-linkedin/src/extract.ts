/**
 * Scripts that run INSIDE the LinkedIn page. They only read and return raw text: no decisions, no clicks, no typing, no
 * navigation. Each is a function expression that `BrowserSession.evaluate` calls. Verified in a real browser against synthetic
 * fixtures by `extract.integration.test.ts`; the markup they target was observed in the owner's own session on 2026-10-01.
 */

/** Cards of both search layouts. Layout A (classic): li[data-occludable-job-id]. Layout B (AI search): [componentKey^=job-card-component-ref-]. */
export const EXTRACT_CARDS = `() => {
  const read = (el) => (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 14);
  const seen = new Set();
  const cards = [];
  let classic = 0;
  let ai = 0;
  for (const li of document.querySelectorAll('li[data-occludable-job-id]')) {
    const id = li.getAttribute('data-occludable-job-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    classic += 1;
    cards.push({ id, lines: read(li) });
  }
  for (const el of document.querySelectorAll('[componentKey^="job-card-component-ref-"]')) {
    const id = (el.getAttribute('componentKey') || '').split('-').pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ai += 1;
    cards.push({ id, lines: read(el) });
  }
  const head = (document.body.innerText || '').slice(0, 3000);
  return {
    classic,
    ai,
    cards,
    noResults: /no results found|no matching jobs|aucun r.sultat/i.test(head),
    loginForm: !!document.querySelector('input[name="session_key"], #username'),
  };
}`;

/** The job description and a few facts of a /jobs/view/<id>/ page (new markup) or a classic split view. */
export const EXTRACT_JOB = `() => {
  const pick = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  };
  const description =
    pick('[componentKey^=JobDetails_AboutTheJob_] [data-testid=expandable-text-box]') ||
    pick('#job-details') ||
    pick('.jobs-description__content') ||
    pick('.show-more-less-html__markup');
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

/** Description selectors, combined, for waiting until a job page has rendered. */
export const DESCRIPTION_SELECTOR = '[componentKey^=JobDetails_AboutTheJob_], #job-details, .jobs-description__content';

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
