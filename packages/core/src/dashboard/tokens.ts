/** Characters per token the estimate starts from; to be calibrated against Claude's own usage figures (docs/plans/17-dashboard.md, D6). */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/**
 * Estimated tokens in a text the router sends to Claude. Claude's tokenizer is not available here and a count API would cost a
 * network call per result, so this is characters divided by a ratio. The same function is used for every call, which makes
 * comparisons between tools, `detail` levels and periods reliable even when the absolute figure is off by 10 to 20 %.
 */
export function estimateTokens(text: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
  if (text.length === 0) return 0;
  const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(text.length / ratio);
}

/**
 * How much job text a result carried: `available` is the full length of the descriptions the jobs have in the database,
 * `returned` the text actually put in the result (summary, description or stored text). The difference is what the `detail`
 * setting kept out of Claude's context. Reads the fields every job tool already returns; a result without jobs gives undefined.
 */
export function jobTextChars(structured: unknown): { available: number; returned: number } | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined;
  const jobs = (structured as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return undefined;
  let available = 0;
  let returned = 0;
  for (const job of jobs) {
    if (typeof job !== 'object' || job === null) continue;
    const fields = job as Record<string, unknown>;
    if (typeof fields['description_chars'] === 'number') available += fields['description_chars'];
    for (const key of ['summary', 'description', 'text']) if (typeof fields[key] === 'string') returned += (fields[key] as string).length;
  }
  return available === 0 && returned === 0 ? undefined : { available, returned };
}
