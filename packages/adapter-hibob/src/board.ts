import type { BoardAddress } from '@jobwatch/sdk';

/** A HiBob careers subdomain (its "handle", also the `companyidentifier` the API asks for): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const apiUrl = (handle: string): string => `https://${handle}.careers.hibob.com/api/job-ad`;

/**
 * Where a company's job ads are, from a handle (`leboncoin`) or a URL of its HiBob careers site: `https://leboncoin.careers.hibob.com`,
 * `https://leboncoin.careers.hibob.com/jobs/<id>/apply` or the API URL. Only the handle is taken from a URL: the request always
 * goes to `<handle>.careers.hibob.com/api/job-ad`. A company's own domain is not followed. Returns null for anything else.
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
  if (labels.length !== 4 || labels[1] !== 'careers' || labels[2] !== 'hibob' || labels[3] !== 'com') return null;
  const handle = labels[0] ?? '';
  return HANDLE.test(handle) ? { feedUrl: apiUrl(handle), label: handle } : null;
}
