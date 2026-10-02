import { isPublicHostname } from '@jobwatch/sdk';

/** A Teamtailor handle is the company's subdomain: lower case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ResolvedBoard {
  /** What the caller passed. */
  input: string;
  /** The feed to read: `https://<host>/jobs.json`. */
  feedUrl: string;
  /** The host the board lives on. */
  host: string;
  /** The handle when the board is on `*.teamtailor.com`; the host itself for a company's own domain. */
  label: string;
}

/**
 * Work out where a company's job feed is from a handle (`bsport`) or from any URL of its careers site
 * (`https://careers.bsport.io/`, `https://bsport.teamtailor.com/jobs/8429717-vp-of-engineering`). Only the host of a URL is used:
 * the path, query and fragment are dropped, so nothing the caller sends can steer the request to another page of the site.
 * Returns null for anything else (not a handle, not an https URL, a host that cannot be public).
 */
export function resolveBoard(input: string): ResolvedBoard | null {
  const text = input.trim();
  if (HANDLE.test(text)) {
    const host = `${text}.teamtailor.com`;
    return { input: text, feedUrl: `https://${host}/jobs.json`, host, label: text };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname;
  if (!isPublicHostname(host)) return null;
  const onTeamtailor = host.endsWith('.teamtailor.com') && host.split('.').length === 3;
  return { input: text, feedUrl: `https://${host}/jobs.json`, host, label: onTeamtailor ? host.slice(0, -'.teamtailor.com'.length) : host };
}

/** A short lower-case name for a company: `PayFit` -> `payfit`, `Le Bon Coin` -> `le-bon-coin`. Used as the board in the database. */
export function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
