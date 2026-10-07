import { z } from 'zod';

/**
 * Search keywords, the same everywhere: a LIST, and a list means OR (any of them), never AND. A caller may still send one string that
 * holds several keywords with the OR separator of the platform (`react OR vue` on LinkedIn, `react | vue` on a company board): it is
 * split into the list before anything reads it, and the list is what is stored. `joinKeywords` writes it back with the separator the
 * platform's own search understands.
 */

/** How the OR of one platform is written in a single string. */
export interface KeywordSeparator {
  /** Splits a string into keywords. */
  split: RegExp;
  /** Joins keywords into the search text the platform takes. */
  join: string;
}

/** LinkedIn: `react OR vue` (the boolean operator must be upper case, so a lower-case "or" in a title stays a word). */
export const OR_SEPARATOR: KeywordSeparator = { split: /\s+OR\s+/, join: ' OR ' };
/** The company boards (Ashby, Greenhouse, Lever, Teamtailor): `react | vue`. */
export const PIPE_SEPARATOR: KeywordSeparator = { split: /\s*\|\s*/, join: ' | ' };

/** Reading keywords back (the call log, the history filters): either way of writing an OR splits them. Writing always uses a platform's own. */
export const ANY_SEPARATOR: KeywordSeparator = { split: /\s+OR\s+|\s*\|\s*/, join: ' | ' };

export const MAX_KEYWORDS = 10;
export const MAX_KEYWORD_CHARS = 100;

/** Trim, split every entry on the separator, drop empty ones and case-insensitive duplicates, keep the order. */
export function splitKeywords(value: string | readonly string[], separator: KeywordSeparator): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of typeof value === 'string' ? [value] : value) {
    for (const part of entry.split(separator.split)) {
      const keyword = part.replace(/\s+/g, ' ').trim();
      if (keyword === '' || seen.has(keyword.toLowerCase())) continue;
      seen.add(keyword.toLowerCase());
      out.push(keyword);
    }
  }
  return out;
}

/** The search text of a platform for a list of keywords (OR between them). */
export const joinKeywords = (keywords: readonly string[], separator: KeywordSeparator): string => keywords.join(separator.join);

/**
 * The input schema of a `keywords`-like argument: one string or a list of strings, any entry possibly holding the platform's OR
 * separator. The handler always gets a clean `string[]`. `max` counts keywords after the split; `allowEmpty` accepts an empty list
 * (a filter that is not used) where a search needs at least one keyword.
 */
export function keywordsSchema(separator: KeywordSeparator, options: { max?: number; maxChars?: number; allowEmpty?: boolean } = {}) {
  const max = options.max ?? MAX_KEYWORDS;
  const chars = options.maxChars ?? MAX_KEYWORD_CHARS;
  const min = options.allowEmpty === true ? 0 : 1;
  return z
    .union([
      z
        .string()
        .trim()
        .min(1)
        .max(chars * max),
      z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(chars * max),
        )
        .min(min)
        .max(max),
    ])
    .transform((value, ctx) => {
      const list = splitKeywords(value, separator);
      const long = list.find((keyword) => keyword.length > chars);
      if (list.length === 0 && min === 1) ctx.issues.push({ code: 'custom', message: 'give at least one keyword', input: value });
      else if (list.length > max)
        ctx.issues.push({ code: 'custom', message: `at most ${max} keywords (any of them matches)`, input: value });
      else if (long !== undefined) ctx.issues.push({ code: 'custom', message: `a keyword is at most ${chars} characters`, input: value });
      return list;
    });
}
