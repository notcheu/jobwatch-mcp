/**
 * Pure parsing and normalization for the LinkedIn adapter. The in-page script returns RAW text lines only; everything that
 * decides what a card or a job means lives here, where it is unit-tested without a browser.
 */

export type WorkMode = 'remote' | 'hybrid' | 'on-site' | 'unknown';

export interface RawCard {
  id: string;
  /** Visible text lines of the card, as the page showed them. */
  lines: string[];
}

export interface Card {
  id: string;
  title: string;
  company: string;
  location: string;
  work_mode: WorkMode;
  salary_text: string | null;
  posted_text: string | null;
  posted_hours_ago: number | null;
  promoted: boolean;
  easy_apply: boolean;
  url: string;
}

export const GEO_PRESETS = { paris_idf: '104246759', france: '105015875' } as const;
export const PAGE_SIZE = 25;

/** How recent a posting must be. `any` sends no filter. The `f_TPR` values are LinkedIn's own ("Past 24 hours/week/month"). */
export const POSTED_WITHIN = ['last_24_hours', 'past_week', 'past_month', 'any'] as const;
export type PostedWithin = (typeof POSTED_WITHIN)[number];
const TPR: Record<Exclude<PostedWithin, 'any'>, string> = { last_24_hours: 'r86400', past_week: 'r604800', past_month: 'r2592000' };

/** The `f_TPR=...` URL parameter for a date range, or null for any time. */
export function postedParam(range: PostedWithin): string | null {
  return range === 'any' ? null : `f_TPR=${TPR[range]}`;
}

const JOB_ID = /^\d{5,15}$/;
export const isJobId = (value: string): boolean => JOB_ID.test(value);

/** Canonical job URL without tracking parameters. Throws for anything that is not a plain numeric id. */
export function jobUrl(id: string): string {
  if (!isJobId(id)) throw new RangeError('not a LinkedIn job id');
  return `https://www.linkedin.com/jobs/view/${id}/`;
}

export function geoId(geo: string): string {
  if (Object.hasOwn(GEO_PRESETS, geo)) return GEO_PRESETS[geo as keyof typeof GEO_PRESETS];
  if (/^\d{3,12}$/.test(geo)) return geo;
  throw new RangeError('unknown geo preset or id');
}

// ---------------------------------------------------------------------------------------------- card text

const NOISE = [
  /^promoted$/i,
  /^viewed$/i,
  /^easy apply$/i,
  /^be an early applicant$/i,
  /^actively (recruiting|hiring)$/i,
  /^\d+ (connections?|school alumni)/i,
  /^(.* )?\(verified job\)$/i,
];
const POSTED = /^(?:posted\s+)?(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago$/i;
const POSTED_FR = /^il y a (\d+)\s*(seconde|minute|heure|jour|semaine|mois)s?$/i;
const SALARY = /(EUR\s*\/\s*yr|€|\bk€|\bUSD\s*\/\s*yr|\bGBP\s*\/\s*yr|\/yr\b|\/an\b)/i;
const HOURS: Record<string, number> = {
  second: 1 / 3600,
  minute: 1 / 60,
  hour: 1,
  day: 24,
  week: 168,
  month: 720,
  seconde: 1 / 3600,
  heure: 1,
  jour: 24,
  semaine: 168,
  mois: 720,
};

/** `posted_hours_ago` from "20 minutes ago", "1 day ago", "il y a 3 semaines". Months count as 30 days. */
export function postedHoursAgo(text: string): number | null {
  const match = POSTED.exec(text.trim()) ?? POSTED_FR.exec(text.trim());
  if (match === null) return null;
  const unit = HOURS[(match[2] ?? '').toLowerCase()];
  if (unit === undefined) return null;
  return Math.round(Number(match[1]) * unit * 100) / 100;
}

export function workMode(location: string): WorkMode {
  const suffix = /\(([^)]*)\)\s*$/.exec(location)?.[1]?.toLowerCase().trim();
  if (suffix === undefined) return 'unknown';
  if (/^(remote|à distance|télétravail)$/.test(suffix)) return 'remote';
  if (/^(hybrid|hybride)$/.test(suffix)) return 'hybrid';
  if (/^(on-?site|sur site)$/.test(suffix)) return 'on-site';
  return 'unknown';
}

const clean = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Turn the visible lines of a card into a normalized card. Noise lines (Promoted, Viewed, Easy Apply...) become flags or
 * disappear; consecutive duplicate lines (the page repeats the title for accessibility) are dropped; the first three
 * remaining lines are title, company, location. Returns null when the card does not have those three lines: a card we
 * cannot read is reported by the caller as drift, never invented.
 */
export function parseCard(raw: RawCard): Card | null {
  if (!isJobId(raw.id)) return null;
  const lines: string[] = [];
  let promoted = false;
  let easyApply = false;
  let posted: string | null = null;
  let salary: string | null = null;
  for (const original of raw.lines) {
    const line = clean(original, 300);
    if (line === '') continue;
    if (/^promoted$/i.test(line)) promoted = true;
    if (/^easy apply$/i.test(line)) easyApply = true;
    if (posted === null && (POSTED.test(line) || POSTED_FR.test(line))) {
      posted = line;
      continue;
    }
    if (NOISE.some((pattern) => pattern.test(line))) continue;
    if (lines.length >= 3 && salary === null && SALARY.test(line)) {
      salary = line;
      continue;
    }
    if (lines[lines.length - 1] === line) continue;
    lines.push(line.replace(/\s*\(verified job\)\s*$/i, ''));
  }
  const [title, company, location] = lines;
  if (title === undefined || company === undefined || location === undefined) return null;
  // The salary can also sit inside the first lines of some cards: look in the remaining ones too.
  salary ??= lines.slice(3).find((line) => SALARY.test(line)) ?? null;
  return {
    id: raw.id,
    title: clean(title, 200),
    company: clean(company, 200),
    location: clean(location, 200),
    work_mode: workMode(location),
    salary_text: salary,
    posted_text: posted,
    posted_hours_ago: posted === null ? null : postedHoursAgo(posted),
    promoted,
    easy_apply: easyApply,
    url: jobUrl(raw.id),
  };
}

// Shared with the other job adapters: the disallowed-terms matcher and the stack/years/remote/salary hints live in the SDK.
export { extractHints, termMatcher } from '@jobwatch/sdk';
export type { Hints } from '@jobwatch/sdk';

// ---------------------------------------------------------------------------------------------- page state

export type PageVerdict = 'ok' | 'needs_login' | 'checkpoint';

/**
 * Decide from the URL path and the presence of a sign-in form whether LinkedIn is showing a login wall or a security
 * check. Only the path is looked at (never the query string, which can carry tokens).
 */
export function classifyPage(url: string, hasLoginForm: boolean): PageVerdict {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'ok';
  }
  if (/^\/(checkpoint|uas\/consumer-email-challenge|uas\/request-password-reset)(\/|$)/.test(path)) return 'checkpoint';
  if (/^\/(login|authwall|uas\/login|signup|uas\/authenticate)(\/|$)/.test(path) || hasLoginForm) return 'needs_login';
  return 'ok';
}
