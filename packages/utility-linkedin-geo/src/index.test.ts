import { JobwatchError } from '@jobwatch/sdk';
import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter, { locations } from './index';

const BERLIN: FakeHttpRoute = {
  url: /typeaheadHits\?typeaheadType=GEO&query=Berlin$/,
  body: [
    { id: '103035651', type: 'GEO', displayName: 'Berlin, Germany' },
    { id: '90009712', type: 'GEO', displayName: 'Berlin Metropolitan Area' },
    { id: '105506608', type: 'GEO', displayName: 'Berlin, Connecticut, United States' },
  ],
};
const make = (...routes: FakeHttpRoute[]) => createHttpTestContext({ allowedHosts: adapter.allowedHosts, routes });
const run = (ctx: ReturnType<typeof make>['ctx'], args: object) => locations.handler(locations.input.parse(args), ctx);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    linkedin_locations: { args: { query: 'Berlin' }, run: (args) => locations.handler(locations.input.parse(args), make(BERLIN).ctx) },
  },
});

describe('linkedin_locations: look up', () => {
  it('lists what LinkedIn suggests and which one a search by that name would use', async () => {
    const result = await run(make(BERLIN).ctx, { query: 'Berlin' });
    expect(result.data.places.map((place) => place.id)).toEqual(['103035651', '90009712', '105506608']);
    expect(result.data.best).toEqual({ id: '103035651', label: 'Berlin, Germany' });
  });

  it('logs each lookup with its candidates, and nothing for a save or a list', async () => {
    const c = make(BERLIN);
    await run(c.ctx, { query: 'Berlin' });
    await run(c.ctx, { save_as: 'home', id: '103035651' });
    await run(c.ctx, { list: true });
    expect(c.places.lookups).toHaveLength(1);
    expect(c.places.lookups[0]).toMatchObject({ query: 'Berlin' });
    expect(c.places.lookups[0]?.hits.length).toBeGreaterThan(0);
  });

  it('says so when LinkedIn suggests nothing or does not answer, and never throws for it', async () => {
    for (const routes of [
      [],
      [{ url: /typeaheadHits/, body: [] }],
      [{ url: /typeaheadHits/, body: 'blocked', status: 999 }],
    ] as FakeHttpRoute[][]) {
      const result = await run(make(...routes).ctx, { query: 'Berlin' });
      expect(result.data.places).toEqual([]);
      expect(result.warnings[0]).toContain('suggested nothing');
    }
  });

  it('is one request to LinkedIn, billed as one unit', async () => {
    const c = make(BERLIN);
    await run(c.ctx, { query: 'Berlin' });
    expect(c.spent()).toBe(1);
    expect(c.http.requests.every((request) => request.url.startsWith('https://www.linkedin.com/'))).toBe(true);
  });
});

describe('linkedin_locations: remember', () => {
  it('saves a name for a geoId (no request to LinkedIn, no unit), lists it, and forgets it', async () => {
    const c = make(BERLIN);
    const saved = await run(c.ctx, { save_as: 'Home', id: '103035651', label: 'Berlin, Germany' });
    expect(saved.data.saved).toMatchObject({ alias: 'home', id: '103035651', label: 'Berlin, Germany', saved_by: 'operator' });
    expect(saved.cost).toBe(0);
    expect(c.http.requests).toHaveLength(0);
    expect((await run(c.ctx, { list: true })).data.remembered.map((entry) => [entry.alias, entry.id])).toEqual([['home', '103035651']]);
    const gone = await run(c.ctx, { forget: 'HOME' });
    expect(gone.data.forgotten).toBe('HOME');
    expect(gone.data.remembered).toEqual([]);
  });

  it('shows the names a search remembered by itself, as such', async () => {
    const c = make();
    c.memory.entries.set('linkedin.geo:berlin', JSON.stringify({ id: '103035651', label: 'Berlin, Germany', by: 'auto' }));
    expect((await run(c.ctx, { list: true })).data.remembered).toEqual([
      { alias: 'berlin', id: '103035651', label: 'Berlin, Germany', saved_by: 'auto' },
    ]);
  });

  it('refuses a call that does not ask for exactly one thing, or a name without its id', async () => {
    const c = make();
    for (const args of [
      {},
      { query: 'Berlin', list: true },
      { save_as: 'x1', id: '103035651', forget: 'y1' },
      { save_as: 'home' },
      { id: '103035651' },
    ]) {
      await expect(run(c.ctx, args), JSON.stringify(args)).rejects.toBeInstanceOf(JobwatchError);
    }
  });

  it('refuses an id that is not a geoId before it reaches the memory', () => {
    expect(locations.input.safeParse({ save_as: 'home', id: '12; DROP' }).success).toBe(false);
    expect(locations.input.safeParse({ query: 'Berlin', extra: 1 }).success).toBe(false);
  });
});
