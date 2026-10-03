import { describe, expect, it } from 'vitest';
import { extractHints } from './jobtext';
import { findSalary } from './salary';

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

  it('ignores a figure with no salary word near it, and daily, monthly or million figures next to one', () => {
    expect(findSalary('Our clients pay 120k€ for the platform')).toBeNull();
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
