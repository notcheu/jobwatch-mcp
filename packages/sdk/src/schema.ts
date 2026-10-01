import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

export interface SchemaProblem {
  path: string;
  kind: 'unrepresentable' | 'not-strict' | 'unbounded-string' | 'unbounded-array';
  message: string;
}

/** JSON Schema of the INPUT side of a zod schema (what the client sends), as exposed by `tools/list`. */
export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonSchema;
}

/** JSON Schema of the OUTPUT side (what the handler returns). */
export function outputJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' }) as JsonSchema;
}

const isRecord = (value: unknown): value is JsonSchema => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk an INPUT JSON Schema and report what the project forbids (04-catalog-and-tool-schemas.md):
 * objects that allow extra properties, strings without `maxLength` (unless an enum or const), arrays without `maxItems`.
 */
export function findInputSchemaProblems(schema: JsonSchema, path = '$'): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const walk = (node: unknown, at: string): void => {
    if (!isRecord(node)) return;
    // zod emits an ARRAY of types for unions of primitives and for nullable values, e.g. ["string","null"].
    const rawType = node['type'];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (types.includes('object') && node['additionalProperties'] !== false) {
      problems.push({ path: at, kind: 'not-strict', message: 'object must set additionalProperties to false (use .strict())' });
    }
    if (types.includes('string') && node['maxLength'] === undefined && node['enum'] === undefined && node['const'] === undefined) {
      problems.push({ path: at, kind: 'unbounded-string', message: 'string must set maxLength (use .max(n))' });
    }
    if (types.includes('array') && node['maxItems'] === undefined) {
      problems.push({ path: at, kind: 'unbounded-array', message: 'array must set maxItems (use .max(n))' });
    }
    const properties = node['properties'];
    if (isRecord(properties)) for (const [key, child] of Object.entries(properties)) walk(child, `${at}.${key}`);
    walk(node['items'], `${at}[]`);
    for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      const list = node[keyword];
      if (Array.isArray(list)) list.forEach((child, index) => walk(child, `${at}.${keyword}[${index}]`));
    }
    if (isRecord(node['additionalProperties'])) walk(node['additionalProperties'], `${at}.*`);
    for (const defs of ['$defs', 'definitions']) {
      const table = node[defs];
      if (isRecord(table)) for (const [key, child] of Object.entries(table)) walk(child, `${at}#${key}`);
    }
  };
  walk(schema, path);
  return problems;
}
