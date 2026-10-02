import { describe, expect, it } from 'vitest';
import { extractHints, termMatcher } from './jobtext';

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
