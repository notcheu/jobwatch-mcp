import { PAGE_SIZE, geoId, postedParam } from '../parse';
import type { SearchArgs } from '../search';
import type { SearchLayout } from './layout';

/** Layout A, the classic `/jobs/search/`. `f_TPR` and `start=` are unverified on this layout (V8): see 07. */
export const classicLayout: SearchLayout = {
  id: 'classic',
  searchUrl(args: SearchArgs): string {
    const params = [`keywords=${encodeURIComponent(args.keywords)}`, `geoId=${geoId(args.geo)}`, 'distance=0'];
    const posted = postedParam(args.posted_within);
    if (posted !== null) params.push(posted);
    if (args.page > 1) params.push(`start=${(args.page - 1) * PAGE_SIZE}`);
    return `https://www.linkedin.com/jobs/search/?${params.join('&')}`;
  },
};
