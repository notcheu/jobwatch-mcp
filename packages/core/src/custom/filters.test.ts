import { boardFilters, inputJsonSchema, validateAdapter } from '@jobwatch/sdk';
import { createHttpTestContext } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import type { CustomAdapterRow } from '../store/store';
import { RESERVED_FILTER_NAMES, customFiltersSchema, filterShape, parseStoredFilters, type CustomFilter } from './filters';
import { buildCustomModule } from './module';
import { processSpawner } from './sandbox';

const contract: CustomFilter = {
  name: 'contract',
  label: 'Contract type',
  description: 'The type of contract.',
  type: 'multiselect',
  options: [{ value: 'cdi', label: 'CDI' }, { value: 'cdd' }, { value: 'stage' }],
};
const sector: CustomFilter = {
  name: 'sector',
  description: 'The job sector.',
  type: 'select',
  options: [{ value: 'commercial' }, { value: 'it' }],
};
const remote: CustomFilter = { name: 'remote', description: 'Remote jobs only.', type: 'boolean' };
const city: CustomFilter = { name: 'city', description: 'A city.', type: 'string', maxLength: 40 };
const pay: CustomFilter = { name: 'pay', description: 'Monthly pay.', type: 'number', integer: true, min: 0, max: 20000 };
const all = [contract, sector, remote, city, pay];

const toolOf = (module: ReturnType<typeof buildCustomModule>) => {
  const tool = module.tools[0];
  if (tool === undefined) throw new Error('no tool');
  return tool;
};

const row = (filters: CustomFilter[], script = 'async function read() { return { postings: [] }; }'): CustomAdapterRow => ({
  handle: 'acmejobs',
  name: 'Acme jobs',
  kind: 'http',
  url: 'https://careers.acme.com',
  script,
  filters,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
});

describe('the definition of a filter', () => {
  it('accepts every type', () => {
    expect(customFiltersSchema.safeParse(all).success).toBe(true);
  });

  it.each([
    ['a name that is not lower case', [{ ...remote, name: 'Remote' }]],
    ['a name that is too short', [{ ...remote, name: 'r' }]],
    ['a name with a dash', [{ ...remote, name: 'on-site' }]],
    ['a built-in name', [{ ...remote, name: 'title_any' }]],
    ['boards', [{ ...remote, name: 'boards' }]],
    ['a name used twice', [remote, { ...city, name: 'remote' }]],
    ['a select with one option', [{ ...sector, options: [{ value: 'it' }] }]],
    ['options with the same value', [{ ...sector, options: [{ value: 'it' }, { value: 'it', label: 'IT' }] }]],
    ['an empty option', [{ ...sector, options: [{ value: ' ' }, { value: 'it' }] }]],
    ['no description', [{ ...remote, description: ' ' }]],
    ['a string longer than 200', [{ ...city, maxLength: 500 }]],
    ['a number whose max is below its min', [{ ...pay, min: 10, max: 5 }]],
    ['an unknown type', [{ name: 'when', description: 'A date.', type: 'date' }]],
    ['an unknown attribute', [{ ...remote, extra: true }]],
    ['more than twelve filters', Array.from({ length: 13 }, (_, index) => ({ ...remote, name: `flag${index}` }))],
  ])('refuses %s', (_what, filters) => {
    expect(customFiltersSchema.safeParse(filters).success).toBe(false);
  });

  it('forbids exactly the built-in filters of the tool, and boards', () => {
    expect([...RESERVED_FILTER_NAMES].sort()).toEqual(['boards', ...Object.keys(boardFilters)].sort());
  });

  it('reads what is stored, and takes damage for no filter', () => {
    expect(parseStoredFilters(JSON.stringify(all))).toEqual(all);
    expect(parseStoredFilters('[]')).toEqual([]);
    expect(parseStoredFilters('not json')).toEqual([]);
    expect(parseStoredFilters('[{"name":"x"}]')).toEqual([]);
    expect(parseStoredFilters(null)).toEqual([]);
  });
});

