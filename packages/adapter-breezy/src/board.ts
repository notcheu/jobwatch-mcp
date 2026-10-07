import type { BoardAddress } from '@jobwatch/sdk';

/** A Breezy HR subdomain (its "handle"): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const feedUrl = (handle: string): string => `https://${handle}.breezy.hr/json`;

/**
 * Where a company's positions are, from a handle (`rhynocare`) or a URL of its Breezy page: `https://rhynocare.breezy.hr`,
 * `https://rhynocare.breezy.hr/p/342b815596f0-dietary-aide` or the feed URL. Only the handle is taken from a URL: the requests always
 * go to `<handle>.breezy.hr`. A company's own domain is not followed. Returns null for anything else.
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
  if (labels.length !== 3 || labels[1] !== 'breezy' || labels[2] !== 'hr') return null;
  const handle = labels[0] ?? '';
  return HANDLE.test(handle) && handle !== 'www' && handle !== 'app' ? { feedUrl: feedUrl(handle), label: handle } : null;
}
