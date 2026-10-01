import { PAGE_SIZE, geoId } from '../parse';
import type { SearchArgs } from '../search';
import type { SearchLayout } from './layout';

/** Layout A, the classic `/jobs/search/`. `f_TPR` and `start=` are unverified on this layout (V8): see 07. */
export const classicLayout: SearchLayout = {
  id: 'classic',
  searchUrl(args: SearchArgs): string {
    const params = [`keywords=${encodeURIComponent(args.keywords)}`, `geoId=${geoId(args.geo)}`, 'distance=0'];
    if (args.posted_within === '24h') params.push('f_TPR=r86400');
    if (args.page > 1) params.push(`start=${(args.page - 1) * PAGE_SIZE}`);
    return `https://www.linkedin.com/jobs/search/?${params.join('&')}`;
  },
};
