import { htmlToText, z } from '@jobwatch/sdk';

export const HOST = 'www.welcometothejungle.com';
export const MATCHES_URL = `https://${HOST}/fr/jobs-matches`;

/** `https://www.welcometothejungle.com/fr/companies/<company>/jobs/<offer>`: the only job URLs this adapter builds or accepts. */
const JOB_PATH = /^\/fr\/companies\/([a-z0-9][a-z0-9-]{0,80})\/jobs\/([A-Za-z0-9][A-Za-z0-9_-]{0,120})\/?$/;

export interface JobRef {
  company: string;
  offer: string;
}

export function parseJobUrl(value: string): JobRef | null {
  let url: URL;
  try {
    url = new URL(value, `https://${HOST}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const match = JOB_PATH.exec(url.pathname);
  return match?.[1] !== undefined && match[2] !== undefined ? { company: match[1], offer: match[2] } : null;
}

export const jobUrl = (ref: JobRef): string => `https://${HOST}/fr/companies/${ref.company}/jobs/${ref.offer}`;

/** FNV-1a, 32 bits: a short, stable fingerprint for ids that would be too long. Not for security. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The id a job is stored under: the company AND the offer (an offer slug such as `lead-software-engineer_paris` is only unique
 * within its company), at most 64 characters of `[A-Za-z0-9_-]`. A long one keeps its beginning and ends with a fingerprint.
 */
export function jobId(ref: JobRef): string {
  const whole = `${ref.company}__${ref.offer}`;
  return whole.length <= 64 ? whole : `${whole.slice(0, 55)}_${fingerprint(whole)}`;
}

// ---------------------------------------------------------------------------------------------- matches cards

export interface RawCard {
  href: string;
  lines: string[];
}

export interface Card {
  id: string;
  company_slug: string;
  offer: string;
  title: string;
  company: string;
  tagline: string | null;
  contract: string | null;
  remote_policy: string | null;
  salary_text: string | null;
  location: string | null;
  company_size: string | null;
  posted_at: string | null;
  url: string;
}

const CONTRACT = /^(CDI|CDD|Stage|Alternance|Freelance|Intérim|Temps partiel|Temps plein|VIE|Autre)\b/i;
const REMOTE = /t[ée]l[ée]travail|remote|hybride|sur site/i;
const SALARY = /€|k€|\bK\b.*(par an|\/an)/i;
const SIZE = /collaborateurs?|employ[ée]s?/i;
const BUTTONS = /^(Enregistrer|Sauvegard[ée]|Pas pour moi|Postuler|Voir plus)$/i;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** `9 février 2026` or `il y a 3 jours`, as an ISO time (midday UTC for a date, `now` minus the span for a relative one). */
export function parseFrenchDate(text: string, now = Date.now()): string | null {
  const full = /^(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})$/i.exec(text.trim());
  if (full?.[1] !== undefined && full[2] !== undefined && full[3] !== undefined) {
    const month = MONTHS.indexOf(full[2].toLowerCase());
    return month === -1 ? null : new Date(Date.UTC(Number(full[3]), month, Number(full[1]), 12)).toISOString();
  }
  const relative = /^il y a\s+(\d{1,3})\s+(minute|heure|jour|semaine|mois|an)s?$/i.exec(text.trim());
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const unit = {
      minute: 60_000,
      heure: 3_600_000,
      jour: 86_400_000,
      semaine: 7 * 86_400_000,
      mois: 30 * 86_400_000,
      an: 365 * 86_400_000,
    }[relative[2].toLowerCase() as 'minute'];
    return new Date(now - Number(relative[1]) * unit).toISOString();
  }
  return null;
}

/**
 * Read a match card from its text lines. The layout seen on 2026-10-02 is: title, company, the company's tagline, contract,
 * remote policy, an optional salary, the city, the company size, the sector, two buttons, and the date. The lines are recognised by
 * what they say, not by their position, so an absent salary or a reordered block does not shift the others. Returns null when the
 * link is not a WTTJ job or there is no title and company.
 */
export function parseCard(raw: RawCard, now = Date.now()): Card | null {
  const ref = parseJobUrl(raw.href);
  const lines = raw.lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const title = lines[0];
  const company = lines[1];
  if (ref === null || title === undefined || company === undefined) return null;
  const rest = lines.slice(2).filter((line) => !BUTTONS.test(line));
  const date = [...rest]
    .reverse()
    .map((line) => ({ line, iso: parseFrenchDate(line, now) }))
    .find((entry) => entry.iso !== null);
  const body = rest.filter((line) => line !== date?.line);
  const contract = body.find((line) => CONTRACT.test(line)) ?? null;
  const remote = body.find((line) => REMOTE.test(line) && line !== contract) ?? null;
  const salary = body.find((line) => SALARY.test(line)) ?? null;
  const size = body.find((line) => SIZE.test(line)) ?? null;
  const known = new Set([contract, remote, salary, size]);
  // The tagline is the long free-text line right after the company; the city is the first short remaining line after the contract block.
  const tagline = body[0] !== undefined && !known.has(body[0]) ? body[0] : null;
  const afterContract = body
    .slice(Math.max(0, contract === null ? 0 : body.indexOf(contract)) + 1)
    .filter((line) => !known.has(line) && line !== tagline);
  const location = afterContract[0] ?? null;
  return {
    id: jobId(ref),
    company_slug: ref.company,
    offer: ref.offer,
    title,
    company,
    tagline,
    contract,
    remote_policy: remote,
    salary_text: salary,
    location,
    company_size: size,
    posted_at: date?.iso ?? null,
    url: jobUrl(ref),
  };
}

// ---------------------------------------------------------------------------------------------- job page

const place = z.object({
  address: z
    .object({
      addressLocality: z.string().nullish(),
      postalCode: z.string().nullish(),
      addressCountry: z.unknown().optional(),
      streetAddress: z.string().nullish(),
    })
    .nullish(),
});

/** The `JobPosting` WTTJ embeds in its job pages as JSON-LD: the most stable source on the page. */
export const jobPostingSchema = z.object({
  title: z.string().nullish(),
  description: z.string().nullish(),
  datePosted: z.string().nullish(),
  validThrough: z.string().nullish(),
  employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
  jobLocation: z.union([place, z.array(place)]).nullish(),
});
export type JobPosting = z.infer<typeof jobPostingSchema>;

/** Pick the `JobPosting` out of the page's JSON-LD blocks (each a JSON text), or null. */
export function findJobPosting(blocks: readonly string[]): JobPosting | null {
  for (const block of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(block);
    } catch {
      continue;
    }
    const nodes = Array.isArray(json)
      ? json
      : typeof json === 'object' && json !== null && '@graph' in json && Array.isArray(json['@graph'])
        ? json['@graph']
        : [json];
    for (const node of nodes) {
      if (typeof node === 'object' && node !== null && '@type' in node && node['@type'] === 'JobPosting') {
        const parsed = jobPostingSchema.safeParse(node);
        if (parsed.success) return parsed.data;
      }
    }
  }
  return null;
}

export const postingDescription = (posting: JobPosting): string => htmlToText(posting.description ?? '').slice(0, 20_000);

export function postingLocation(posting: JobPosting): string | null {
  const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
  const names = places.map((entry) => entry.address?.addressLocality?.trim()).filter((name): name is string => !!name);
  return names.length === 0 ? null : [...new Set(names)].join('; ');
}
