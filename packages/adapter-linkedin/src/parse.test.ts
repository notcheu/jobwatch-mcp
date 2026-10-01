import { describe, expect, it } from 'vitest';
import { classifyPage, extractHints, geoId, isJobId, jobUrl, parseCard, termMatcher, workMode } from './parse';

describe('ids and urls', () => {
  it('accepts numeric job ids only', () => {
    expect(isJobId('4012345678')).toBe(true);
    for (const bad of ['', '12', 'abc123456', '123456789012345678', '../x', '4012345678?x=1']) expect(isJobId(bad)).toBe(false);
  });

  it('builds the canonical job url and refuses anything else', () => {
    expect(jobUrl('4012345678')).toBe('https://www.linkedin.com/jobs/view/4012345678/');
    expect(() => jobUrl('4012345678/../x')).toThrow(RangeError);
  });

  it('resolves presets and numeric geo ids, nothing else (not even prototype keys)', () => {
    expect(geoId('paris_idf')).toBe('104246759');
    expect(geoId('987654')).toBe('987654');
    for (const bad of ['toString', 'constructor', 'paris', '12', '1;2']) expect(() => geoId(bad)).toThrow(RangeError);
  });
});

describe('parseCard', () => {
  const id = '4012345678';

  it('reads title, company, location, posted time and flags, ignoring noise', () => {
    const card = parseCard({
      id,
      lines: [
        'Senior Frontend Engineer',
        'Senior Frontend Engineer',
        'Acme',
        'Paris, Île-de-France (Hybrid)',
        'Promoted',
        'Easy Apply',
        '2 hours ago',
      ],
    });
    expect(card).toMatchObject({
      id,
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      location: 'Paris, Île-de-France (Hybrid)',
      work_mode: 'hybrid',
      promoted: true,
      easy_apply: true,
      posted_hours_ago: 2,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
    });
  });

  it('returns null for a card it cannot read, or for a bad id', () => {
    expect(parseCard({ id, lines: ['Only a title'] })).toBeNull();
    expect(parseCard({ id: 'nope', lines: ['a', 'b', 'c'] })).toBeNull();
  });

  it('detects work mode from the location suffix, in English and French', () => {
    expect(workMode('France (Remote)')).toBe('remote');
    expect(workMode('Paris (Hybride)')).toBe('hybrid');
    expect(workMode('Paris (On-site)')).toBe('on-site');
    expect(workMode('Paris')).toBe('unknown');
  });
});

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

describe('classifyPage', () => {
  it('recognises checkpoints, login walls and normal pages', () => {
    expect(classifyPage('https://www.linkedin.com/checkpoint/challenge/abc', false)).toBe('checkpoint');
    expect(classifyPage('https://www.linkedin.com/login?x=1', false)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/uas/login', false)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/jobs/', true)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/jobs/', false)).toBe('ok');
  });
});
