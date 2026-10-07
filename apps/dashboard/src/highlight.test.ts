import { describe, expect, it } from 'vitest';
import { highlight } from '@/lib/highlight';

const kinds = (source: string) => highlight(source).map((token) => [token.kind, token.text]);

describe('the syntax colours', () => {
  it('colours comments, strings, numbers, keywords and the globals of the sandbox, and leaves the rest', () => {
    expect(kinds("async function read(b) { return http.get('x', 42); } // end")).toEqual([
      ['keyword', 'async'],
      ['plain', ' '],
      ['keyword', 'function'],
      ['plain', ' read(b) { '],
      ['keyword', 'return'],
      ['plain', ' '],
      ['global', 'http'],
      ['plain', '.get('],
      ['string', "'x'"],
      ['plain', ', '],
      ['number', '42'],
      ['plain', '); } '],
      ['comment', '// end'],
    ]);
  });

  it('gives the text back, whatever it is, and does not colour a word inside a string or a comment', () => {
    const source = "const a = 'return // not a comment'; /* await\nmulti */ let b = `x ${1}`;\nlet text = \"open";
    expect(
      highlight(source)
        .map((token) => token.text)
        .join(''),
    ).toBe(source);
    expect(kinds("'await'")).toEqual([['string', "'await'"]]);
    expect(kinds('// await')).toEqual([['comment', '// await']]);
  });

  it('colours a string that is not finished yet to the end of its line, so typing a quote does not recolour the page', () => {
    expect(kinds('"abc\nreturn')).toEqual([
      ['string', '"abc'],
      ['plain', '\n'],
      ['keyword', 'return'],
    ]);
  });

  it('is empty for no text', () => {
    expect(highlight('')).toEqual([]);
  });
});
