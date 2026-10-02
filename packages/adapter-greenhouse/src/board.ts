import type { BoardAddress } from '@jobwatch/sdk';

/** A Greenhouse board token (its "handle"): letters, digits, `-` and `_`. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

/** Hosts a Greenhouse board URL can have. Only the API host is ever requested; the others are just read for the handle. */
const BOARD_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards-api.greenhouse.io']);

const apiUrl = (handle: string): string => `https://boards-api.greenhouse.io/v1/boards/${handle}/jobs?content=true`;

/**
 * Where a company's job list is, from a handle (`algolia`) or a URL of its board: `https://boards.greenhouse.io/algolia`,
 * `https://job-boards.greenhouse.io/algolia/jobs/123`, `https://boards.greenhouse.io/embed/job_board?for=algolia` or the API URL.
 * Only the handle is taken from a URL; the request always goes to boards-api.greenhouse.io. Returns null for anything else.
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
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !BOARD_HOSTS.has(url.hostname))
    return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let handle: string | undefined;
  if (url.hostname === 'boards-api.greenhouse.io') handle = parts[0] === 'v1' && parts[1] === 'boards' ? parts[2] : undefined;
  else if (parts[0] === 'embed') handle = url.searchParams.get('for') ?? undefined;
  else handle = parts[0];
  return handle !== undefined && HANDLE.test(handle) ? { feedUrl: apiUrl(handle), label: handle } : null;
}