describe('the fields a filter adds to the tool', () => {
  const shape = filterShape(all);
  const parse = (name: string, value: unknown) => shape[name]?.safeParse(value);

  it('leaves every one out by default, and a multiselect empty', () => {
    expect(Object.keys(shape)).toEqual(['contract', 'sector', 'remote', 'city', 'pay']);
    expect(parse('contract', undefined)).toMatchObject({ success: true, data: [] });
    expect(parse('sector', undefined)).toMatchObject({ success: true, data: undefined });
    expect(parse('remote', undefined)).toMatchObject({ success: true, data: false });
    expect(parse('city', undefined)).toMatchObject({ success: true, data: undefined });
    expect(parse('pay', undefined)).toMatchObject({ success: true, data: undefined });
  });

  it('takes a boolean default', () => {
    expect(filterShape([{ ...remote, default: true }])['remote']?.safeParse(undefined)).toMatchObject({ success: true, data: true });
  });

  it('accepts a choice among the options and refuses any other', () => {
    expect(parse('sector', 'it')?.success).toBe(true);
    expect(parse('sector', 'finance')?.success).toBe(false);
    expect(parse('contract', ['cdi', 'stage'])?.success).toBe(true);
    expect(parse('contract', ['cdi', 'apprenticeship'])?.success).toBe(false);
    expect(parse('contract', 'cdi')?.success).toBe(false); // a multiselect is a list
  });

  it('bounds a string and a number', () => {
    expect(parse('city', '  Paris ')).toMatchObject({ success: true, data: 'Paris' });
    expect(parse('city', 'x'.repeat(41))?.success).toBe(false);
    expect(parse('pay', 1500)?.success).toBe(true);
    expect(parse('pay', 1500.5)?.success).toBe(false); // an integer
    expect(parse('pay', -1)?.success).toBe(false);
    expect(parse('pay', 20001)?.success).toBe(false);
  });

  it('describes each one, with its options for a choice', () => {
    const json = JSON.stringify(inputJsonSchema(toolOf(buildCustomModule(row(all), { spawner: processSpawner() })).input));
    expect(json).toContain('Contract type: The type of contract. Any of cdi, cdd, stage; empty for all.');
    expect(json).toContain('One of commercial, it.');
  });
});

describe('a module with filters', () => {
  const spawner = processSpawner();

  it('is a valid adapter: the tool schema stays strict and bounded, and its example still parses', () => {
    const module = buildCustomModule(row(all), { spawner });
    expect(validateAdapter(module)).toEqual([]);
    const properties = Object.keys((inputJsonSchema(toolOf(module).input) as { properties: object }).properties);
    expect(properties).toEqual(expect.arrayContaining(['boards', 'title_any', 'contract', 'sector', 'remote', 'city', 'pay']));
  });

  it('refuses a definition the router cannot build, naming the adapter', () => {
    expect(() => buildCustomModule(row([{ ...remote, name: 'max_results' }]), { spawner })).toThrow(
      /custom adapter "acmejobs": filters\.0\.name: "max_results" is a built-in filter/,
    );
    expect(() => buildCustomModule(row([{ ...sector, options: [{ value: 'it' }] }]), { spawner })).toThrow(
      /custom adapter "acmejobs": filters/,
    );
  });

  it('hands the script the values of its filters, and refuses a value outside the options before any script runs', async () => {
    const module = buildCustomModule(
      row(
        all,
        `async function read(board, filters) { return { name: board, postings: [{ id: 'p1', title: JSON.stringify([filters.contract, filters.sector, filters.remote, filters.pay]), url: 'https://careers.acme.com/j/1' }] }; }`,
      ),
      { spawner },
    );
    const tool = toolOf(module);
    const ctx = createHttpTestContext({ allowedHosts: module.allowedHosts, platform: 'custom-acmejobs', routes: [] });
    const parsed = tool.input.parse({ boards: ['acme'], contract: ['cdi', 'stage'], sector: 'it', remote: true, pay: 3000 });
    const result = await tool.handler(parsed as never, ctx.ctx as never);
    const jobs = (result.data as { jobs: { title: string }[] }).jobs;
    expect(jobs.map((job) => JSON.parse(job.title))).toEqual([[['cdi', 'stage'], 'it', true, 3000]]); // the values, as the script read them
    expect(tool.input.safeParse({ boards: ['acme'], sector: 'finance' }).success).toBe(false);
    expect(tool.input.safeParse({ boards: ['acme'], contract: ['cdi', 'x'] }).success).toBe(false);
  }, 30_000);
});
