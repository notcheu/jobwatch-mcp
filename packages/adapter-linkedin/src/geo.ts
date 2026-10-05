import { bestLocation, lookupLocations, saveLocation, savedLocation, type HttpClient, type PlatformMemory } from '@jobwatch/sdk';
import { resolveGeo } from './parse';

export interface ResolvedPlace {
  /** What goes in the search address: a numeric geoId, or the place name when LinkedIn could not say. */
  geo: string;
  /** A sentence for the result when the place was looked up on LinkedIn, so the choice is visible. */
  note?: string;
}

/**
 * The place of a search, as an id when it can be: the argument (else `DEFAULT_LOCATION`) is a geoId, an operator alias, a place
 * remembered from before, or a name that LinkedIn's own autocomplete turns into an id (and that is then remembered, so each place is
 * asked about once). When LinkedIn does not answer, the name goes into the address as it is and LinkedIn resolves it itself.
 */
export async function resolvePlace(
  ctx: { http: HttpClient; memory: PlatformMemory },
  geo: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedPlace> {
  const wanted = resolveGeo(geo, env);
  if (/^\d{3,12}$/.test(wanted)) return { geo: wanted };
  const known = await savedLocation(ctx.memory, wanted);
  if (known !== null) return { geo: known.id };
  const hits = await lookupLocations(ctx.http, wanted);
  const best = bestLocation(hits, wanted);
  if (best === undefined) return { geo: wanted };
  await saveLocation(ctx.memory, wanted, best, 'auto');
  const others = hits
    .filter((hit) => hit.id !== best.id && !/^\d/.test(hit.label))
    .slice(0, 2)
    .map((hit) => `${hit.label} (${hit.id})`);
  return {
    geo: best.id,
    note: `"${wanted}" was looked up on LinkedIn and means ${best.label} (geoId ${best.id}); it is remembered.${
      others.length > 0 ? ` Other matches: ${others.join('; ')}. Pass a geoId as geo to choose one.` : ''
    }`,
  };
}
