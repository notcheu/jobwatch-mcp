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

/**
 * True when the URL may be requested by an adapter: `https` only, no credentials in the URL, default port,
 * and a hostname that EXACTLY equals one of `allowedHosts` (no subdomain or suffix matching).
 */
export function isUrlAllowed(value: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '') return false;
  return allowedHosts.includes(url.hostname);
}

/** Throws `HostNotAllowedError` unless `isUrlAllowed`. Returns the parsed URL. */
export function assertUrlAllowed(value: string, allowedHosts: readonly string[]): URL {
  if (!isUrlAllowed(value, allowedHosts)) {
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
