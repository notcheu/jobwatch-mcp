import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OR_SEPARATOR, PIPE_SEPARATOR, joinKeywords, keywordsSchema, splitKeywords } from './keywords';
import { findInputSchemaProblems, inputJsonSchema } from './schema';

describe('splitKeywords', () => {
  it('splits one string on the OR of LinkedIn, and only on an upper-case OR', () => {
    expect(splitKeywords('react OR vue OR  svelte', OR_SEPARATOR)).toEqual(['react', 'vue', 'svelte']);
    expect(splitKeywords('director or manager', OR_SEPARATOR)).toEqual(['director or manager']);
    expect(splitKeywords('ORACLE developer', OR_SEPARATOR)).toEqual(['ORACLE developer']); // a word that starts with OR is not the operator
  });

  it('splits on a pipe for the company boards, with or without spaces', () => {
    expect(splitKeywords('react | vue|svelte', PIPE_SEPARATOR)).toEqual(['react', 'vue', 'svelte']);
  });

  it('splits every entry of a list, trims, drops empty and case-insensitive duplicates, and keeps the order', () => {
    expect(splitKeywords(['  React ', 'vue OR REACT', '', 'go  lang'], OR_SEPARATOR)).toEqual(['React', 'vue', 'go lang']);
  });
});

describe('joinKeywords', () => {
  it('writes the list the way each platform reads an OR', () => {
    expect(joinKeywords(['react', 'vue'], OR_SEPARATOR)).toBe('react OR vue');
    expect(joinKeywords(['react', 'vue'], PIPE_SEPARATOR)).toBe('react | vue');
    expect(joinKeywords(['react'], OR_SEPARATOR)).toBe('react');
  });
});

describe('keywordsSchema', () => {
  const schema = keywordsSchema(OR_SEPARATOR);

  it('turns a string, a string with the separator or a list into a clean list', () => {
    expect(schema.parse('react')).toEqual(['react']);
    expect(schema.parse('react OR vue')).toEqual(['react', 'vue']);
    expect(schema.parse(['react OR vue', 'Svelte', 'vue'])).toEqual(['react', 'vue', 'Svelte']);
  });

  it('refuses nothing to search for, too many keywords after the split, and a keyword that is too long', () => {
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(['  ', 'x OR  ']).success).toBe(false); // an entry that is only spaces
    expect(schema.safeParse(Array.from({ length: 11 }, (_unused, i) => `k${i}`)).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 6 }, (_unused, i) => `a${i} OR b${i}`)).success).toBe(false); // 12 after the split
    expect(schema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('is bounded in the JSON Schema Claude sees (a string or a list), so the registry accepts it', () => {
    const json = inputJsonSchema(z.object({ keywords: schema }).strict());
    expect(findInputSchemaProblems(json)).toEqual([]);
    const keywords = (json['properties'] as Record<string, { anyOf: { type: string }[] }>)['keywords'];
    expect(keywords?.anyOf.map((member) => member.type).sort()).toEqual(['array', 'string']);
  });
});
