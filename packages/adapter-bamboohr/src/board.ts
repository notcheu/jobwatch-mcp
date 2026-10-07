import type { BoardAddress } from '@jobwatch/sdk';

/** A BambooHR subdomain (its "handle"): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Subdomains of bamboohr.com that are the vendor's own sites, not a customer's. */
const VENDOR = new Set(['www', 'api', 'app', 'help', 'documentation', 'status', 'blog', 'get', 'go', 'info', 'partners', 'marketplace']);

export const originOf = (handle: string): string => `https://${handle}.bamboohr.com`;

/**
 * Where a company's openings are, from a handle (`scribd`) or a URL of its BambooHR careers page: `https://scribd.bamboohr.com/careers`,
 * `https://scribd.bamboohr.com/careers/144` or `https://scribd.bamboohr.com/careers/list`. Only the handle is taken from a URL: the requests
 * always go to `<handle>.bamboohr.com`. A company's own domain is not followed. Returns null for anything else.
 */
export function resolveBoard(input: string): BoardAddress | null {
  const text = input.trim();
  const address = (handle: string): BoardAddress => ({ feedUrl: `${originOf(handle)}/careers/list`, label: handle });
  if (HANDLE.test(text) && !VENDOR.has(text)) return address(text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const labels = url.hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'bamboohr' || labels[2] !== 'com') return null;
  const handle = labels[0] ?? '';
  return HANDLE.test(handle) && !VENDOR.has(handle) ? address(handle) : null;
}
