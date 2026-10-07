import type { BoardAddress } from '@jobwatch/sdk';

/** A SmartRecruiters company identifier (its "handle"): letters, digits, `-` and `_`. The case matters (`BoschGroup`). */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

export const apiBase = (handle: string): string => `https://api.smartrecruiters.com/v1/companies/${handle}`;

/**
 * Where a company's postings are, from an identifier (`BoschGroup`) or a URL of its SmartRecruiters page:
 * `https://jobs.smartrecruiters.com/BoschGroup`, `https://careers.smartrecruiters.com/BoschGroup/744000154142930-warehouse-coordinator`
 * or the API URL. Only the identifier is taken from a URL: the requests always go to `api.smartrecruiters.com`. Returns null for anything else.
 */
export function resolveBoard(input: string): BoardAddress | null {
  const text = input.trim();
  if (HANDLE.test(text)) return { feedUrl: `${apiBase(text)}/postings`, label: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let handle: string | undefined;
  if (url.hostname === 'jobs.smartrecruiters.com' || url.hostname === 'careers.smartrecruiters.com') handle = parts[0];
  else if (url.hostname === 'api.smartrecruiters.com') handle = parts[0] === 'v1' && parts[1] === 'companies' ? parts[2] : undefined;
  return handle !== undefined && HANDLE.test(handle) ? { feedUrl: `${apiBase(handle)}/postings`, label: handle } : null;
}
