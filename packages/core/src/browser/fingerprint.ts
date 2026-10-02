import { z } from '@jobwatch/sdk';

/** Evaluated in the single tab right after the browser is ready (docs/plans/05-browser-runtime.md, "Startup fingerprint self-check"). */
export const FINGERPRINT_SCRIPT = `() => ({
  webdriver: navigator.webdriver,
  userAgent: navigator.userAgent,
  languages: Array.from(navigator.languages),
  plugins: navigator.plugins.length,
  chrome: typeof window.chrome,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  globals: Object.keys(window).filter((key) => /playwright|^__pw|__playwright/i.test(key)),
})`;

const fingerprintSchema = z.object({
  webdriver: z.union([z.boolean(), z.undefined(), z.null()]),
  userAgent: z.string(),
  languages: z.array(z.string()),
  plugins: z.number(),
  chrome: z.string(),
  timezone: z.string(),
  globals: z.array(z.string()),
});
export type Fingerprint = z.infer<typeof fingerprintSchema>;

export interface FingerprintExpectations {
  /** Exact `navigator.languages` (the list copied from the everyday browser, G8). Unset = not checked. */
  languages?: readonly string[];
  timezone?: string;
}

export interface FingerprintResult {
  ok: boolean;
  /** One line per mismatch, safe to log (no personal data: it names the check, not the values, except for the language list the operator configured). */
  problems: string[];
}

/**
 * Compare what the page reports with what a normal, logged-in desktop Chrome would. A mismatch means LinkedIn may see an
 * automated browser, so the caller refuses LinkedIn calls (configurable). Only signals measured in spikes S4/S6 are checked.
 */
export function checkFingerprint(raw: unknown, expected: FingerprintExpectations = {}): FingerprintResult {
  const parsed = fingerprintSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: ['the fingerprint script returned an unexpected shape'] };
  const fp = parsed.data;
  const problems: string[] = [];
  if (fp.webdriver === true) problems.push('navigator.webdriver is true');
  if (/HeadlessChrome/i.test(fp.userAgent)) problems.push('the user agent says HeadlessChrome');
  if (fp.chrome !== 'object') problems.push('window.chrome is missing');
  if (fp.plugins < 1) problems.push('navigator.plugins is empty');
  if (fp.globals.length > 0) problems.push(`automation globals are present: ${fp.globals.slice(0, 5).join(', ')}`);
  if (
    expected.languages !== undefined &&
    (fp.languages.length !== expected.languages.length || fp.languages.some((l, i) => l !== expected.languages?.[i]))
  ) {
    problems.push('navigator.languages differs from the configured list');
  }
  if (expected.timezone !== undefined && fp.timezone !== expected.timezone)
    problems.push(`the time zone is ${fp.timezone}, expected ${expected.timezone}`);
  return { ok: problems.length === 0, problems };
}
