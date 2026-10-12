import { RESERVED_FILTER_NAMES, customFiltersSchema, filterShape, scriptDocs } from '@jobwatch/core';
import { filterDocItems, filterProblems, type CustomFilter } from '@jobwatch/dashboard-api';
import { describe, expect, it } from 'vitest';

// The rules for the filters of a custom adapter live twice: in core (they decide what the router builds) and in dashboard-api (the modal
// says what is wrong before saving, and writes the reference live). Core cannot import dashboard-api, so this test is what keeps them one.

const contract: CustomFilter = {
  name: 'contract',
  label: 'Contract type',
  description: 'The type of contract.',
  type: 'multiselect',
  options: [{ value: 'CDI', label: 'Permanent' }, { value: 'CDD' }, { value: 'Stage' }],
};
const sector: CustomFilter = {
  name: 'sector',
  description: 'The sector.',
  type: 'select',
  options: [{ value: 'commercial' }, { value: 'it' }],
};
const remote: CustomFilter = { name: 'remote', description: 'Remote only.', type: 'boolean', default: true };
const city: CustomFilter = { name: 'city', description: 'A city.', type: 'string', maxLength: 40 };
const pay: CustomFilter = { name: 'pay', description: 'Monthly pay.', type: 'number', integer: true, min: 0, max: 5000 };
const all = [contract, sector, remote, city, pay];

const lists: [string, unknown[]][] = [
  ['none', []],
  ['every type', all],
  ['a built-in name', [{ ...remote, name: 'title_any' }]],
  ['boards', [{ ...remote, name: 'boards' }]],
  ['a name twice', [remote, { ...city, name: 'remote' }]],
  ['a bad name', [{ ...remote, name: 'Remote Only' }]],
  ['one option', [{ ...sector, options: [{ value: 'it' }] }]],
  ['the same option twice', [{ ...sector, options: [{ value: 'it' }, { value: 'it' }] }]],
  ['an empty description', [{ ...remote, description: '' }]],
  ['a string that is too long', [{ ...city, maxLength: 201 }]],
  ['a number with max below min', [{ ...pay, min: 9, max: 1 }]],
  ['an unknown type', [{ name: 'when', description: 'A date.', type: 'date' }]],
  ['an unknown attribute', [{ ...remote, extra: 1 }]],
  ['thirteen filters', Array.from({ length: 13 }, (_, index) => ({ ...remote, name: `flag${index}` }))],
];

describe('the rules for the filters of a custom adapter', () => {
  it.each(lists)('are the same in the router and in the modal: %s', (_what, list) => {
    const router = customFiltersSchema.safeParse(list).success;
    const modal = filterProblems(list, RESERVED_FILTER_NAMES).size === 0;
    expect(modal).toBe(router);
  });

  it('say what is wrong, by the index of the filter', () => {
    const problems = filterProblems(
      [remote, { ...city, name: 'remote' }, { ...sector, options: [{ value: 'it' }] }],
      RESERVED_FILTER_NAMES,
    );
    expect(problems.has(0)).toBe(false);
    expect(problems.get(1)).toEqual(['"remote" is used twice']);
    expect(problems.get(2)?.[0]).toMatch(/options/);
  });
});

describe('the reference written for the filters', () => {
  const items = filterDocItems(all);
  const shape = filterShape(customFiltersSchema.parse(all));

  it('has a row for each field the tool really takes, in the same order, all optional', () => {
    expect(items.map((item) => item.name)).toEqual(Object.keys(shape));
    expect(items.every((item) => item.optional === true)).toBe(true);
  });

  it('gives each the type of the value a script finds in `filters`', () => {
    const by = Object.fromEntries(items.map((item) => [item.name, item]));
    expect(by['contract']).toMatchObject({ type: 'string[]', fullType: "('CDI' | 'CDD' | 'Stage')[]" });
    expect(by['sector']).toMatchObject({ type: 'string', fullType: "'commercial' | 'it'" });
    expect(by['remote']?.type).toBe('boolean');
    expect(by['city']).toMatchObject({ type: 'string', fullType: 'string (40 characters at most)' });
    expect(by['pay']).toMatchObject({ type: 'number', fullType: 'integer (at least 0, at most 5000)' });
    // and the tool agrees on each kind of value
    expect(shape['contract']?.safeParse(['CDI'])?.success).toBe(true);
    expect(shape['sector']?.safeParse('it')?.success).toBe(true);
    expect(shape['remote']?.safeParse(true)?.success).toBe(true);
    expect(shape['city']?.safeParse('Paris')?.success).toBe(true);
    expect(shape['pay']?.safeParse(100)?.success).toBe(true);
  });

  it('says what an unset one is for the script, and shortens a long list of options', () => {
    const by = Object.fromEntries(items.map((item) => [item.name, item]));
    expect(by['contract']?.description).toContain('An empty list when the caller leaves it out');
    expect(by['sector']?.description).toContain('Not set when the caller leaves it out');
    expect(by['remote']?.description).toContain('True when the caller leaves it out'); // default: true
    const many = filterDocItems([{ ...sector, options: Array.from({ length: 30 }, (_, index) => ({ value: `v${index}` })) }]);
    expect(many[0]?.fullType).toBe("'v0' | 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | … (30 values)");
  });

  it('does not repeat a built-in filter: the reference lists those from the router, the custom ones come after', () => {
    const builtin =
      scriptDocs('http')
        .find((block) => block.id === 'filters')
        ?.items.map((item) => item.name) ?? [];
    for (const item of items) expect(builtin).not.toContain(item.name);
  });
});
