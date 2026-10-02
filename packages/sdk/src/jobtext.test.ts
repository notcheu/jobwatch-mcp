import { describe, expect, it } from 'vitest';
import { containsAny, extractHints, fitToBytes, fold, htmlToText, postedCutoff, termMatcher } from './jobtext';

describe('termMatcher', () => {
  it('matches whole words case-insensitively, returns the term as written, and never treats terms as a pattern', () => {
    const match = termMatcher(['intern', 'C++', '.*', '.NET', 'Full stack']);
    expect(match('Software INTERN')).toBe('intern');
    expect(match('International Lead')).toBeNull();
    expect(match('C++ developer')).toBe('C++');
    expect(match('Senior .NET engineer')).toBe('.NET');
    expect(match('full stack engineer')).toBe('Full stack');
    expect(match('Frontend developer')).toBeNull();
  });

  it('prefers the longer term and ignores blanks and duplicates', () => {
    const match = termMatcher(['Java', 'java', '  ', 'Java Spring']);
    expect(match('Java Spring developer')).toBe('Java Spring');
    expect(match('JavaScript developer')).toBeNull();
  });

  it('matches nothing for an empty list', () => {
    expect(termMatcher([])('anything')).toBeNull();
    expect(termMatcher([' '])('anything')).toBeNull();
  });

  it('survives a hostile term (no catastrophic backtracking)', () => {
    const match = termMatcher(['(a+)+$', 'a'.repeat(60)]);
    const started = Date.now();
    expect(match(`${'a'.repeat(5000)}!`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('extractHints', () => {
  it('finds stack, years, remote and salary hints', () => {
    const hints = extractHints('We use React, TypeScript and Vue. 5+ years of experience. 2 jours de télétravail. 60-70 k€ per year.');
    expect(hints.stack_hints).toEqual(expect.arrayContaining(['react', 'typescript', 'vue']));
    expect(hints.years_hints).toContain(5);
    expect(hints.remote_hints.length).toBeGreaterThan(0);
    expect(hints.salary_text).toMatch(/60/);
  });

  it('does not read "vue" the French word as the framework', () => {
    expect(extractHints('Une vue d’ensemble du produit').stack_hints).not.toContain('vue');
  });
});

describe('htmlToText', () => {
  it('turns block ends into line breaks and list items into dashes', () => {
    expect(htmlToText('<h5>About</h5><p>We build <strong>things</strong>.</p><ul><li>React</li><li>TypeScript</li></ul>')).toBe(
      'About\nWe build things.\n\n- React\n- TypeScript',
    );
  });

  it('decodes entity-encoded HTML (Greenhouse) and numeric entities', () => {
    expect(htmlToText('&lt;p&gt;Caf&eacute;&amp;nbsp;R&amp;D &#8364;60k&lt;/p&gt;')).toBe('Café R&D €60k');
    expect(htmlToText('a&nbsp;b &amp;amp; c')).toBe('a b & c'); // double-encoded text is decoded twice, on purpose
  });

  it('removes scripts-looking markup as plain tags and survives hostile input in linear time', () => {
    expect(htmlToText('<p>ok</p><script>alert(1)</script>')).toBe('ok\nalert(1)');
    const started = Date.now();
    htmlToText('<'.repeat(50_000) + 'a'.repeat(50_000));
    htmlToText('&' + '#'.repeat(50_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('fold and containsAny', () => {
  it('folds accents and case, and an empty list matches everything', () => {
    expect(fold('Île-de-France')).toBe('ile-de-france');
    expect(containsAny('Paris, FR', [])).toBe(true);
    expect(containsAny('Paris, FR', ['paris'])).toBe(true);
    expect(containsAny('Zürich', ['zurich'])).toBe(true);
    expect(containsAny('Paris, FR', ['lyon', 'berlin'])).toBe(false);
  });
});

describe('postedCutoff', () => {
  it('maps each range to a cutoff and any to none', () => {
    const now = Date.UTC(2026, 9, 2);
    expect(postedCutoff('any', now)).toBeNull();
    expect(postedCutoff('last_24_hours', now)).toBe(now - 86_400_000);
    expect(postedCutoff('past_week', now)).toBe(now - 7 * 86_400_000);
    expect(postedCutoff('past_month', now)).toBe(now - 30 * 86_400_000);
  });
});

describe('fitToBytes', () => {
  it('keeps what fits, always keeps the first, and names the rest', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, text: 'x'.repeat(100) }));
    const { fit, rest } = fitToBytes(items, 300);
    expect(fit.map((item) => item.id)).toEqual(['j0', 'j1']);
    expect(rest).toEqual(['j2', 'j3', 'j4']);
    expect(fitToBytes([{ id: 'big', text: 'x'.repeat(1000) }], 10).fit).toHaveLength(1);
    expect(fitToBytes([], 10)).toEqual({ fit: [], rest: [] });
  });
});
