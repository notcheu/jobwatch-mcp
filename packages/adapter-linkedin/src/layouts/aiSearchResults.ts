import { PAGE_SIZE, geoId } from '../parse';
import type { SearchArgs } from '../search';
import type { SearchLayout } from './layout';

/**
 * Layout B, the AI `/jobs/search-results/`. Kept because LinkedIn may bring it back (it worked on 2026-09-30, then answered
 * "No results found" on 2026-10-01). The URL form is the one from the routine; the in-page script already reads its cards.
 */
export const aiSearchResultsLayout: SearchLayout = {
  id: 'ai',
  searchUrl(args: SearchArgs): string {
    const params = [`keywords=${encodeURIComponent(args.keywords)}`, `geoId=${geoId(args.geo)}`, 'distance=0.0'];
    if (args.posted_within === '24h') params.push('f_TPR=r86400');
    if (args.page > 1) params.push(`start=${(args.page - 1) * PAGE_SIZE}`);
    return `https://www.linkedin.com/jobs/search-results/?${params.join('&')}`;
  },
};
