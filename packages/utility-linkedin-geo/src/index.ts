import {
  JobwatchError,
  SDK_API_VERSION,
  bestLocation,
  defineUtility,
  defineHttpTool,
  forgetLocation,
  lookupLocations,
  saveLocation,
  savedLocations,
  z,
} from '@jobwatch/sdk';

const geoId = z
  .string()
  .max(12)
  .regex(/^\d{3,12}$/, 'a numeric LinkedIn geoId');
const alias = z.string().trim().min(2).max(60);

const input = z
  .object({
    query: z.string().trim().min(2).max(100).optional().describe('Look places up: the text to complete, like "Berlin" or "Austin, Texas".'),
    save_as: alias
      .optional()
      .describe('With id: remember that name for the place, so a search can use it ("home", "berlin"). Overwrites an older one.'),
    id: geoId.optional().describe('With save_as: the geoId to remember, taken from a lookup.'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('With save_as: how LinkedIn writes the place ("Berlin, Germany"), shown when the names are listed.'),
    forget: alias.optional().describe('Forget a remembered name (one you saved, or one a search looked up by itself).'),
    list: z.boolean().optional().describe('List the remembered names.'),
  })
  .strict();

const placeSchema = z.object({ id: z.string(), label: z.string() });
const savedSchema = z.object({ alias: z.string(), id: z.string(), label: z.string(), saved_by: z.enum(['operator', 'auto']) });

const output = z.object({
  places: z
    .array(placeSchema)
    .describe('What LinkedIn suggests for the query, best first. Pass an id as `geo` to a LinkedIn search, or save it with save_as.'),
  best: placeSchema.nullable().describe('The suggestion a search by that name would use.'),
  saved: savedSchema.nullable().describe('The name just remembered.'),
  forgotten: z.string().nullable(),
  remembered: z.array(savedSchema).describe('Every remembered name (only with list, or after a change).'),
});

/**
 * The tool does one of four things, chosen by what is given: look places up (`query`), remember a name (`save_as` and `id`), forget
 * one (`forget`), or list the remembered ones (`list`). Remembered names are what the LinkedIn search resolves a place by.
 */
export const locations = defineHttpTool({
  name: 'linkedin_locations',
  title: 'LinkedIn locations (read-only)',
  description:
    'Read-only on LinkedIn. Finds the LinkedIn geoId of a place from its public location autocomplete (query), and can remember a name for a place (save_as + id) so that searches can use it. A LinkedIn search already looks a place name up by itself when it can; use this to see the candidates and choose one when a name is ambiguous (Paris, France or Paris, Texas). Changes nothing on LinkedIn: remembered names live in the router.',
  input,
  output,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  limits: { timeoutS: 30, cost: 1, outputMaxBytes: 32_768 },
  examples: [
    {
      title: 'Find a place',
      prompt: 'Find the LinkedIn location id for <place>.',
      input: { query: '<place>' },
    },
    {
      title: 'List the saved places',
      prompt: 'List the LinkedIn places I saved under a name.',
      input: { list: true },
    },
  ],
  handler: async (args, { http, memory }) => {
    const modes = [
      args.query !== undefined,
      args.save_as !== undefined || args.id !== undefined || args.label !== undefined,
      args.forget !== undefined,
      args.list === true,
    ].filter(Boolean);
    if (modes.length !== 1) throw new JobwatchError('invalid_arguments', 'Give exactly one of: query, save_as with id, forget, or list.');
    if ((args.save_as === undefined) !== (args.id === undefined))
      throw new JobwatchError('invalid_arguments', 'save_as and id go together: the name to remember and the geoId it stands for.');

    const empty = { places: [], best: null, saved: null, forgotten: null, remembered: [] };
    const withSaved = async () =>
      (await savedLocations(memory)).map((entry) => ({ alias: entry.alias, id: entry.id, label: entry.label, saved_by: entry.by }));

    if (args.query !== undefined) {
      const places = await lookupLocations(http, args.query);
      return {
        data: { ...empty, places, best: bestLocation(places, args.query) ?? null },
        warnings:
          places.length === 0
            ? ['LinkedIn suggested nothing for this text, or did not answer. Try another spelling, or pass a place name to a search.']
            : [],
      };
    }
    if (args.save_as !== undefined && args.id !== undefined) {
      const label = args.label ?? (await savedLocations(memory)).find((entry) => entry.id === args.id)?.label ?? args.save_as;
      await saveLocation(memory, args.save_as, { id: args.id, label }, 'operator');
      return {
        data: {
          ...empty,
          saved: { alias: args.save_as.toLowerCase(), id: args.id, label, saved_by: 'operator' as const },
          remembered: await withSaved(),
        },
        warnings: [],
        cost: 0,
      };
    }
    if (args.forget !== undefined) {
      await forgetLocation(memory, args.forget);
      return { data: { ...empty, forgotten: args.forget, remembered: await withSaved() }, warnings: [], cost: 0 };
    }
    return { data: { ...empty, remembered: await withSaved() }, warnings: [], cost: 0 };
  },
});

export default defineUtility({
  id: 'linkedin-geo',
  displayName: 'LinkedIn locations',
  description:
    'Utility: finds the LinkedIn geoId of a place and remembers names for places (read-only, no login, no browser, fetches no jobs).',
  sdkApi: SDK_API_VERSION,
  platform: 'linkedin-geo',
  allowedHosts: ['www.linkedin.com'],
  tools: [locations],
});
