import { describe, expect, it } from 'vitest';
import { describeJob, partsOf, splitSections, summarizeJob } from './summary';

const english = `Acme is the retrieval layer for the web, trusted by thousands of companies since 2012.

What you'll do
- Own the design system used by 40 engineers
- Review code and mentor two junior developers
- Work with product and design every day

What we're looking for
- 5+ years of experience with React and TypeScript
- Experience with accessibility

Nice to have
- Storybook

Benefits
- Remote friendly
- Stock options

Equal opportunity employer
We welcome everyone.`;

const french = `Ornikar est la première auto-école en ligne.

Vos missions
- Définir la stratégie produit
- Animer l'équipe

Votre profil
- 3 ans d'expérience minimum
- Maîtrise de React

Avantages
- Mutuelle prise en charge`;

const german = `Doctolib digitalisiert das Gesundheitswesen.

Deine Verantwortung
- Du verantwortest den gesamten Vertrieb

Dein Profil
- Du hast 3 Jahre Erfahrung im Vertrieb

Das bieten wir
- Ein starkes Team`;

describe('splitSections', () => {
  it('cuts at the recognised headings and keeps the text before the first one as intro', () => {
    const sections = splitSections(english);
    expect(sections.map((s) => s.part)).toEqual(['intro', 'role', 'requirements', 'nice_to_have', 'offer', 'legal']);
    expect(sections[1]?.heading).toBe("What you'll do");
    expect(sections[1]?.text).toContain('Own the design system');
    expect(sections[0]?.text).toContain('retrieval layer');
  });

  it('recognises French and German headings', () => {
    expect(splitSections(french).map((s) => s.part)).toEqual(['intro', 'role', 'requirements', 'offer']);
    expect(splitSections(german).map((s) => s.part)).toEqual(['intro', 'role', 'requirements', 'offer']);
  });

  it('does not take a sentence or a bullet for a heading', () => {
    const text = 'Intro.\n- Experience with accessibility\nYou will work on experience design for customers every day.\nRequirements:\n- x';
    expect(splitSections(text).map((s) => s.part)).toEqual(['intro', 'requirements']);
  });

  it('treats a notice heading as legal, wherever it sits', () => {
    expect(splitSections('Intro\nImportant notice for candidates - recruitment fraud notice\nBeware.').map((s) => s.part)).toEqual([
      'intro',
      'legal',
    ]);
  });
});

describe('summarizeJob', () => {
  it('keeps the role and the requirements and leaves out the pitch, the benefits and the legal text', () => {
    const { summary, kind } = summarizeJob(english);
    expect(kind).toBe('sections');
    expect(summary).toMatch(/^Role: Own the design system used by 40 engineers; Review code/);
    expect(summary).toContain('Requirements: 5+ years of experience with React and TypeScript');
    expect(summary).not.toMatch(/retrieval layer|Stock options|Equal opportunity/);
    expect(summary.length).toBeLessThan(english.length / 2);
  });

  it('works in French and German', () => {
    expect(summarizeJob(french).summary).toMatch(/Role: Définir la stratégie produit.*Requirements: 3 ans/);
    expect(summarizeJob(german).summary).toMatch(/Role: Du verantwortest.*Requirements: Du hast 3 Jahre/);
  });

  it('respects the size, cuts at a boundary and ends with an ellipsis', () => {
    const long = `The role\n${'Build things that matter for our customers. '.repeat(100)}\nRequirements\n${'Know the stack well. '.repeat(100)}`;
    const { summary } = summarizeJob(long, 400);
    expect(summary.length).toBeLessThanOrEqual(430);
    expect(summary).toMatch(/…/);
    expect(summarizeJob(long, 5).summary.length).toBeGreaterThan(150); // a floor: 200
    expect(summarizeJob(long, 99_999).summary.length).toBeLessThanOrEqual(2050);
  });

  it('with only one of the two sections, uses that one', () => {
    expect(summarizeJob('Intro\nRequirements\n- React').summary).toBe('Requirements: React');
    expect(summarizeJob('Intro\nThe role\n- Lead the team').summary).toBe('Role: Lead the team');
  });

  it('without headings it is an excerpt, starting where the role seems to start rather than at the company pitch', () => {
    const pitch = 'We are a health insurance company founded in 2016 with a mission to change healthcare for good. '.repeat(6);
    const text =
      `${pitch}We are looking for an engineer to build our platform. You will own the billing service and mentor others. `.repeat(1) +
      'More details about the job follow here. '.repeat(20);
    const { summary, kind } = summarizeJob(text);
    expect(kind).toBe('excerpt');
    expect(summary.startsWith('We are looking for')).toBe(true);
    expect(summary).not.toMatch(/founded in 2016/);
  });

  it('without headings and without a cue it is the start of the text, and an empty text gives an empty summary', () => {
    expect(summarizeJob('Just a short ad.').summary).toBe('Just a short ad.');
    expect(summarizeJob('')).toMatchObject({ summary: '', kind: 'excerpt' });
  });

  it('lists the parts found with their size', () => {
    const { outline } = summarizeJob(english);
    expect(outline.map((o) => o.part)).toEqual(['intro', 'role', 'requirements', 'nice_to_have', 'offer', 'legal']);
    expect(outline.every((o) => o.chars > 0)).toBe(true);
  });

  it('is fast on hostile input', () => {
    const started = Date.now();
    summarizeJob('a'.repeat(200_000));
    summarizeJob(`${'Requirements\n- x\n'.repeat(20_000)}`);
    summarizeJob('as a ' + 'x'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('partsOf', () => {
  it('returns the text of the asked parts under their headings, and nothing for a part that is not there', () => {
    expect(partsOf(english, ['requirements'])).toBe(
      "What we're looking for\n- 5+ years of experience with React and TypeScript\n- Experience with accessibility",
    );
    expect(partsOf(english, ['role', 'nice_to_have'])).toContain('Nice to have\n- Storybook');
    expect(partsOf(english, ['process'])).toBe('');
  });
});

describe('describeJob', () => {
  const text = english;
  it('summary: a summary and no text', () => {
    expect(describeJob(text, 'summary', 3000)).toMatchObject({
      description: '',
      description_truncated: false,
      summary_kind: 'sections',
      description_chars: text.length,
    });
    expect(describeJob(text, 'summary', 3000).summary).toContain('Role:');
  });
  it('full: the text cut at the limit, and no summary', () => {
    const full = describeJob(text, 'full', 100);
    expect(full).toMatchObject({ summary: '', summary_kind: null, description_truncated: true, description_chars: text.length });
    expect(full.description).toHaveLength(100);
    expect(describeJob(text, 'full', 99_999).description_truncated).toBe(false);
  });
  it('none: neither, but still the length', () => {
    expect(describeJob(text, 'none', 3000)).toEqual({
      summary: '',
      summary_kind: null,
      description: '',
      description_truncated: false,
      description_chars: text.length,
    });
  });
});
