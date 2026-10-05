import { isPublicHostname, slugify } from '@jobwatch/sdk';

/** The ATS this tool can recognise: the tools that read them take the handle it finds. */
export const ATS_IDS = ['greenhouse', 'lever', 'ashby', 'teamtailor'] as const;
export type AtsId = (typeof ATS_IDS)[number];

/** A handle on Greenhouse, Lever and Ashby. Teamtailor handles are subdomains: lower case only. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const validHandle = (ats: AtsId, handle: string): boolean => (ats === 'teamtailor' ? SUBDOMAIN : HANDLE).test(handle);

/** A handle read straight from the address of a board: the company is then known to be on that ATS. */
export interface KnownBoard {
  ats: AtsId;
  handle: string;
}

/** Labels of a company site that are not its name: `www.acme.com`, `careers.acme.com`. */
const SITE_PREFIXES = new Set(['www', 'careers', 'career', 'jobs', 'job', 'join', 'work', 'workwith', 'recruiting', 'talent', 'apply']);
/** Second-level labels of country domains (`acme.co.uk`): the name is the label before them. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne']);

const parseUrl = (input: string): URL | null => {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : /^[^\s/]+\.[a-z]{2,}(?:[/?#]|$)/i.test(input) ? `https://${input}` : null;
  if (text === null) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && isPublicHostname(url.hostname) ? url : null;
  } catch {
    return null;
  }
};

/** The board an ATS address points at (`https://jobs.lever.co/swile/123`), or null for any other address. */
export function knownBoard(input: string): KnownBoard | null {
  const url = parseUrl(input.trim());
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let found: KnownBoard | null = null;
  if (host === 'jobs.lever.co' && parts[0] !== undefined) found = { ats: 'lever', handle: parts[0] };
  else if (host === 'jobs.ashbyhq.com' && parts[0] !== undefined) found = { ats: 'ashby', handle: parts[0] };
  else if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const handle = parts[0] === 'embed' ? url.searchParams.get('for') : parts[0];
    if (handle) found = { ats: 'greenhouse', handle };
  } else if (host.endsWith('.teamtailor.com') && host.split('.').length === 3)
    found = { ats: 'teamtailor', handle: host.split('.')[0] ?? '' };
  return found !== null && validHandle(found.ats, found.handle) ? found : null;
}

/** The name label of a company site: `https://careers.acme.co.uk/jobs` -> `acme`. */
export function siteName(url: URL): string | null {
  const labels = url.hostname.toLowerCase().split('.');
  if (labels.length < 2) return null;
  let at = labels.length - 2;
  if (at > 0 && SECOND_LEVEL.has(labels[at] ?? '') && (labels[labels.length - 1] ?? '').length === 2) at -= 1;
  const label = labels[at] ?? '';
  return SITE_PREFIXES.has(label) ? null : label;
}

/**
 * The handles a company could have, best first: its name in a few spellings (`Société Générale` -> `societe-generale`,
 * `societegenerale`), or the name label of its site. At most `limit`. Handles are guesses: the caller checks each one.
 */
export function candidateHandles(input: string, limit: number): string[] {
  const text = input.trim();
  const url = parseUrl(text);
  const names: string[] = [];
  if (url !== null) {
    const name = siteName(url);
    if (name !== null) names.push(name);
  } else {
    const slug = slugify(text);
    names.push(slug, slug.replace(/-/g, ''));
    const first = slug.split('-')[0];
    if (first !== undefined && slug.includes('-')) names.push(first);
  }
  const unique = [...new Set(names.map((name) => name.toLowerCase()).filter((name) => name.length >= 2))];
  return unique.slice(0, limit);
}

/** The public page of a board, for a person to open. */
export const boardPage = (ats: AtsId, handle: string): string =>
  ({
    greenhouse: `https://boards.greenhouse.io/${handle}`,
    lever: `https://jobs.lever.co/${handle}`,
    ashby: `https://jobs.ashbyhq.com/${handle}`,
    teamtailor: `https://${handle}.teamtailor.com/jobs`,
  })[ats];

/** The tool that reads the board, and the argument to give it. */
export const readerTool = (ats: AtsId): string => `${ats}_jobs`;
