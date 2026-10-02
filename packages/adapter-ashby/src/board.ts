import type { BoardAddress } from '@jobwatch/sdk';

/** An Ashby job board name (its "handle"): letters, digits, `.`, `-` and `_`. The exact spelling matters (`backmarket`, not `back-market`). */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

const apiUrl = (handle: string): string => `https://api.ashbyhq.com/posting-api/job-board/${handle}`;

/**
 * Where a company's postings are, from a handle (`pennylane`) or a URL of its Ashby page: `https://jobs.ashbyhq.com/pennylane`,
 * `https://jobs.ashbyhq.com/pennylane/<posting id>` or the API URL. Only the handle is taken from a URL: the request always goes
 * to api.ashbyhq.com. Returns null for anything else.
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
  if (url.hostname === 'jobs.ashbyhq.com') handle = parts[0];
  else if (url.hostname === 'api.ashbyhq.com') handle = parts[0] === 'posting-api' && parts[1] === 'job-board' ? parts[2] : undefined;
  return handle !== undefined && HANDLE.test(handle) ? { feedUrl: apiUrl(handle), label: handle } : null;
}
