import { z } from 'zod';
import type { HttpClient, PlatformMemory } from './context';

/** LinkedIn's public location autocomplete: no login, no cookie. The result of an unofficial endpoint, so every failure is soft. */
export const LOCATION_LOOKUP_URL = 'https://www.linkedin.com/jobs-guest/api/typeaheadHits';

export interface LocationHit {
  /** The LinkedIn geoId. */
  id: string;
  /** How LinkedIn writes the place: "Berlin, Germany". */
  label: string;
}

const hitsSchema = z.array(z.object({ id: z.string().regex(/^\d{3,12}$/), displayName: z.string().min(1).max(200) }).passthrough()).max(50);

/** Ask LinkedIn for the places that match some text. Returns `[]` when it answers badly or not at all: a lookup never fails a search. */
export async function lookupLocations(http: HttpClient, query: string): Promise<LocationHit[]> {
  const text = query.trim();
  if (text.length < 2 || text.length > 100) return [];
  try {
    const response = await http.get(`${LOCATION_LOOKUP_URL}?typeaheadType=GEO&query=${encodeURIComponent(text)}`, { timeoutMs: 15_000 });
    if (!response.ok) return [];
    return response.json(hitsSchema).map((hit) => ({ id: hit.id, label: hit.displayName }));
  } catch {
    return [];
  }
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * The hit a place name most likely means: LinkedIn's own label equal to the text, then one that starts with it, then the first it listed
 * (LinkedIn puts the best match first). Postal-code entries ("75001, Paris") are skipped unless the text starts with a digit.
 */
export function bestLocation(hits: readonly LocationHit[], query: string): LocationHit | undefined {
  const wanted = fold(query);
  const usable = /^\d/.test(wanted) ? hits : hits.filter((hit) => !/^\d/.test(hit.label));
  const pool = usable.length > 0 ? usable : hits;
  return (
    pool.find((hit) => fold(hit.label) === wanted) ??
    pool.find((hit) => fold(hit.label).startsWith(`${wanted},`) || fold(hit.label).startsWith(wanted)) ??
    pool[0]
  );
}

// ------------------------------------------------------------------------------------------------ remembered places

const KEY_PREFIX = 'linkedin.geo:';
const savedSchema = z.object({ id: z.string().regex(/^\d{3,12}$/), label: z.string().max(200), by: z.enum(['operator', 'auto']) });
export type SavedLocation = z.infer<typeof savedSchema> & { alias: string };

/** The key an alias is kept under: case, accents and extra spaces do not matter. */
export const locationKey = (alias: string): string => `${KEY_PREFIX}${fold(alias).replace(/\s+/g, ' ').slice(0, 100)}`;

export async function savedLocation(memory: PlatformMemory, alias: string): Promise<SavedLocation | null> {
  const raw = await memory.get(locationKey(alias));
  if (raw === null) return null;
  try {
    return { alias: fold(alias), ...savedSchema.parse(JSON.parse(raw)) };
  } catch {
    return null;
  }
}

export async function saveLocation(
  memory: PlatformMemory,
  alias: string,
  place: { id: string; label: string },
  by: 'operator' | 'auto',
): Promise<void> {
  await memory.set(locationKey(alias), JSON.stringify({ id: place.id, label: place.label.slice(0, 200), by }));
}

export async function forgetLocation(memory: PlatformMemory, alias: string): Promise<void> {
  await memory.delete(locationKey(alias));
}

export async function savedLocations(memory: PlatformMemory): Promise<SavedLocation[]> {
  const found: SavedLocation[] = [];
  for (const entry of await memory.list(KEY_PREFIX)) {
    try {
      found.push({ alias: entry.key.slice(KEY_PREFIX.length), ...savedSchema.parse(JSON.parse(entry.value)) });
    } catch {
      // an entry nobody can read is left alone
    }
  }
  return found;
}
