import { isPublicHostname, type BoardAddress, type HttpClient } from '@jobwatch/sdk';

/** A Teamtailor handle is the company's subdomain: lower case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** One path segment of a careers site: no dots-only names, no encoded characters, no query-like text. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,59}$/;
const MAX_SEGMENTS = 6;

export interface ResolvedBoard extends BoardAddress {
  /** The host the board lives on. */
  host: string;
}

/**
 * The part of a careers-site path in front of the Teamtailor pages. Teamtailor serves `/jobs`, `/jobs/<id>-<slug>`, `/jobs.json`
 * and so on from its root, and a company can mount that root under a path of its own site (`www.acme.com/careers`). So the base
 * is everything in front of the first `jobs` segment, or the whole path when there is none (`/careers` -> `/careers`).
 * Returns null for a path with an odd segment (`..`, encoded characters, too deep).
 */
export function basePath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const cut = parts.findIndex((part) => part === 'jobs' || part === 'jobs.json' || part === 'jobs.rss');
  const base = cut === -1 ? parts : parts.slice(0, cut);
  if (base.length > MAX_SEGMENTS || !base.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..' && !/^\.+$/.test(part)))
    return null;
  return base.length === 0 ? '' : `/${base.join('/')}`;
}

/**
 * Work out where a company's job feed is from a handle (`bsport`) or from a URL of its careers site: `https://careers.bsport.io/`,
 * `https://careers.bsport.io/jobs/8429717-vp-of-engineering`, `https://www.acme.com/careers/jobs/12-dev`. The host and the path in
 * front of `/jobs` are kept (a careers site can live under a path of the company's own domain); the query, the fragment and
 * everything from `/jobs` on are dropped, so the request is always `<host><base>/jobs.json`. The page the caller named is kept as
 * `pageUrl`, so the feed can be found from it when this guess is wrong (`discoverFeed`). Returns null for anything else.
 */
export function resolveBoard(input: string): ResolvedBoard | null {
  const text = input.trim();
  if (HANDLE.test(text)) {
    const host = `${text}.teamtailor.com`;
    return { feedUrl: `https://${host}/jobs.json`, host, label: text };
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
  const base = basePath(url.pathname);
  if (base === null) return null;
  const onTeamtailor = host.endsWith('.teamtailor.com') && host.split('.').length === 3;
  return {
    feedUrl: `https://${host}${base}/jobs.json`,
    pageUrl: `https://${host}${url.pathname}`,
    host,
    label: onTeamtailor ? host.slice(0, -'.teamtailor.com'.length) : `${host}${base}`,
  };
}

/** `<link rel="alternate" type="application/rss+xml" href="https://careers.bsport.io/jobs.rss">`: every Teamtailor page has one. */
const LINK_TAG = /<link\b[^>]{0,600}>/gi;

/**
 * The feed address a Teamtailor page advertises about itself, as `.../jobs.json`. Only an address on the SAME host as the page
 * counts (a page cannot send us to another site), over https, ending in `/jobs.rss` or `/jobs.json`, with a base path that
 * passes `basePath`. Returns null when the page advertises none.
 */
export function feedFromHtml(html: string, pageUrl: string): string | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  for (const tag of html.slice(0, 400_000).match(LINK_TAG) ?? []) {
    if (!/\brel\s*=\s*["']alternate["']/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']application\/(?:rss\+xml|feed\+json|json)["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']{1,500})["']/i.exec(tag)?.[1];
    if (href === undefined) continue;
    let target: URL;
    try {
      target = new URL(href.replace(/&amp;/g, '&'), page);
    } catch {
      continue;
    }
    if (target.protocol !== 'https:' || target.hostname !== page.hostname || target.port !== '' || target.username !== '') continue;
    if (!/\/jobs\.(?:rss|json)$/.test(target.pathname)) continue;
    const base = basePath(target.pathname);
    if (base === null) continue;
    return `https://${target.hostname}${base}/jobs.json`;
  }
  return null;
}

/** The second chance: read the page the caller named and take the feed it advertises. */
export async function discoverFeed(address: BoardAddress, http: HttpClient): Promise<BoardAddress | null> {
  if (address.pageUrl === undefined) return null;
  const response = await http.get(address.pageUrl, { timeoutMs: 20_000, headers: { accept: 'text/html' } });
  if (!response.ok) return null;
  const feedUrl = feedFromHtml(response.text, address.pageUrl);
  return feedUrl === null ? null : { feedUrl, label: address.label };
}

export { slugify as slug } from '@jobwatch/sdk';
