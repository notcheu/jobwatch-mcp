import type { BoardAddress } from '@jobwatch/sdk';

/** A Recruitee subdomain (its "handle"): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const apiUrl = (handle: string): string => `https://${handle}.recruitee.com/api/offers/`;

/**
 * Where a company's offers are, from a handle (`bunq`) or a URL of its Recruitee site: `https://bunq.recruitee.com`,
 * `https://bunq.recruitee.com/o/website-lead` or the API URL. Only the handle is taken from a URL: the request always goes to
 * `<handle>.recruitee.com/api/offers/`. A company's own domain (`careers.bunq.com`) is not followed. Returns null for anything else.
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
  const labels = url.hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'recruitee' || labels[2] !== 'com') return null;
  const handle = labels[0] ?? '';
  return HANDLE.test(handle) && handle !== 'api' ? { feedUrl: apiUrl(handle), label: handle } : null;
}
