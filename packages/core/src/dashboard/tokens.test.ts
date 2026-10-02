import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens, jobTextChars } from './tokens';

describe('estimateTokens', () => {
  it('divides the characters by the ratio, rounding up, and is 0 for no text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('a'.repeat(36))).toBe(11);
    expect(estimateTokens('a'.repeat(40), 4)).toBe(10);
  });

  it('falls back to the default ratio for a nonsense one', () => {
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateTokens('a'.repeat(70), ratio)).toBe(Math.ceil(70 / DEFAULT_CHARS_PER_TOKEN));
    }
  });

  it('gives a larger estimate for a longer text (so detail none < summary < full holds)', () => {
    expect(estimateTokens('x'.repeat(100))).toBeLessThan(estimateTokens('x'.repeat(2000)));
  });
});

describe('jobTextChars', () => {
  it('sums the stored description lengths against the text actually returned', () => {
    expect(
      jobTextChars({
        jobs: [
          { description_chars: 4000, summary: 'a'.repeat(300), description: '' },
          { description_chars: 6000, summary: '', description: 'b'.repeat(1000) },
          { description_chars: 500, text: 'c'.repeat(200) },
        ],
      }),
    ).toEqual({ available: 10_500, returned: 1500 });
  });

  it('is undefined for a result without jobs or with nothing to count', () => {
    expect(jobTextChars(undefined)).toBeUndefined();
    expect(jobTextChars({ cards: [] })).toBeUndefined();
    expect(jobTextChars({ jobs: [] })).toBeUndefined();
    expect(jobTextChars({ jobs: [{ id: 'x' }] })).toBeUndefined();
  });
});
