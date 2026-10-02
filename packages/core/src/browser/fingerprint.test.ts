import { describe, expect, it } from 'vitest';
import { FINGERPRINT_SCRIPT, checkFingerprint } from './fingerprint';

const good = {
  webdriver: false,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36',
  languages: ['fr-FR', 'en-GB', 'en-US'],
  plugins: 5,
  chrome: 'object',
  timezone: 'Europe/Paris',
  globals: [],
};

describe('checkFingerprint', () => {
  it('accepts what the reference host produced in spike S4 (real LinkedIn feed)', () => {
    expect(checkFingerprint(good)).toEqual({ ok: true, problems: [] });
  });

  it('accepts webdriver undefined or null (older Chrome)', () => {
    expect(checkFingerprint({ ...good, webdriver: undefined }).ok).toBe(true);
    expect(checkFingerprint({ ...good, webdriver: null }).ok).toBe(true);
  });

  it.each([
    [{ webdriver: true }, 'navigator.webdriver is true'],
    [{ userAgent: 'Mozilla/5.0 HeadlessChrome/154.0.0.0' }, 'HeadlessChrome'],
    [{ chrome: 'undefined' }, 'window.chrome is missing'],
    [{ plugins: 0 }, 'navigator.plugins is empty'],
    [{ globals: ['__playwright_binding__', '__pwInitScripts'] }, 'automation globals are present'],
  ])('flags %j', (patch, expected) => {
    const result = checkFingerprint({ ...good, ...patch });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain(expected);
  });

  it('checks the language list only when one is configured, order and length included', () => {
    const expected = { languages: ['fr-FR', 'en-GB', 'en-US'] };
    expect(checkFingerprint(good, expected).ok).toBe(true);
    expect(checkFingerprint({ ...good, languages: ['en-US', 'en'] }, expected).problems).toEqual([
      'navigator.languages differs from the configured list',
    ]);
    expect(checkFingerprint({ ...good, languages: ['en-GB', 'fr-FR', 'en-US'] }, expected).ok).toBe(false);
    expect(checkFingerprint({ ...good, languages: ['fr-FR', 'en-GB'] }, expected).ok).toBe(false);
    expect(checkFingerprint({ ...good, languages: ['x'] }).ok).toBe(true);
  });

  it('does not put the actual language list in the problem text', () => {
    expect(checkFingerprint({ ...good, languages: ['sv-SE'] }, { languages: ['fr-FR'] }).problems.join()).not.toContain('sv-SE');
  });

  it('checks the time zone when configured', () => {
    expect(checkFingerprint(good, { timezone: 'Europe/Paris' }).ok).toBe(true);
    expect(checkFingerprint({ ...good, timezone: 'UTC' }, { timezone: 'Europe/Paris' }).problems).toEqual([
      'the time zone is UTC, expected Europe/Paris',
    ]);
  });

  it('reports every problem at once', () => {
    expect(checkFingerprint({ ...good, webdriver: true, plugins: 0, chrome: 'undefined' }).problems).toHaveLength(3);
  });

  it('treats an unexpected shape as a failure, not as a pass', () => {
    for (const bad of [undefined, null, 'x', {}, { ...good, plugins: 'five' }, { ...good, languages: 'fr' }]) {
      expect(checkFingerprint(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        problems: ['the fingerprint script returned an unexpected shape'],
      });
    }
  });

  it('the script is a self-contained function expression that reads only the documented signals', () => {
    expect(FINGERPRINT_SCRIPT.trim().startsWith('() =>')).toBe(true);
    for (const signal of ['navigator.webdriver', 'navigator.languages', 'navigator.plugins', 'window.chrome', 'resolvedOptions'])
      expect(FINGERPRINT_SCRIPT).toContain(signal);
    expect(FINGERPRINT_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|document\.cookie|localStorage/);
    // it is valid JavaScript that evaluates to a function
    expect(typeof new Function(`return (${FINGERPRINT_SCRIPT})`)()).toBe('function');
  });
});
