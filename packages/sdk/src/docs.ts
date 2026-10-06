import type { JsonSchema } from './schema';

/** One argument of a tool as the dashboard documents it, read from the tool's INPUT JSON Schema (the one `tools/list` exposes). */
export interface ParamDoc {
  name: string;
  /** `string`, `integer`, `boolean`, `string[]`, `string | integer`, ... */
  type: string;
  required: boolean;
  /** The default the server applies, absent (null) when the argument has none. */
  default: unknown;
  /** The allowed values of an enum, null otherwise. */
  enum: string[] | null;
  /** Lowest value (numbers), shortest text (strings) or fewest items (arrays); null when unbounded. */
  min: number | null;
  /** Highest value (numbers), longest text (strings) or most items (arrays); null when unbounded. */
  max: number | null;
  description: string;
}

const isRecord = (value: unknown): value is JsonSchema => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** The schemas a union offers, `null` ones left out (an optional or nullable argument). */
function members(node: JsonSchema): JsonSchema[] {
  const union = node['anyOf'] ?? node['oneOf'];
  if (!Array.isArray(union)) return [node];
  return union.filter((member): member is JsonSchema => isRecord(member) && member['type'] !== 'null');
}

function typeOf(node: JsonSchema): string {
  const names = members(node).map((member) => {
    const raw = member['type'];
    const types = (Array.isArray(raw) ? raw : [raw]).filter((type) => type !== 'null' && typeof type === 'string');
    if (types.includes('array')) return `${isRecord(member['items']) ? typeOf(member['items']) : 'any'}[]`;
    return types.length > 0 ? types.join(' | ') : Array.isArray(member['enum']) ? 'enum' : 'any';
  });
  return [...new Set(names)].join(' | ') || 'any';
}

/** Bounds of the first union member that has any (a nullable integer is one member plus `null`). */
function bounds(node: JsonSchema): { min: number | null; max: number | null } {
  for (const member of members(node)) {
    const pairs = [
      [member['minimum'], member['maximum']],
      [member['minLength'], member['maxLength']],
      [member['minItems'], member['maxItems']],
    ] as const;
    for (const [low, high] of pairs) if (num(low) !== null || num(high) !== null) return { min: num(low), max: num(high) };
  }
  return { min: null, max: null };
}

/** The allowed values of an argument, or of the items of an array argument. */
function enumOf(node: JsonSchema): unknown[] | undefined {
  for (const member of members(node)) {
    if (Array.isArray(member['enum'])) return member['enum'];
    if (isRecord(member['items']) && Array.isArray(member['items']['enum'])) return member['items']['enum'];
  }
  return undefined;
}

/** One row per top-level argument, required ones first, then in the order of the schema. */
export function describeParams(schema: JsonSchema): ParamDoc[] {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
  const rows = Object.entries(properties).map(([name, value]): ParamDoc => {
    const node = isRecord(value) ? value : {};
    const choices = enumOf(node);
    return {
      name,
      type: typeOf(node),
      required: required.has(name),
      default: node['default'] ?? null,
      enum: choices?.map(String) ?? null,
      ...bounds(node),
      description: typeof node['description'] === 'string' ? node['description'] : '',
    };
  });
  return [...rows.filter((row) => row.required), ...rows.filter((row) => !row.required)];
}

function sample(name: string, node: JsonSchema): unknown {
  if (node['default'] !== undefined) return node['default'];
  const choices = members(node).find((member) => Array.isArray(member['enum']));
  if (choices !== undefined) return (choices['enum'] as unknown[])[0];
  const member = members(node)[0] ?? {};
  const raw = member['type'];
  const type = Array.isArray(raw) ? raw.find((entry) => entry !== 'null') : raw;
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') return num(member['minimum']) ?? 1;
  if (type === 'array') {
    const item = isRecord(member['items']) ? sample(name, member['items']) : `<${name}>`;
    return (num(member['minItems']) ?? 1) > 0 ? [item] : [];
  }
  if (type === 'object') return {};
  const text = `<${name}>`;
  const max = num(member['maxLength']);
  return max !== null && max < text.length ? text.slice(0, Math.max(1, max)) : text;
}

/**
 * The smallest input that is accepted: only the required arguments, each with its default, its first enum value or a `<name>`
 * placeholder. A starting point to copy and edit, not a real query.
 */
export function sampleInput(schema: JsonSchema): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return Object.fromEntries(required.map((name) => [name, sample(name, isRecord(properties[name]) ? properties[name] : {})]));
}
