import { JobwatchError, type BaseContext } from '@jobwatch/sdk';
import { createHttpTestContext, describeAdapterContract } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { atsOfUrl } from './route';

function atsJobsTool() {
  const [first] = adapter.tools;
  if (first === undefined) throw new Error('the adapter has no tools');
  return first;
}

interface Out {
  jobs: { id: string }[];
  not_returned_ids: string[];
  boards: { board: string; ats: string | null; status: string; message?: string }[];
}

const job = (id: string, source: string, postedAt: string | null) => ({
  id,
  source,
  board: 'acme',
  company: 'Acme',
  title: `Job ${id}`,
  locations: [],
  url: `https://example.com/${id}`,
  posted_at: postedAt,
  summary: '',
  summary_kind: null,
  description: '',
  description_truncated: false,
  description_chars: 0,
  read_from: 'fetched' as const,
  new: true,
  first_seen: '2026-01-01T00:00:00.000Z',
  fetched_at: '2026-01-01T00:00:00.000Z',
  last_seen: '2026-01-01T00:00:00.000Z',
  matched_terms: [],
  years_hints: [],
  remote_hints: [],
  salary_text: null,
});

const report = (board: string) => ({ board, feed_url: null, status: 'ok' as const, jobs_total: 1, relevant: 1 });
const answer = (_source: string, board: string, ...jobs: ReturnType<typeof job>[]) => ({
  jobs,
  not_returned_ids: [],
  excluded: [],
  boards: [report(board)],
});

type Call = { name: string; args: Record<string, unknown> };

/** A context whose `callTool` plays the engine: `tools` answers by tool name, every call is recorded. */
function setup(tools: Record<string, (args: Record<string, unknown>) => unknown>) {
  const { ctx, companies } = createHttpTestContext({ allowedHosts: [] });
  const calls: Call[] = [];
  const withCall: BaseContext = {
    ...ctx,
    callTool: (name, args) => {
      calls.push({ name, args: args as Record<string, unknown> });
      const handler = tools[name];
      if (handler === undefined) return Promise.reject(new JobwatchError('invalid_arguments', `${name} is not reachable`));
      return Promise.resolve(handler(args as Record<string, unknown>));
    },
  };
  const run = async (input: Record<string, unknown>) => {
    const tool = atsJobsTool();
    const produced = await tool.handler(tool.input.parse(input), withCall);
    return tool.output.parse(produced.data) as Out;
  };
  return { run, calls, companies };
}

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: {
    ats_jobs: {
      args: { boards: ['https://jobs.lever.co/acme'] },
      run: (args) => {
        const { ctx } = createHttpTestContext({ allowedHosts: [] });
        return atsJobsTool().handler(args, {
          ...ctx,
          callTool: () => Promise.resolve(answer('lever', 'acme', job('1', 'lever', null))),
        });
      },
    },
  },
});

