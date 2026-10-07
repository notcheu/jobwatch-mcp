import { JobwatchError } from '@jobwatch/sdk';
import { describe, expect, it } from 'vitest';
import { aiSearchResultsLayout } from './layouts/aiSearchResults';
import { classicLayout } from './layouts/classic';
import { classifyPage, geoParam, isJobId, jobUrl, parseCard, parseGeoAliases, postedParam, resolveGeo, workMode } from './parse';

describe('ids and urls', () => {
  it('accepts numeric job ids only', () => {
    expect(isJobId('4012345678')).toBe(true);
    for (const bad of ['', '12', 'abc123456', '123456789012345678', '../x', '4012345678?x=1']) expect(isJobId(bad)).toBe(false);
  });

  it('builds the canonical job url and refuses anything else', () => {
    expect(jobUrl('4012345678')).toBe('https://www.linkedin.com/jobs/view/4012345678/');
    expect(() => jobUrl('4012345678/../x')).toThrow(RangeError);
  });

  it('turns a numeric geo into a geoId and a place name into a location, and refuses what cannot be one', () => {
    expect(geoParam('987654')).toBe('geoId=987654');
    expect(geoParam('Berlin, Germany')).toBe('location=Berlin%2C%20Germany');
    expect(geoParam('São Paulo')).toBe('location=S%C3%A3o%20Paulo');
    expect(() => geoParam('x'.repeat(101))).toThrow(RangeError);
    expect(() => geoParam('a\nb')).toThrow(RangeError);
  });

  it('has no place built in: the argument, else LINKEDIN_DEFAULT_LOCATION, else a refusal that says what to set', () => {
    expect(resolveGeo('Austin, Texas', {})).toBe('Austin, Texas');
    expect(resolveGeo(undefined, { LINKEDIN_DEFAULT_LOCATION: 'Lisbon' })).toBe('Lisbon');
    expect(resolveGeo('Madrid', { LINKEDIN_DEFAULT_LOCATION: 'Lisbon' })).toBe('Madrid');
    expect(() => resolveGeo(undefined, {})).toThrow(/LINKEDIN_DEFAULT_LOCATION/);
    expect(() => resolveGeo('  ', {})).toThrow(JobwatchError);
  });

  it('knows only the aliases the operator gives (LINKEDIN_GEO_ALIASES)', () => {
    const env = { LINKEDIN_GEO_ALIASES: 'home=104246759, Nordics = 111222333, broken, bad=12' };
    expect(resolveGeo('home', env)).toBe('104246759');
    expect(resolveGeo('NORDICS', env)).toBe('111222333');
    expect(resolveGeo('bad', env)).toBe('bad'); // not a geoId: kept as a place name
    expect(resolveGeo('home', {})).toBe('home');
    expect([...parseGeoAliases(undefined)]).toEqual([]);
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

describe('classifyPage', () => {
  it('recognises checkpoints, login walls and normal pages', () => {
    expect(classifyPage('https://www.linkedin.com/checkpoint/challenge/abc', false)).toBe('checkpoint');
    expect(classifyPage('https://www.linkedin.com/login?x=1', false)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/uas/login', false)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/jobs/', true)).toBe('needs_login');
    expect(classifyPage('https://www.linkedin.com/jobs/', false)).toBe('ok');
  });
});

describe('date range', () => {
  it('maps each range to the LinkedIn f_TPR value and sends nothing for any time', () => {
    expect(postedParam('last_24_hours')).toBe('f_TPR=r86400');
    expect(postedParam('past_week')).toBe('f_TPR=r604800');
    expect(postedParam('past_month')).toBe('f_TPR=r2592000');
    expect(postedParam('any')).toBeNull();
  });

  it.each([
    ['classic', classicLayout],
    ['ai', aiSearchResultsLayout],
  ])('puts it in the %s search url, with the geo and the page offset', (_name, layout) => {
    const base = { keywords: ['full stack'], geo: '104246759', remote_only: false, page: 3, max_results: 25 } as const;
    const week = layout.searchUrl({ ...base, posted_within: 'past_week' });
    expect(week).toContain('f_TPR=r604800');
    expect(week).toContain('geoId=104246759');
    expect(layout.searchUrl({ ...base, geo: 'Berlin, Germany', posted_within: 'any' })).toContain('location=Berlin%2C%20Germany');
    expect(week).toContain('start=50');
    expect(layout.searchUrl({ ...base, posted_within: 'any' })).not.toContain('f_TPR');
    expect(layout.searchUrl({ ...base, posted_within: 'past_month' })).toContain('f_TPR=r2592000');
  });

  it.each([
    ['classic', classicLayout],
    ['ai', aiSearchResultsLayout],
  ])('joins the keywords with LinkedIn OR on the %s layout, never AND', (_name, layout) => {
    const base = { geo: '1234', posted_within: 'any', remote_only: false, page: 1, max_results: 25 } as const;
    const url = new URL(layout.searchUrl({ ...base, keywords: ['react', 'vue native', 'svelte'] }));
    expect(url.searchParams.get('keywords')).toBe('react OR vue native OR svelte');
    expect(new URL(layout.searchUrl({ ...base, keywords: ['react'] })).searchParams.get('keywords')).toBe('react');
  });

  it('asks LinkedIn for remote jobs (f_WT=2) on the classic layout only', () => {
    const base = { keywords: ['x'], geo: '1234', posted_within: 'any', page: 1, max_results: 25 } as const;
    expect(classicLayout.searchUrl({ ...base, remote_only: true })).toContain('f_WT=2');
    expect(classicLayout.searchUrl({ ...base, remote_only: false })).not.toContain('f_WT');
    expect(aiSearchResultsLayout.searchUrl({ ...base, remote_only: true })).not.toContain('f_WT');
  });
});
