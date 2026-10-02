import { describe, expect, it } from 'vitest';
import { findJobPosting, jobId, jobUrl, parseCard, parseFrenchDate, parseJobUrl, postingDescription, postingLocation } from './parse';

describe('job URLs and ids', () => {
  it('accepts only WTTJ job URLs and reads the company and the offer', () => {
    expect(parseJobUrl('/fr/companies/illuin-tech/jobs/lead-software-engineer_paris?q=x')).toEqual({
      company: 'illuin-tech',
      offer: 'lead-software-engineer_paris',
    });
    expect(parseJobUrl('https://www.welcometothejungle.com/fr/companies/acme/jobs/e9355966-7f9e-4ebc-8e21-33a2568fc3c7/')).toEqual({
      company: 'acme',
      offer: 'e9355966-7f9e-4ebc-8e21-33a2568fc3c7',
    });
  });

  it.each([
    'http://www.welcometothejungle.com/fr/companies/acme/jobs/x',
    'https://www.welcometothejungle.com:8443/fr/companies/acme/jobs/x',
    'https://user@www.welcometothejungle.com/fr/companies/acme/jobs/x',
    'https://welcometothejungle.com/fr/companies/acme/jobs/x',
    'https://www.welcometothejungle.com.evil.example/fr/companies/acme/jobs/x',
    'https://www.welcometothejungle.com/en/companies/acme/jobs/x',
    'https://www.welcometothejungle.com/fr/companies/acme/jobs',
    'https://www.welcometothejungle.com/fr/companies/acme/jobs/x/apply',
    'https://www.welcometothejungle.com/fr/companies/Acme Corp/jobs/x',
    'https://www.welcometothejungle.com/fr/jobs-matches',
    'not a url',
  ])('refuses %j', (url) => {
    expect(parseJobUrl(url)).toBeNull();
  });

  it('builds the canonical URL from a reference, never from anything else', () => {
    expect(jobUrl({ company: 'acme', offer: 'dev_paris' })).toBe('https://www.welcometothejungle.com/fr/companies/acme/jobs/dev_paris');
  });

  it('makes ids that fit the store, tell companies apart, and stay stable when shortened', () => {
    const a = jobId({ company: 'acme', offer: 'lead-software-engineer_paris' });
    const b = jobId({ company: 'beta', offer: 'lead-software-engineer_paris' });
    expect(a).toBe('acme__lead-software-engineer_paris');
    expect(a).not.toBe(b);
    const long = {
      company: 'a-very-long-company-name-indeed',
      offer: 'an-extremely-long-offer-slug_with-a-city-and-more-and-more-words-here-and-even-more-words-after-that',
    };
    expect(jobId(long)).toHaveLength(64);
    expect(jobId(long)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(jobId(long)).toBe(jobId({ ...long }));
    expect(jobId({ ...long, offer: `${long.offer}-2` })).not.toBe(jobId(long));
  });
});

describe('parseFrenchDate', () => {
  const now = Date.UTC(2026, 9, 2, 12);
  it('reads a full date and the relative forms', () => {
    expect(parseFrenchDate('9 février 2026', now)).toBe('2026-02-09T12:00:00.000Z');
    expect(parseFrenchDate('1 août 2026', now)).toBe('2026-08-01T12:00:00.000Z');
    expect(parseFrenchDate('il y a 3 jours', now)).toBe(new Date(now - 3 * 86_400_000).toISOString());
    expect(parseFrenchDate('il y a 4 heures', now)).toBe(new Date(now - 4 * 3_600_000).toISOString());
    expect(parseFrenchDate('il y a 2 mois', now)).toBe(new Date(now - 60 * 86_400_000).toISOString());
  });
  it('returns null for anything else', () => {
    for (const text of ['', 'Paris', '110 collaborateurs', '31 smarch 2026', 'hier']) expect(parseFrenchDate(text, now)).toBeNull();
  });
});

describe('parseCard', () => {
  const href = '/fr/companies/kanbios/jobs/lead-data-engineer_paris';
  const full = [
    'Lead Data Engineer',
    'Groupe Kanbios',
    'Transformations digitales, data et humaines pour organisations.',
    'CDI',
    'Télétravail fréquent',
    '60K à 75K € par an',
    'Paris',
    '110 collaborateurs',
    'Conseil / Audit',
    'Enregistrer',
    'Pas pour moi',
    '9 février 2026',
  ];

  it('reads the layout seen on the site, recognising lines by what they say', () => {
    expect(parseCard({ href, lines: full })).toEqual({
      id: 'kanbios__lead-data-engineer_paris',
      company_slug: 'kanbios',
      offer: 'lead-data-engineer_paris',
      title: 'Lead Data Engineer',
      company: 'Groupe Kanbios',
      tagline: 'Transformations digitales, data et humaines pour organisations.',
      contract: 'CDI',
      remote_policy: 'Télétravail fréquent',
      salary_text: '60K à 75K € par an',
      location: 'Paris',
      company_size: '110 collaborateurs',
      posted_at: '2026-02-09T12:00:00.000Z',
      url: 'https://www.welcometothejungle.com/fr/companies/kanbios/jobs/lead-data-engineer_paris',
    });
  });

  it('copes with a missing salary, a missing tagline and the buttons anywhere', () => {
    const noSalary = full.filter((line) => !line.includes('€'));
    expect(parseCard({ href, lines: noSalary })).toMatchObject({
      salary_text: null,
      location: 'Paris',
      contract: 'CDI',
      posted_at: '2026-02-09T12:00:00.000Z',
    });
    const noTagline = full.filter((line) => !line.startsWith('Transformations'));
    expect(parseCard({ href, lines: noTagline })).toMatchObject({ tagline: null, location: 'Paris' });
    const reordered = [...full.slice(0, 9), 'Pas pour moi', 'Enregistrer', full[11] as string];
    expect(parseCard({ href, lines: reordered })).toMatchObject({ location: 'Paris', posted_at: '2026-02-09T12:00:00.000Z' });
  });

  it('turns a relative date into an absolute one and never keeps a button as a field', () => {
    const card = parseCard({ href, lines: [...full.slice(0, 11), 'il y a 3 jours'] }, Date.UTC(2026, 9, 2, 12));
    expect(card?.posted_at).toBe(new Date(Date.UTC(2026, 9, 2, 12) - 3 * 86_400_000).toISOString());
    expect(JSON.stringify(card)).not.toMatch(/Enregistrer|Pas pour moi/);
  });

  it('refuses a card whose link is not a job or that has no title and company', () => {
    expect(parseCard({ href: '/fr/companies/kanbios', lines: full })).toBeNull();
    expect(parseCard({ href: 'https://evil.example/fr/companies/a/jobs/b', lines: full })).toBeNull();
    expect(parseCard({ href, lines: ['Only a title'] })).toBeNull();
    expect(parseCard({ href, lines: [] })).toBeNull();
  });
});

describe('the JobPosting in the page', () => {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Lead Software Engineer (F/H)',
    description: "<h4>Descriptif</h4><p>React &amp; TypeScript.</p><ul><li>5 ans d'expérience</li></ul>",
    datePosted: '2026-08-03T00:00:39Z',
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: 'ILLUIN TECHNOLOGY' },
    jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Paris', postalCode: '75001' } }],
  };

  it('finds it among other blocks, in a list or a graph', () => {
    const faq = JSON.stringify({ '@type': 'FAQPage', mainEntity: [] });
    expect(findJobPosting([faq, JSON.stringify(posting)])?.title).toBe('Lead Software Engineer (F/H)');
    expect(findJobPosting([JSON.stringify([faq, posting])])?.title).toBe('Lead Software Engineer (F/H)');
    expect(findJobPosting([JSON.stringify({ '@graph': [faq, posting] })])?.title).toBe('Lead Software Engineer (F/H)');
  });

  it('returns null when there is none, or when the blocks are broken', () => {
    expect(findJobPosting([])).toBeNull();
    expect(findJobPosting(['{not json', JSON.stringify({ '@type': 'FAQPage' })])).toBeNull();
    expect(findJobPosting([JSON.stringify({ '@type': 'JobPosting', title: 5 })])).toBeNull();
  });

  it('turns the description into plain text and names the place', () => {
    const parsed = findJobPosting([JSON.stringify(posting)]);
    if (parsed === null) throw new Error('no posting');
    expect(postingDescription(parsed)).toBe("Descriptif\nReact & TypeScript.\n\n- 5 ans d'expérience");
    expect(postingLocation(parsed)).toBe('Paris');
    expect(postingLocation({ ...parsed, jobLocation: { address: { addressLocality: 'Lyon' } } })).toBe('Lyon');
    expect(postingLocation({ ...parsed, jobLocation: null })).toBeNull();
  });
});
