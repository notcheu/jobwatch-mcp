import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeParams, sampleInput } from './docs';
import { inputJsonSchema } from './schema';

const schema = inputJsonSchema(
  z
    .object({
      boards: z.array(z.string().min(1).max(300)).min(1).max(10).describe('Companies to read.'),
      detail: z.enum(['summary', 'full', 'none']).default('summary').describe('How much text.'),
      max_results: z.number().int().min(1).max(200).default(50),
      min_salary_k: z.number().int().min(0).max(1000).nullable().optional().describe('Floor, thousands.'),
      keywords: z.string().max(120),
      only_new: z.boolean().default(false),
      kinds: z
        .array(z.enum(['a', 'b']))
        .max(2)
        .default([]),
    })
    .strict(),
);

describe('describeParams', () => {
  const rows = Object.fromEntries(describeParams(schema).map((row) => [row.name, row]));

  it('lists the required arguments first, then the rest in schema order', () => {
    expect(describeParams(schema).map((row) => row.name)).toEqual([
      'boards',
      'keywords',
      'detail',
      'max_results',
      'min_salary_k',
      'only_new',
      'kinds',
    ]);
    expect(rows['boards']?.required).toBe(true);
    expect(rows['detail']?.required).toBe(false);
  });

  it('reads the type, the bounds and the description of each argument', () => {
    expect(rows['boards']).toMatchObject({ type: 'string[]', min: 1, max: 10, description: 'Companies to read.', default: null });
    expect(rows['keywords']).toMatchObject({ type: 'string', min: null, max: 120 });
    expect(rows['max_results']).toMatchObject({ type: 'integer', min: 1, max: 200, default: 50 });
    expect(rows['only_new']).toMatchObject({ type: 'boolean', default: false });
  });

  it('lists the values of an enum, and a nullable number is its number', () => {
    expect(rows['detail']).toMatchObject({ enum: ['summary', 'full', 'none'], default: 'summary' });
    expect(rows['min_salary_k']).toMatchObject({ type: 'integer', min: 0, max: 1000, enum: null });
    expect(rows['kinds']).toMatchObject({ type: 'string[]', enum: ['a', 'b'], max: 2 });
  });

  it('is empty for a tool that takes nothing', () => {
    expect(describeParams(inputJsonSchema(z.object({}).strict()))).toEqual([]);
  });
});

describe('sampleInput', () => {
  it('gives only the required arguments, with placeholders the reader replaces', () => {
    expect(sampleInput(schema)).toEqual({ boards: ['<boards>'], keywords: '<keywords>' });
  });

  it('uses the default, then the first enum value, and the lowest allowed number', () => {
    const other = inputJsonSchema(
      z
        .object({
          mode: z.enum(['x', 'y']),
          page: z.number().int().min(3),
          level: z.string().max(3).default('abc'),
          code: z.string().max(3),
        })
        .strict(),
    );
    expect(sampleInput(other)).toEqual({ mode: 'x', page: 3, code: '<co' });
  });

  it('is accepted by the schema it comes from', () => {
    const input = z.object({ boards: z.array(z.string().max(300)).min(1).max(10), detail: z.enum(['a', 'b']) }).strict();
    expect(input.safeParse(sampleInput(inputJsonSchema(input))).success).toBe(true);
  });
});
