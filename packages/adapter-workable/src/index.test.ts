import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Shaped like `GET apply.workable.com/api/v1/widget/accounts/<account>?details=true` (checked against Hugging Face). */
function job(code: string, title: string, over: { city?: string; days?: number; remote?: boolean; hidden?: boolean } = {}) {
  return {
    title,
    shortcode: code,
    code: '',
    employment_type: 'Full-time',
    telecommuting: over.remote ?? false,
    department: 'Engineering',
    url: `https://apply.workable.com/j/${code}`,
    shortlink: `https://apply.workable.com/j/${code}`,
    application_url: `https://apply.workable.com/j/${code}/apply`,
    published_on: ago(over.days ?? 2),
    created_at: ago(over.days ?? 2),
    country: 'France',
    city: over.city ?? 'Paris',
    state: 'Île-de-France',
    locations: [
      { country: 'France', countryCode: 'FR', city: over.city ?? 'Paris', region: 'Île-de-France', hidden: over.hidden ?? false },
    ],
    description: `<p>Join us as ${title}. We use React and TypeScript.</p><ul><li>5 years of experience required.</li></ul>`,
  };
}

const acme = {
  name: 'Acme',
  description: 'About Acme',
  jobs: [
    job('AAAA000001', 'Senior Frontend Engineer', { days: 3 }),
    job('AAAA000002', 'Backend Engineer', { days: 9 }),
    job('AAAA000003', 'Fullstack Developer', { remote: true, city: 'Lyon', days: 1 }),
  ],
};
const ACME = 'https://apply.workable.com/api/v1/widget/accounts/acme?details=true';
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'workable', routes });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: { id: string; board: string; company: string | null; locations: string[]; description: string; source: string; url: string }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { workable_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('resolving a board', () => {
  const feed = (handle: string) => `https://apply.workable.com/api/v1/widget/accounts/${handle}?details=true`;

  it('takes an account name', () => {
    expect(resolveBoard('huggingface')).toEqual({ feedUrl: feed('huggingface'), label: 'huggingface' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: feed('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://apply.workable.com/huggingface/', 'huggingface'],
    ['https://apply.workable.com/huggingface/j/81B46579FE/', 'huggingface'],
    ['https://huggingface.workable.com', 'huggingface'],
    ['https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true', 'huggingface'],
  ])('takes the account from %s', (url, handle) => {
    expect(resolveBoard(url)).toEqual({ feedUrl: feed(handle), label: handle });
  });

  it.each([
    'http://apply.workable.com/huggingface/',
    'https://apply.workable.com:8443/huggingface/',
    'https://user@apply.workable.com/huggingface/',
    'https://apply.workable.com.evil.example/huggingface/',
    'https://apply.workable.com/j/81B46579FE',
    'https://apply.workable.com/',
    'https://www.workable.com/',
    'https://a.b.workable.com',
    'https://example.com/huggingface',
    'HuggingFace',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });

  it('only ever points at apply.workable.com', () => {
    for (const input of ['acme', 'https://acme.workable.com', 'https://apply.workable.com/acme/'])
      expect(new URL(resolveBoard(input)?.feedUrl ?? '').hostname).toBe('apply.workable.com');
  });
});

describe('workable_jobs', () => {
  it('reads a board in one request and names the company from the account', async () => {
    const c = context();
    const result = await run(c.ctx);
    expect(c.spent()).toBe(1);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['AAAA000003', 'AAAA000001', 'AAAA000002']);
    expect(data(result).jobs.find((j) => j.id === 'AAAA000001')).toMatchObject({
      source: 'workable',
      board: 'acme',
      company: 'Acme',
      url: 'https://apply.workable.com/j/AAAA000001',
      locations: ['Paris, France'],
    });
    expect(data(result).boards).toEqual([{ board: 'acme', feed_url: ACME, status: 'ok', jobs_total: 3, relevant: 3 }]);
    const full = await run(c.ctx, { detail: 'full' });
    expect(data(full).jobs.find((j) => j.id === 'AAAA000001')?.description).toContain('We use React and TypeScript.');
    expect(data(full).jobs.find((j) => j.id === 'AAAA000001')?.description).toContain('5 years of experience required.');
  });

  it('says so in the location when a job is remote, so location filters can find it', async () => {
    const result = await run(context().ctx, { location_any: ['remote'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['AAAA000003']);
    expect(data(result).jobs[0]?.locations).toEqual(['Lyon, France', 'Remote']);
  });

  it('reports a company that does not exist, an error and a changed shape, each on its own', async () => {
    const c = context([
      route(ACME, acme),
      route('https://apply.workable.com/api/v1/widget/accounts/ghost?details=true', { error: 'not found' }, 404),
      route('https://apply.workable.com/api/v1/widget/accounts/down?details=true', '', 503),
      route('https://apply.workable.com/api/v1/widget/accounts/odd?details=true', { nope: 1 }),
    ]);
    const result = await tool.handler(tool.input.parse({ boards: ['acme', 'ghost', 'down', 'odd'] }), c.ctx);
    expect((result.data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status])).toEqual([
      ['acme', 'ok'],
      ['ghost', 'not_found'],
      ['down', 'error'],
      ['odd', 'not_this_ats'],
    ]);
    expect(c.spent()).toBe(4);
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme ', 'https://apply.workable.com/acme/', 'https://acme.workable.com', 'Nope!'])).toEqual(['acme']);
  });

  it('gives every company its own budget', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
