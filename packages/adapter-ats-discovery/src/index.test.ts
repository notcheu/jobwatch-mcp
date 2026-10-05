import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import { candidateHandles, knownBoard } from './handles';
import adapter, { atsFind } from './index';

const GREENHOUSE: FakeHttpRoute = {
  url: /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs/,
  body: { jobs: [{ title: 'Backend Engineer' }, { title: 'Designer' }] },
};
const LEVER: FakeHttpRoute = { url: /api\.lever\.co\/v0\/postings\/acme/, body: [{ text: 'Data Scientist' }] };
/** Like the real hosts, anything not routed is a 404. */
const NOT_FOUND: FakeHttpRoute = { url: /./, body: 'not found', status: 404 };
const make = (...routes: FakeHttpRoute[]) => createHttpTestContext({ allowedHosts: adapter.allowedHosts, routes: [...routes, NOT_FOUND] });
const run = (routes: FakeHttpRoute[], args: object) => atsFind.handler(atsFind.input.parse(args), make(...routes).ctx);

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { ats_find: { args: { companies: ['Acme'] }, run: (args) => atsFind.handler(atsFind.input.parse(args), make(GREENHOUSE).ctx) } },
});

describe('handles', () => {
  it('derives spellings from a name, and the name label from a site', () => {
    expect(candidateHandles('Société Générale', 3)).toEqual(['societe-generale', 'societegenerale', 'societe']);
    expect(candidateHandles('PayFit', 3)).toEqual(['payfit']);
    expect(candidateHandles('https://careers.acme.co.uk/jobs', 3)).toEqual(['acme']);
    expect(candidateHandles('www.acme.com', 3)).toEqual(['acme']);
    expect(candidateHandles('Acme Labs', 1)).toEqual(['acme-labs']);
  });

  it('reads the handle of a board address and nothing from any other address', () => {
    expect(knownBoard('https://jobs.lever.co/swile/123')).toEqual({ ats: 'lever', handle: 'swile' });
    expect(knownBoard('https://boards.greenhouse.io/embed/job_board?for=algolia')).toEqual({ ats: 'greenhouse', handle: 'algolia' });
    expect(knownBoard('https://bsport.teamtailor.com/jobs')).toEqual({ ats: 'teamtailor', handle: 'bsport' });
    expect(knownBoard('https://www.acme.com/careers')).toBeNull();
    expect(knownBoard('http://jobs.lever.co/swile')).toBeNull();
    expect(knownBoard('Acme')).toBeNull();
  });
});

describe('ats_find', () => {
  it('finds the boards a name has, with the tool to read them and a few titles', async () => {
    const result = await run([GREENHOUSE, LEVER], { companies: ['Acme'] });
    const [company] = result.data.companies;
    expect(company?.tried).toEqual(['acme']);
    expect(company?.matches.map((m) => [m.ats, m.handle, m.reading_tool, m.jobs])).toEqual([
      ['greenhouse', 'acme', 'greenhouse_jobs', 2],
      ['lever', 'acme', 'lever_jobs', 1],
    ]);
    expect(company?.matches[0]?.sample_titles).toEqual(['Backend Engineer', 'Designer']);
    expect(result.warnings.join(' ')).toMatch(/several boards matched/);
  });

  it('reports no match, never an error, for a company on another ATS or a host that does not answer', async () => {
    const result = await run(
      [
        { url: /lever/, body: 'down', status: 503 },
        { url: /ashby/, body: { unexpected: true } },
      ],
      {
        companies: ['Nobody Inc'],
      },
    );
    expect(result.data.companies[0]?.matches).toEqual([]);
    expect(result.data.companies[0]?.tried).toEqual(['nobody-inc', 'nobodyinc']);
    expect(result.warnings.join(' ')).toMatch(/no board found/);
  });

  it('checks a single board for an ATS address, and only the ATS asked for otherwise', async () => {
    const byAddress = await run([LEVER], { companies: ['https://jobs.lever.co/acme'] });
    expect(byAddress.data.companies[0]?.matches.map((m) => [m.ats, m.from_address])).toEqual([['lever', true]]);
    const onlyLever = await run([GREENHOUSE, LEVER], { companies: ['Acme'], ats: ['lever'] });
    expect(onlyLever.data.companies[0]?.matches.map((m) => m.ats)).toEqual(['lever']);
  });

  it('estimates one request per handle and ATS', () => {
    const estimate = atsFind.limits.estimate;
    expect(estimate?.(atsFind.input.parse({ companies: ['Acme Labs', 'https://jobs.lever.co/x'], handles_per_company: 2 }))).toBe(
      2 * 4 + 1,
    );
  });
});
