import type { BoardAddress } from '@jobwatch/sdk';

/** A Workable account name (its "handle"): lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const apiUrl = (handle: string): string => `https://apply.workable.com/api/v1/widget/accounts/${handle}?details=true`;

/**
 * Where a company's jobs are, from an account name (`huggingface`) or a URL of its Workable page: `https://apply.workable.com/huggingface/`,
 * `https://apply.workable.com/huggingface/j/81B46579FE/`, `https://huggingface.workable.com` or the widget URL. Only the account is taken
 * from a URL: the request always goes to `apply.workable.com/api/v1/widget/accounts/<account>`. A job link (`/j/<code>` alone) names no
 * account, so it is refused. Returns null for anything else.
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
  if (url.hostname === 'apply.workable.com') {
    if (parts[0] === 'api') handle = parts[1] === 'v1' && parts[2] === 'widget' && parts[3] === 'accounts' ? parts[4] : undefined;
    else handle = parts[0] === 'j' ? undefined : parts[0];
  } else {
    const labels = url.hostname.split('.');
    if (labels.length === 3 && labels[1] === 'workable' && labels[2] === 'com' && labels[0] !== 'apply' && labels[0] !== 'www')
      handle = labels[0];
  }
  return handle !== undefined && HANDLE.test(handle) ? { feedUrl: apiUrl(handle), label: handle } : null;
}
