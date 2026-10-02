import { HostNotAllowedError } from './errors';

const BARE_HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A bare, lowercase DNS name such as `www.apec.fr`: no scheme, port, path, wildcard or IP literal. */
export function isBareHostname(value: string): boolean {
  return BARE_HOSTNAME.test(value);
}

/** Remove everything that can carry secrets from a URL for logs and error messages (userinfo, query, fragment). */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

const WILDCARD_HOST = /^\*\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `*.teamtailor.com`: any ONE label in front of a registrable suffix that itself has at least two labels (never `*.com`). */
export function isWildcardHost(value: string): boolean {
  return WILDCARD_HOST.test(value) && value.slice(2).includes('.');
}

/** An `allowedHosts` entry: a bare hostname, or a one-label wildcard suffix. */
export function isHostEntry(value: string): boolean {
  return isBareHostname(value) || isWildcardHost(value);
}

const NOT_PUBLIC_SUFFIX = /\.(local|localhost|internal|lan|home|home\.arpa|corp|intranet|private|test|invalid|example)$/;

/**
 * True for a name that could be a public website: a bare DNS name that is not a single label, not an IP literal, and not one of
 * the suffixes that only exist on private networks. This is a first filter on the NAME; the HTTP client also checks the
 * addresses it resolves to.
 */
export function isPublicHostname(value: string): boolean {
  return isBareHostname(value) && !NOT_PUBLIC_SUFFIX.test(value);
}

/** How a hostname relates to an adapter's `allowedHosts`: listed exactly, matched by a wildcard suffix, or neither. */
export function matchHost(hostname: string, allowedHosts: readonly string[]): 'exact' | 'wildcard' | null {
  if (allowedHosts.includes(hostname)) return 'exact';
  for (const entry of allowedHosts) {
    if (!entry.startsWith('*.')) continue;
    const suffix = entry.slice(1); // ".teamtailor.com"
    if (hostname.endsWith(suffix)) {
      const label = hostname.slice(0, -suffix.length);
      if (label !== '' && !label.includes('.')) return 'wildcard';
    }
  }
  return null;
}

/**
 * Where a URL stands: `listed` (https, default port, no credentials, host exactly or by one-label wildcard in `allowedHosts`),
 * `open` (the same URL rules, any other PUBLIC-looking host, only when `openHttps` is set), or `null` (refused).
 */
export function classifyUrl(value: string, allowedHosts: readonly string[], openHttps = false): 'listed' | 'open' | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (matchHost(url.hostname, allowedHosts) !== null) return 'listed';
  return openHttps && isPublicHostname(url.hostname) ? 'open' : null;
}

/**
 * True when the URL may be requested by an adapter: `https` only, no credentials in the URL, default port, and a hostname that
 * is listed in `allowedHosts` (exactly, or by a one-label wildcard such as `*.teamtailor.com`), or, with `openHttps`, any
 * public-looking host.
 */
export function isUrlAllowed(value: string, allowedHosts: readonly string[], openHttps = false): boolean {
  return classifyUrl(value, allowedHosts, openHttps) !== null;
}

/** Throws `HostNotAllowedError` unless `isUrlAllowed`. Returns the parsed URL. */
export function assertUrlAllowed(value: string, allowedHosts: readonly string[], openHttps = false): URL {
  if (!isUrlAllowed(value, allowedHosts, openHttps)) {
    let host = '[invalid url]';
    try {
      host = new URL(value).host;
    } catch {
      // keep the placeholder
    }
    throw new HostNotAllowedError(host);
  }
  return new URL(value);
}
