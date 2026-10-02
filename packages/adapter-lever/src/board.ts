import type { BoardAddress } from '@jobwatch/sdk';

/** A Lever site name (its "handle"): letters, digits, `-` and `_`. The case matters (`Modjo`). */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

const apiUrl = (handle: string): string => `https://api.lever.co/v0/postings/${handle}?mode=json`;

/**
 * Where a company's postings are, from a handle (`swile`) or a URL of its Lever page: `https://jobs.lever.co/swile`,
 * `https://jobs.lever.co/swile/<posting id>` or the API URL. Only the handle is taken from a URL: the request always goes to
 * api.lever.co. Returns null for anything else.
 */
export function resolveBoard(input: string): BoardAddress | null {
  const text = input.trim();
  if (HANDLE.test(text)) return { feedUrl: apiUrl(text), label: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let handle: string | undefined;
  if (url.hostname === 'jobs.lever.co') handle = parts[0];
  else if (url.hostname === 'api.lever.co') handle = parts[0] === 'v0' && parts[1] === 'postings' ? parts[2] : undefined;
  return handle !== undefined && HANDLE.test(handle) ? { feedUrl: apiUrl(handle), label: handle } : null;
}
