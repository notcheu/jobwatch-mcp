/**
 * Text helpers shared by the job adapters (LinkedIn, ATS boards, ...). Pure functions, no I/O.
 */

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive, whole-word matcher built from plain terms the caller sends with each call (there is no built-in list).
 * It is NOT a client-supplied regular expression: a pattern with catastrophic backtracking would freeze the whole router.
 * Whole-word matters: an unbounded "intern" matches "Internal Tools". A word boundary is "not a letter or digit on that
 * side", so ".NET" and "Vue.js" work. Returns the term that matched (as the caller wrote it), or null.
 */
export function termMatcher(terms: readonly string[]): (text: string) => string | null {
  const byLower = new Map<string, string>();
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length > 0 && !byLower.has(term.toLowerCase())) byLower.set(term.toLowerCase(), term);
  }
  if (byLower.size === 0) return () => null;
  const alternatives = [...byLower.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return (text) => {
    const hit = pattern.exec(text)?.[1];
    return hit === undefined ? null : (byLower.get(hit.toLowerCase()) ?? hit);
  };
}

const STACK: [string, RegExp][] = [
  ['react', /\bReact(?:\.js|JS)?\b/],
  ['next.js', /\bNext\.?js\b/i],
  ['typescript', /\bTypeScript\b/i],
  ['javascript', /\bJavaScript\b/i],
  ['angular', /\bAngular(?:JS)?\b/],
  ['vue', /\bVue(?:\.js)?\b|\bNuxt\b/], // case-sensitive: the French word "vue" is everywhere
  ['node.js', /\bNode(?:\.js)?\b/],
  ['java', /\bJava\b(?!\s*Script)/],
  ['kotlin', /\bKotlin\b/i],
  ['php', /\bPHP\b|\bSymfony\b/],
  ['python', /\bPython\b/i],
  ['svelte', /\bSvelte\b/i],
  ['graphql', /\bGraphQL\b/i],
  ['storybook', /\bStorybook\b/i],
  ['design-system', /\bdesign[- ]systems?\b/i],
  ['micro-frontends', /\bmicro[- ]?front-?ends?\b/i],
];
const YEARS = /(\d{1,2})\s*\+?\s*(?:ans|an|years?|yrs?)\b/gi;
const REMOTE = [
  /\bfull[- ]remote\b/i,
  /\bremote\b/i,
  /\bt[ée]l[ée]travail\b/i,
  /\bhybrid(?:e)?\b/i,
  /\b\d+\s*(?:jours?|days?)\s*(?:de\s*)?(?:t[ée]l[ée]travail|remote|on-?site|au bureau)/i,
];
const SALARY_UNIT = String.raw`(?:k\s*€|k€|K\s*EUR|€|EUR)`;
const SALARY_NUMBER = String.raw`\d[\d\s.,]{0,8}`;
const SALARY_IN_TEXT = new RegExp(
  `${SALARY_NUMBER}(?:\\s*${SALARY_UNIT})?\\s*(?:-|à|to)\\s*${SALARY_NUMBER}\\s*${SALARY_UNIT}|${SALARY_NUMBER}\\s*${SALARY_UNIT}`,
  'i',
);

export interface Hints {
  stack_hints: string[];
  years_hints: number[];
  remote_hints: string[];
  salary_text: string | null;
}

export function extractHints(description: string): Hints {
  const text = description.slice(0, 20_000);
  const years = new Set<number>();
  for (const match of text.matchAll(YEARS)) {
    const value = Number(match[1]);
    if (value >= 1 && value <= 30) years.add(value);
  }
  const remote = new Set<string>();
  for (const pattern of REMOTE) {
    const match = pattern.exec(text);
    if (match !== null) remote.add(match[0].toLowerCase());
  }
  return {
    stack_hints: STACK.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    years_hints: [...years].sort((a, b) => a - b).slice(0, 6),
    remote_hints: [...remote].slice(0, 6),
    salary_text: SALARY_IN_TEXT.exec(text)?.[0]?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- HTML, folding, dates, size

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ndash: '-',
  mdash: '-',
  hellip: '...',
  euro: '€',
  bull: '-',
  times: 'x',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  ocirc: 'ô',
  ucirc: 'û',
  ugrave: 'ù',
  icirc: 'î',
  iuml: 'ï',
  Eacute: 'É',
  Egrave: 'È',
  Agrave: 'À',
  Ccedil: 'Ç',
};

/** Decode the HTML entities that matter in job texts. Unknown entities are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,6})|#x([0-9a-fA-F]{1,5})|([a-zA-Z]{2,8}));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return ENTITIES[name] ?? whole;
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/**
 * HTML to readable plain text: block ends become line breaks, list items become dashes, tags go, entities are decoded.
 * Greenhouse sends its HTML entity-encoded (`&lt;p&gt;`), so entities are decoded first, then tags removed, then entities
 * again for the text that was double-encoded. Linear time: no nested quantifiers.
 */
export function htmlToText(html: string): string {
  const once = decodeEntities(html);
  const withBreaks = once
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|tr)\s*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]{0,500}>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lower case without accents, for "contains" matching ("Île-de-France" matches "ile-de-france"). */
export const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Substring match on any of `needles` (already folded); an empty list matches everything. Plain text, never a pattern. */
export function containsAny(haystack: string, needles: readonly string[]): boolean {
  if (needles.length === 0) return true;
  const text = fold(haystack);
  return needles.some((needle) => text.includes(needle));
}

/** How recent a posting must be. The same four values on every job tool. */
export const POSTED_WITHIN = ['last_24_hours', 'past_week', 'past_month', 'any'] as const;
export type PostedWithin = (typeof POSTED_WITHIN)[number];
const RANGE_MS: Record<Exclude<PostedWithin, 'any'>, number> = {
  last_24_hours: 24 * 3600 * 1000,
  past_week: 7 * 24 * 3600 * 1000,
  past_month: 30 * 24 * 3600 * 1000,
};

/** The earliest accepted time (ms since epoch) for a date range, or null for any time. */
export function postedCutoff(range: PostedWithin, now: number): number | null {
  return range === 'any' ? null : now - RANGE_MS[range];
}

/**
 * Keep items, in order, while their JSON stays within `maxBytes` (the first item is always kept). The rest are returned by id:
 * a result that is too big for one answer should hand back fewer items and name the others, not fail after the work is done.
 */
export function fitToBytes<T extends { id: string }>(items: readonly T[], maxBytes: number): { fit: T[]; rest: string[] } {
  const encoder = new TextEncoder();
  const fit: T[] = [];
  const rest: string[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length;
    if (rest.length === 0 && (fit.length === 0 || bytes + size <= maxBytes)) {
      fit.push(item);
      bytes += size;
    } else {
      rest.push(item.id);
    }
  }
  return { fit, rest };
}
