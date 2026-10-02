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
