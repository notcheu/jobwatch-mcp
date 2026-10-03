import { describe, expect, it } from 'vitest';
import { formatSalary } from '@/lib/format';

const plain = (text: string): string => text.replace(/\s/g, ' ');

describe('formatSalary', () => {
  it('writes a fixed amount once and a range as a range, in the locale asked for', () => {
    expect(plain(formatSalary({ min: 65_000, max: 65_000, currency: 'EUR', variable: null }, 'fr-FR'))).toBe('65 000 €');
    expect(plain(formatSalary({ min: 72_000, max: 115_000, currency: 'EUR', variable: null }, 'fr-FR'))).toBe('72 000 € – 115 000 €');
    expect(formatSalary({ min: 72_000, max: 115_000, currency: 'EUR', variable: null }, 'en-US')).toBe('€72,000 – €115,000');
    expect(formatSalary({ min: 120_000, max: 120_000, currency: 'USD', variable: null }, 'en-US')).toBe('$120,000');
  });

  it('adds the variable part', () => {
    expect(formatSalary({ min: 26_400, max: 26_400, currency: 'EUR', variable: 12_500 }, 'en-US')).toBe('€26,400 + €12,500 variable');
  });

  it('works for any currency, including ones with no everyday symbol, and a code it does not know', () => {
    expect(formatSalary({ min: 95_000, max: 95_000, currency: 'CHF', variable: null }, 'en-US')).toContain('95,000');
    expect(plain(formatSalary({ min: 6_000_000, max: 6_000_000, currency: 'JPY', variable: null }, 'ja-JP'))).toContain('6,000,000');
    expect(formatSalary({ min: 50_000, max: 50_000, currency: 'XYZ?', variable: null }, 'en-US')).toBe('50,000 XYZ?');
  });
});
