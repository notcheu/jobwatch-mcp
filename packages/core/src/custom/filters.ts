import { boardFilters, z } from '@jobwatch/sdk';

/**
 * The filters an operator adds to a custom adapter: extra arguments of its tool, typed, which the router hands to the script (as the
 * `filters` of `read(board, filters)`) so that it can send them to the site. The router never applies them itself: it cannot know
 * what "contract" means on a given site. Every one is optional for the caller; an unset filter is the site's "any".
 *
 * `type` is the discriminator of an open union: a new kind of input (a date, a range) is one more member here, in `filterShape`, and in
 * `filterDocItems` of `@jobwatch/dashboard-api`; the stored JSON, the API and the modal need no other change.
 */

/** The name of a filter, as the script reads it: `filters.contract`. */
export const FILTER_NAME = /^[a-z][a-z0-9_]{1,31}$/;
export const MAX_CUSTOM_FILTERS = 12;
export const MAX_FILTER_OPTIONS = 100;

/** Names a custom filter may not take: the built-in filters (the router applies them) and `boards`. */
export const RESERVED_FILTER_NAMES: readonly string[] = ['boards', ...Object.keys(boardFilters)];

const optionSchema = z
  .object({
    /** What the script receives, and what the caller names: usually the site's own code for the choice. */
    value: z.string().trim().min(1).max(60),
    /** What a person reads; the value when left out. */
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const common = {
  name: z.string().regex(FILTER_NAME, '2 to 32 lower-case letters, digits or _, starting with a letter'),
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(200),
};
const options = z.array(optionSchema).min(2).max(MAX_FILTER_OPTIONS);

const selectFilter = z.object({ ...common, type: z.literal('select'), options }).strict();
const multiselectFilter = z.object({ ...common, type: z.literal('multiselect'), options }).strict();
const booleanFilter = z.object({ ...common, type: z.literal('boolean'), default: z.boolean().optional() }).strict();
const stringFilter = z.object({ ...common, type: z.literal('string'), maxLength: z.number().int().min(1).max(200).optional() }).strict();
const numberFilter = z
  .object({
    ...common,
    type: z.literal('number'),
    integer: z.boolean().optional(),
    min: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
    max: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
  })
  .strict();

export const customFilterSchema = z.discriminatedUnion('type', [
  selectFilter,
  multiselectFilter,
  booleanFilter,
  stringFilter,
  numberFilter,
]);
export type CustomFilter = z.infer<typeof customFilterSchema>;

/** The list stored with an adapter: at most 12, with unique names that are not built-in, and unique option values in each choice. */
export const customFiltersSchema = z
  .array(customFilterSchema)
  .max(MAX_CUSTOM_FILTERS)
  .superRefine((filters, ctx) => {
    const seen = new Set<string>();
    filters.forEach((filter, index) => {
      if (RESERVED_FILTER_NAMES.includes(filter.name))
        ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `"${filter.name}" is a built-in filter` });
      else if (seen.has(filter.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `"${filter.name}" is used twice` });
      seen.add(filter.name);
      if (
        (filter.type === 'select' || filter.type === 'multiselect') &&
        new Set(filter.options.map((entry) => entry.value)).size < filter.options.length
      )
        ctx.addIssue({ code: 'custom', path: [index, 'options'], message: 'two options have the same value' });
      if (filter.type === 'number' && filter.min !== undefined && filter.max !== undefined && filter.min > filter.max)
        ctx.addIssue({ code: 'custom', path: [index, 'max'], message: 'max is below min' });
    });
  });

/** The filters of a stored row; anything that is not a valid list is no filter (a damaged row never stops the router from starting). */
export function parseStoredFilters(value: unknown): CustomFilter[] {
  try {
    const parsed = customFiltersSchema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const describe = (filter: CustomFilter): string => {
  const text = `${filter.label ?? filter.name}: ${filter.description}`;
  if (filter.type === 'select') return `${text} One of ${filter.options.map((entry) => entry.value).join(', ')}.`;
  if (filter.type === 'multiselect') return `${text} Any of ${filter.options.map((entry) => entry.value).join(', ')}; empty for all.`;
  return text;
};

/** The zod fields of the filters, to spread into the input of the tool. Every one is optional or has a default, so a call may leave it out. */
export function filterShape(filters: readonly CustomFilter[]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const filter of filters) {
    switch (filter.type) {
      case 'select':
        shape[filter.name] = z
          .enum(filter.options.map((entry) => entry.value) as [string, ...string[]])
          .optional()
          .describe(describe(filter));
        break;
      case 'multiselect':
        shape[filter.name] = z
          .array(z.enum(filter.options.map((entry) => entry.value) as [string, ...string[]]))
          .max(filter.options.length)
          .default([])
          .describe(describe(filter));
        break;
      case 'boolean':
        shape[filter.name] = z
          .boolean()
          .default(filter.default ?? false)
          .describe(describe(filter));
        break;
      case 'string':
        shape[filter.name] = z
          .string()
          .trim()
          .max(filter.maxLength ?? 100)
          .optional()
          .describe(describe(filter));
        break;
      case 'number': {
        let field = z.number();
        if (filter.integer === true) field = field.int();
        if (filter.min !== undefined) field = field.min(filter.min);
        if (filter.max !== undefined) field = field.max(filter.max);
        shape[filter.name] = field.optional().describe(describe(filter));
        break;
      }
    }
  }
  return shape;
}