describe('atsOfUrl', () => {
  it('names the ATS of a board address', () => {
    expect(atsOfUrl('https://jobs.lever.co/acme')).toBe('lever');
    expect(atsOfUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers')).toBe('workday');
    expect(atsOfUrl('https://acme.teamtailor.com/jobs')).toBe('teamtailor');
    expect(atsOfUrl('https://evil.com/jobs.lever.co')).toBeNull();
    expect(atsOfUrl('http://jobs.lever.co/acme')).toBeNull();
    expect(atsOfUrl('Acme')).toBeNull();
  });
});

describe('ats_jobs routing', () => {
  it('routes an ATS address to its tool with no lookup', async () => {
    const { run, calls } = setup({ lever_jobs: () => answer('lever', 'acme', job('1', 'lever', null)) });
    const out = await run({ boards: ['https://jobs.lever.co/acme'] });
    expect(calls.map((call) => call.name)).toEqual(['lever_jobs']);
    expect(out.boards).toMatchObject([{ board: 'acme', ats: 'lever', status: 'ok' }]);
  });

  it('uses the operator mapping and never runs the discovery', async () => {
    const { run, calls, companies } = setup({ ashby_jobs: () => answer('ashby', 'acme', job('1', 'ashby', null)) });
    companies.set('Acme Corp', 'ashby', 'acme');
    const out = await run({ boards: ['Acme Corp'] });
    expect(calls.map((call) => call.name)).toEqual(['ashby_jobs']);
    expect(calls[0]?.args.boards).toEqual(['Acme Corp']);
    expect(out.boards[0]?.ats).toBe('ashby');
  });

  it('falls back to ats_find for an unmapped company and reads the best board', async () => {
    const { run, calls } = setup({
      ats_find: () => ({
        companies: [
          {
            matches: [
              { ats: 'lever', handle: 'acme', jobs: 3 },
              { ats: 'greenhouse', handle: 'acmeinc', jobs: 40 },
            ],
          },
        ],
      }),
      greenhouse_jobs: () => answer('greenhouse', 'acmeinc', job('1', 'greenhouse', null)),
    });
    await run({ boards: ['Acme'] });
    expect(calls.map((call) => call.name)).toEqual(['ats_find', 'greenhouse_jobs']);
    expect(calls[1]?.args.boards).toEqual(['acmeinc']);
  });

  it('reports a company nobody knows, and one whose discovery is off', async () => {
    const none = setup({ ats_find: () => ({ companies: [{ matches: [] }] }) });
    expect((await none.run({ boards: ['Ghost'] })).boards).toMatchObject([{ status: 'not_found', ats: null }]);
    const off = setup({});
    const out = await off.run({ boards: ['Ghost'] });
    expect(out.boards[0]?.message).toMatch(/not enabled/);
  });

  it('does not run the discovery when the ats argument leaves nothing it can recognise', async () => {
    const { run, calls } = setup({});
    const out = await run({ boards: ['Acme'], ats: ['workday'] });
    expect(calls).toEqual([]);
    expect(out.boards[0]?.status).toBe('not_found');
  });

  it('groups the companies of one ATS into one call and hands the filters on', async () => {
    const { run, calls } = setup({
      lever_jobs: (args) => answer('lever', String((args.boards as string[]).join(',')), job('1', 'lever', null)),
    });
    await run({ boards: ['https://jobs.lever.co/a', 'https://jobs.lever.co/b'], title_any: ['react'], max_results: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({
      title_any: ['react'],
      max_results: 5,
      boards: ['https://jobs.lever.co/a', 'https://jobs.lever.co/b'],
    });
    expect(calls[0]?.args).not.toHaveProperty('ats');
  });

  it('keeps at most max_per_company jobs of each company, so a large board cannot crowd out a small one', async () => {
    const big = Array.from({ length: 5 }, (_, i) => job(`g${i}`, 'greenhouse', `2026-03-0${i + 1}`));
    const { run, calls } = setup({
      greenhouse_jobs: () => answer('greenhouse', 'big', ...big),
      ashby_jobs: () => answer('ashby', 'small', job('a1', 'ashby', '2026-01-01')),
    });
    const out = await run({
      boards: ['https://boards.greenhouse.io/big', 'https://jobs.ashbyhq.com/small'],
      max_per_company: 2,
      max_results: 3,
    });
    expect(out.jobs.map((entry) => entry.id)).toEqual(['g4', 'g3', 'a1']);
    expect(out.not_returned_ids.sort()).toEqual(['g0', 'g1', 'g2']);
    expect(calls.every((call) => !('max_per_company' in call.args))).toBe(true);
  });

  it('merges the ATS newest first, caps at max_results and keeps going when one ATS fails', async () => {
    const { run } = setup({
      lever_jobs: () => answer('lever', 'a', job('l1', 'lever', '2026-03-01'), job('l2', 'lever', '2026-01-01')),
      ashby_jobs: () => answer('ashby', 'b', job('a1', 'ashby', '2026-02-01')),
      workday_jobs: () => {
        throw new JobwatchError('rate_limited', 'Budget used up.');
      },
    });
    const out = await run({
      boards: ['https://jobs.lever.co/a', 'https://jobs.ashbyhq.com/b', 'https://acme.wd3.myworkdayjobs.com/x'],
      max_results: 2,
    });
    expect(out.jobs.map((entry) => entry.id)).toEqual(['l1', 'a1']);
    expect(out.not_returned_ids).toEqual(['l2']);
    const byAts = Object.fromEntries(out.boards.map((entry) => [entry.ats, entry.status]));
    expect(byAts).toEqual({ lever: 'ok', ashby: 'ok', workday: 'error' });
  });
});
