import type { SearchArgs } from '../search';

/**
 * One LinkedIn search UI (07-adapter-linkedin.md, "Layouts"). LinkedIn served two in 2026-09/10: the AI `search-results`
 * page (B) and the classic `search` page (A, primary since 2026-10-01 when B returned "No results found").
 */
export interface SearchLayout {
  id: 'classic' | 'ai';
  /** The URL for validated arguments. Nothing but encoded keywords and numeric ids reaches the URL. */
  searchUrl(args: SearchArgs): string;
}
