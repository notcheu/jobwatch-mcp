import { describe, expect, it } from 'vitest';
import { extractHints } from './jobtext';
import { findSalary, findSalaryRange } from './salary';

describe('findSalary', () => {
  it('reads a labelled range with the currency in front of each end', () => {
    expect(findSalary('Join us.\nSalary range: €72.000 - €115.000\nBenefits')).toBe('€72.000 - €115.000');
    expect(findSalary('Salary range: €65.000 - €108.000')).toBe('€65.000 - €108.000');
  });

  it('reads the usual forms: k with a currency, a range with one currency, spaces and commas', () => {
    expect(findSalary('Salaire : 55-65k€ brut annuel')).toBe('55-65k€');
    expect(findSalary('Rémunération: 45 000 € - 55 000 € par an')).toBe('45 000 € - 55 000 €');
    expect(findSalary('Salary: £70,000 to £85,000 per year')).toBe('£70,000 to £85,000');
    expect(findSalary('60-70 k€ per year.')).toBe('60-70 k€');
  });

  it('adds the variable part that follows the fixed one', () => {
    expect(findSalary('Remuneración fija bruta anual: 26.400€ + Variable adicional: 12.500€')).toBe('26.400€ + variable 12.500€');
    expect(findSalary('Salary: €50.000\nBonus: up to €10.000')).toBe('€50.000 + variable €10.000');
  });

  it('ignores a meal voucher, whatever its amount', () => {
    expect(findSalary('6€ de repas par jour travaillé avec Edenred.')).toBeNull();
    expect(findSalary('9€ de titres restaurants par jour travaillé avec la carte Swile')).toBeNull();
    expect(findSalary('6 EUR lunch voucher per workday with our partner Edenred.')).toBeNull();
    expect(findSalary('Ticket restaurante con valor de 6 EUR por día laborable')).toBeNull();
  });

  it('ignores an amount that is not about the pay: a payment volume, funding, a salary mentioned without a figure', () => {
    expect(findSalary('Provide a scalable payment and invoicing engine to our clients (500k€/day payment stack)')).toBeNull();
    expect(findSalary('Closed a €30 million Series B in December 2024')).toBeNull();
    expect(findSalary('Competitive salary packages based on your experience and role. We raised €30 million.')).toBeNull();
    expect(findSalary('Salary: depends on experience. We handle 500k€ a month.')).toBeNull();
  });

  it('ignores daily, monthly and million figures, even next to a salary word', () => {
    expect(findSalary('Pay: 60-70k€')).toBe('60-70k€');
    expect(findSalary('Salary 4.000€/month')).toBeNull();
    expect(findSalary('Salary budget of 2 M€')).toBeNull();
  });

  it('takes the salary word from the line above, as in a "Salary" heading followed by the figure', () => {
    expect(findSalary('Salary\n55-65k€')).toBe('55-65k€');
  });

  it('keeps the first salary of a text and a short result', () => {
    expect(findSalary('Salary: €50.000\nSalary: €90.000')).toBe('€50.000');
    expect(findSalary(`Salary: €50.000 ${'+ variable bonus €5.000 '.repeat(20)}`)?.length).toBeLessThanOrEqual(80);
  });

  it('is not slowed by hostile input', () => {
    const started = Date.now();
    findSalary(`salary ${'1 '.repeat(20_000)}`);
    findSalary(`${'€'.repeat(20_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the hints of the real pages that went wrong', () => {
  it('bsport: the stated range, not a payment volume; remote days and the experience, not "2 years" to triple a valuation', () => {
    const hints = extractHints(
      [
        'Salary range: €72.000 - €115.000',
        'Equity is meaningful: our goal is to triple valuation within 2 years.',
        'You have 5+ years of frontend experience in SaaS or product-driven companies.',
        'Flexible working model, hybrid setup with 2 remote day per week, plus 15 extra remote days per year.',
        'Provide a scalable payment and invoicing engine to our clients (500k€/day payment stack)',
      ].join('\n'),
    );
    expect(hints.salary_text).toBe('€72.000 - €115.000');
    expect(hints.years_hints).toEqual([5]);
    expect(hints.remote_hints[0]).toBe('2 remote day per week');
    expect(hints.remote_hints).toContain('hybrid');
  });

  it('Payfit: no salary stated, a meal voucher is not one', () => {
    for (const text of [
      '6€ de repas par jour travaillé avec Edenred.',
      '9€ de titres restaurants par jour travaillé avec la carte Swile pris en charge à 60% par PayFit',
      '6 EUR lunch voucher per workday with our partner Edenred.',
    ]) {
      expect(extractHints(text).salary_text).toBeNull();
    }
  });

  it('Payfit Barcelona: the fixed and the variable part', () => {
    expect(extractHints('Remuneración fija bruta anual: 26.400€ + Variable adicional: 12.500€').salary_text).toBe(
      '26.400€ + variable 12.500€',
    );
  });

  it('days in the office, per week, in English and French', () => {
    expect(extractHints('Hybrid model with 3 days in the office per week').remote_hints).toEqual(
      expect.arrayContaining(['3 days in the office per week', 'hybrid']),
    );
    expect(extractHints('3 jours par semaine au bureau').remote_hints[0]).toBe('3 jours par semaine au bureau');
  });

  it('years: only experience counts, in English, French and Spanish', () => {
    expect(extractHints('minimum 8 ans d’expérience en vente B2B, dont 2 ans sur un segment Mid Market').years_hints).toEqual([2, 8]);
    expect(extractHints('Más de 3 años de experiencia en ventas').years_hints).toEqual([3]);
    expect(extractHints('We were founded 10 years ago and plan to double in 3 years.').years_hints).toEqual([]);
  });
});

describe('an amount that has the shape of a salary needs no salary word', () => {
  it.each([
    ['We pay up to 65k€ for this role', '65k€'],
    ['Budget: 120K€ fixe', '120K€'],
    ['Our package starts at €65.000', '€65.000'],
    ['€ 65 000 for the right person', '€ 65 000'],
    ['You will earn 65,000 € plus benefits', '65,000 €'],
    ['up to $120,000', '$120,000'],
    ['£85k', '£85k'],
    ['CHF 95k', 'CHF 95k'],
    ['95k CHF', '95k CHF'],
    ['70 000 USD', '70 000 USD'],
    ['SEK 650 000', 'SEK 650 000'],
    ['¥850,000', '¥850,000'],
  ])('%s', (line, expected) => {
    expect(findSalary(line)).toBe(expected);
  });

  it('reads the range of such amounts, and a currency-less lower end', () => {
    expect(findSalary('We offer 65k€ - 85k€ depending on seniority')).toBe('65k€ - 85k€');
    expect(findSalary('65-85k€')).toBe('65-85k€');
  });

  it('still refuses what is not a salary, shaped like one or not', () => {
    for (const line of [
      'Provide a payment engine (500k€/day payment stack)',
      'Revenue of 500k€ per month',
      'Meal voucher of 100k€',
      'We raised €120.000.000 in funding',
      'Equity worth 200k€',
      'Our valuation is 150k€',
      'A 6€ ticket restaurant',
      '65k employees, 120 000 users',
      'The offer 2025 000',
    ])
      expect(findSalary(line), line).toBeNull();
  });
});

describe('findSalaryRange', () => {
  it('gives the numbers of a range and a fixed amount, in currency units per year', () => {
    expect(findSalaryRange('Salary range: €72.000 - €115.000')).toEqual({
      text: '€72.000 - €115.000',
      min: 72_000,
      max: 115_000,
      currency: 'EUR',
      variable: null,
    });
    expect(findSalaryRange('55-65k€')).toMatchObject({ min: 55_000, max: 65_000, currency: 'EUR' });
    expect(findSalaryRange('$120,000')).toMatchObject({ min: 120_000, max: 120_000, currency: 'USD' });
    expect(findSalaryRange('CHF 95k')).toMatchObject({ min: 95_000, max: 95_000, currency: 'CHF' });
    expect(findSalaryRange('95 000 euros')).toMatchObject({ currency: 'EUR' });
  });

  it('keeps the variable part apart', () => {
    expect(findSalaryRange('Remuneración fija bruta anual: 26.400€ + Variable adicional: 12.500€')).toMatchObject({
      min: 26_400,
      max: 26_400,
      variable: 12_500,
    });
  });

  it('is null when there is none', () => {
    expect(findSalaryRange('No figures here, only React.')).toBeNull();
  });
});

describe('a salary next to a salary word beats an amount that only has the shape', () => {
  it('whatever the order in the text', () => {
    expect(findSalary('Our clients pay 120k€ for the platform.\nThe salary is 78.000€ per year.')).toBe('78.000€');
    expect(findSalary('The salary is 78.000€ per year.\nOur clients pay 120k€ for the platform.')).toBe('78.000€');
  });

  it('with the variable part written after the amount', () => {
    expect(findSalaryRange('Our clients pay 120k€ for the platform.\nSalary is 78.000€ per year with 10k€ variable')).toEqual({
      text: '78.000€ + variable 10k€',
      min: 78_000,
      max: 78_000,
      currency: 'EUR',
      variable: 10_000,
    });
  });

  it('on the same line, the amount that is not the salary is left aside only when it is not shaped like one', () => {
    expect(findSalary('Salary: 78.000€ - clients pay 120k€')).toBe('78.000€');
  });

  it('falls back to the first shaped amount when no line names a salary, and still skips the excluded lines', () => {
    expect(findSalary('We pay 90k€ to the right person\nLunch: 150k€\nAnd 120k€ elsewhere')).toBe('90k€');
    expect(findSalary('Meal voucher 150k€\nAnd 120k€ elsewhere')).toBe('120k€');
  });

  it('keeps the first of two named salaries', () => {
    expect(findSalary('Salary: €50.000\nSalary: €90.000')).toBe('€50.000');
  });
});

describe('no market is assumed', () => {
  it('the plausible size of a yearly salary follows the currency', () => {
    expect(findSalaryRange('¥6,000,000')).toMatchObject({ min: 6_000_000, currency: 'JPY' });
    expect(findSalaryRange('Salary: ₹1,800,000 per annum')).toMatchObject({ max: 1_800_000, currency: 'INR' });
    expect(findSalaryRange('Salary: 14 400 000 HUF')).toMatchObject({ max: 14_400_000, currency: 'HUF' });
    expect(findSalaryRange('Salary: 90.000.000 €')).toBeNull(); // absurd in euros
    expect(findSalaryRange('Salary: €12.000 (apprenticeship)')).toMatchObject({ max: 12_000 });
  });

  it('knows the salary words of more languages', () => {
    expect(findSalaryRange('Gehalt: 62.000 € brutto pro Jahr')).toMatchObject({ max: 62_000 });
    expect(findSalaryRange('Retribuzione annua lorda: 38.000 €')).toMatchObject({ max: 38_000 });
    expect(findSalaryRange('Salário: R$ 120.000 por ano')).toMatchObject({ max: 120_000 });
    expect(findSalaryRange('Salaris: € 55.000 per jaar')).toMatchObject({ max: 55_000 });
  });

  it('does not read a monthly or hourly figure in another language as a yearly one', () => {
    expect(findSalary('Gehalt: 5.200 € pro Monat')).toBeNull();
    expect(findSalary('Stipendio: 3.000 € al mese')).toBeNull();
    expect(findSalary('Salário: 4.000 € por mês')).toBeNull();
  });

  it('does not mistake a meal allowance or a turnover in another language for pay', () => {
    expect(findSalary('Essensgutschein 120.000 €')).toBeNull();
    expect(findSalary('Buono pasto da 150.000 €')).toBeNull();
    expect(findSalary('Umsatz: 500k€')).toBeNull();
  });
});
