import type { BoardAddress } from '@jobwatch/sdk';

/** A Personio subdomain (its "handle"): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const feedUrl = (handle: string): string => `https://${handle}.jobs.personio.de/xml`;

/**
 * Where a company's positions are, from a handle (`helpling`) or a URL of its Personio page: `https://helpling.jobs.personio.de`,
 * `https://helpling.jobs.personio.com/job/2798024` or the feed URL. Only the handle is taken from a URL: the request always goes to
 * `<handle>.jobs.personio.de/xml`. Returns null for anything else.
 */
export function resolveBoard(input: string): BoardAddress | null {
  const text = input.trim();
  if (HANDLE.test(text)) return { feedUrl: feedUrl(text), label: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const labels = url.hostname.split('.');
  if (labels.length !== 4 || labels[1] !== 'jobs' || labels[2] !== 'personio' || (labels[3] !== 'de' && labels[3] !== 'com')) return null;
  const handle = labels[0] ?? '';
  return HANDLE.test(handle) ? { feedUrl: feedUrl(handle), label: handle } : null;
}
