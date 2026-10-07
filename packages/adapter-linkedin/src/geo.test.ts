import { createBrowserTestContext, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolvePlace } from './geo';

const route = (query: string, hits: unknown, status = 200): FakeHttpRoute => ({
  url: new RegExp(`typeaheadHits\\?typeaheadType=GEO&query=${encodeURIComponent(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  body: hits,
  status,
});
const berlin = route('Berlin', [
  { id: '103035651', type: 'GEO', displayName: 'Berlin, Germany' },
  { id: '106967730', type: 'GEO', displayName: 'Berlin, Berlin, Germany' },
  { id: '90009712', type: 'GEO', displayName: 'Berlin Metropolitan Area' },
]);
const make = (...routes: FakeHttpRoute[]) => createBrowserTestContext({ allowedHosts: adapter.allowedHosts, routes });
const lookups = (c: ReturnType<typeof make>) => c.http.requests.filter((request) => request.url.includes('typeaheadHits')).length;

describe('resolvePlace', () => {
  it('keeps a numeric geoId as it is and asks nobody', async () => {
    const c = make();
    expect(await resolvePlace(c.ctx, '103035651', {})).toEqual({ geo: '103035651' });
    expect(lookups(c)).toBe(0);
  });

  it("turns a place name into LinkedIn's own id, says which one and what else it could be, and remembers it", async () => {
    const c = make(berlin);
    const place = await resolvePlace(c.ctx, 'Berlin', {});
    expect(place.geo).toBe('103035651');
    expect(place.note).toContain('Berlin, Germany (geoId 103035651)');
    expect(place.note).toContain('Berlin, Berlin, Germany (106967730)');
    expect(place.note).toContain('Pass a geoId as geo to choose one');
    expect(JSON.parse(c.memory.entries.get('linkedin.geo:berlin') ?? '{}')).toEqual({
      id: '103035651',
      label: 'Berlin, Germany',
      by: 'auto',
    });
  });

  it('logs what LinkedIn suggested for a name it looked up, and nothing for an id or a name it already knows', async () => {
    const c = make(berlin);
    await resolvePlace(c.ctx, '103035651', {});
    await resolvePlace(c.ctx, 'Berlin', {});
    await resolvePlace(c.ctx, 'berlin', {});
    expect(c.places.lookups).toHaveLength(1);
    expect(c.places.lookups[0]).toMatchObject({ query: 'Berlin' });
    expect(c.places.lookups[0]?.hits.map((hit) => hit.id)).toEqual(['103035651', '106967730', '90009712']);
  });

  it('asks once: the second time, any case or accent, comes from memory', async () => {
    const c = make(berlin);
    await resolvePlace(c.ctx, 'Berlin', {});
    const again = await resolvePlace(c.ctx, '  BERLIN ', {});
    expect(again).toEqual({ geo: '103035651' });
    expect(lookups(c)).toBe(1);
  });

  it('uses what the operator saved, and an operator alias from the environment first', async () => {
    const c = make();
    c.memory.entries.set('linkedin.geo:home', JSON.stringify({ id: '555000', label: 'Home', by: 'operator' }));
    expect(await resolvePlace(c.ctx, 'Home', {})).toEqual({ geo: '555000' });
    expect(await resolvePlace(c.ctx, 'home', { LINKEDIN_GEO_ALIASES: 'home=999000' })).toEqual({ geo: '999000' });
    expect(lookups(c)).toBe(0);
  });

  it('uses the default location of the operator when the call gives none', async () => {
    const c = make(berlin);
    expect((await resolvePlace(c.ctx, undefined, { LINKEDIN_DEFAULT_LOCATION: 'Berlin' })).geo).toBe('103035651');
  });

  it('falls back to the name, soft, when LinkedIn answers badly, finds nothing or is not valid JSON', async () => {
    for (const failing of [route('Nowhere', 'blocked', 999), route('Nowhere', []), route('Nowhere', 'not json at all')]) {
      const c = make(failing);
      expect(await resolvePlace(c.ctx, 'Nowhere', {})).toEqual({ geo: 'Nowhere' });
      expect(c.memory.entries.size).toBe(0); // a failure is never remembered
    }
    const silent = make();
    expect(await resolvePlace(silent.ctx, 'Nowhere', {})).toEqual({ geo: 'Nowhere' });
  });

  it('prefers the exact label, then one that starts with the text, and skips postal-code entries', async () => {
    const c = make(
      route('Paris', [
        { id: '104883172', type: 'GEO', displayName: '75001, Paris, Île-de-France, France' },
        { id: '90009659', type: 'GEO', displayName: 'Greater Paris Metropolitan Region' },
        { id: '106383538', type: 'GEO', displayName: 'Paris, Île-de-France, France' },
      ]),
    );
    expect((await resolvePlace(c.ctx, 'Paris', {})).geo).toBe('106383538');
  });

  it('refuses without a place, saying what to set', async () => {
    await expect(resolvePlace(make().ctx, undefined, {})).rejects.toThrow(/LINKEDIN_DEFAULT_LOCATION/);
  });
});
