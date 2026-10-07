import { AdapterBroken } from '@jobwatch/sdk';
import { createHttpTestContext, describeAdapterContract, type FakeHttpRoute } from '@jobwatch/sdk/testkit';
import { describe, expect, it } from 'vitest';
import adapter from './index';
import { resolveBoard } from './board';
import { child, childText, parseXml } from './xml';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().replace('.000Z', '+00:00');

/** Shaped like `GET <handle>.jobs.personio.de/xml` (checked against Helpling and Personio's own board). */
function position(
  id: number,
  name: string,
  over: { office?: string; extra?: string; days?: number; subcompany?: string; salary?: string } = {},
): string {
  return `<position>
    <id>${id}</id>
    ${over.subcompany === undefined ? '' : `<subcompany>${over.subcompany}</subcompany>`}
    <office>${over.office ?? 'Berlin'}</office>
    ${over.extra === undefined ? '' : `<additionalOffices><office>${over.extra}</office></additionalOffices>`}
    <department>Product and Tech</department>
    <recruitingCategory>Engineering</recruitingCategory>
    <name>${name}</name>
    <jobDescriptions>
      <jobDescription><name>Your role</name><value><![CDATA[<p>Join us as ${name}. We use React &amp; TypeScript.</p>]]></value></jobDescription>
      <jobDescription><name>What you bring</name><value><![CDATA[<ul><li>5 years of experience required.</li></ul>]]></value></jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <schedule>full-time</schedule>
    <createdAt>${ago(over.days ?? 2)}</createdAt>
    ${over.salary ?? ''}
  </position>`;
}
const feed = (...positions: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>\n${positions.join('\n')}\n</workzag-jobs>`;
const acme = feed(
  position(9001, 'Senior Frontend Engineer', {
    days: 3,
    subcompany: 'Acme GmbH',
    salary:
      '<salaryInformation><min>60000.00</min><max>80000.00</max><currencySymbol>€</currencySymbol><currencyCode>EUR</currencyCode><type>yearly</type></salaryInformation>',
  }),
  position(9002, 'Backend Engineer', { days: 9, office: 'Munich', extra: 'Berlin' }),
  position(9003, 'Fullstack &amp; Data Developer', { days: 1, office: 'Hamburg' }),
);
const ACME = 'https://acme.jobs.personio.de/xml';
const route = (url: string, body: unknown, status = 200): FakeHttpRoute => ({ url, body, status });
const context = (routes: FakeHttpRoute[] = [route(ACME, acme)]) =>
  createHttpTestContext({ allowedHosts: adapter.allowedHosts, platform: 'personio', routes });
const tool = adapter.tools[0];
if (tool === undefined) throw new Error('no tool');
type Ctx = ReturnType<typeof context>['ctx'];
const run = (ctx: Ctx, over: object = {}) => tool.handler(tool.input.parse({ boards: ['acme'], ...over }), ctx);
const data = (result: Awaited<ReturnType<typeof run>>) =>
  result.data as {
    jobs: {
      id: string;
      title: string;
      board: string;
      company: string | null;
      url: string;
      locations: string[];
      description: string;
      source: string;
    }[];
    boards: { board: string; status: string; jobs_total: number | null; relevant: number | null }[];
  };

describeAdapterContract(adapter, {
  snapshotDir: new URL('../catalog', import.meta.url).pathname,
  samples: { personio_jobs: { args: { boards: ['acme'] }, run: (args) => tool.handler(args, context().ctx) } },
});

describe('the XML reader', () => {
  it('reads elements, text, CDATA, entities and character references, and skips the declaration, comments and attributes', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><a x="1"><b>R&amp;D &#233; &#xE9; &unknown;</b><c><![CDATA[<p>1 < 2 & 3</p>]]></c><d/><d></d></a>',
    );
    expect(root.name).toBe('a');
    expect(childText(root, 'b')).toBe('R&D é é &unknown;');
    expect(childText(root, 'c')).toBe('<p>1 < 2 & 3</p>');
    expect(root.children.filter((entry) => entry.name === 'd')).toHaveLength(2);
    expect(child(root, 'd')?.text).toBe('');
    expect(childText(root, 'd')).toBeNull();
  });

  it.each([
    ['a document type, which could define entities', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ['an entity declaration', '<a><!ENTITY x "y"></a>'],
    ['an unclosed element', '<a><b></a>'],
    ['a closing tag that does not match', '<a></b>'],
    ['text before the root', 'hello<a></a>'],
    ['two roots', '<a></a><b></b>'],
    ['no root', ''],
    ['a stray angle bracket', '<a>1 < 2</a>'],
    ['nesting that is too deep', `${'<a>'.repeat(40)}${'</a>'.repeat(40)}`],
  ])('refuses %s', (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(AdapterBroken);
  });

  it('does not expand an entity: a billion-laughs document stays small', () => {
    const bomb = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    expect(() => parseXml(bomb)).toThrow(AdapterBroken);
  });
});

describe('resolving a board', () => {
  const url = (handle: string) => `https://${handle}.jobs.personio.de/xml`;

  it('takes a subdomain', () => {
    expect(resolveBoard('helpling')).toEqual({ feedUrl: url('helpling'), label: 'helpling' });
    expect(resolveBoard(' acme-labs ')).toEqual({ feedUrl: url('acme-labs'), label: 'acme-labs' });
  });

  it.each([
    ['https://helpling.jobs.personio.de', 'helpling'],
    ['https://helpling.jobs.personio.com/job/2798024', 'helpling'],
    ['https://helpling.jobs.personio.de/xml?language=en', 'helpling'],
  ])('takes the subdomain from %s', (input, handle) => {
    expect(resolveBoard(input)).toEqual({ feedUrl: url(handle), label: handle });
  });

  it.each([
    'http://helpling.jobs.personio.de',
    'https://helpling.jobs.personio.de:8443',
    'https://user@helpling.jobs.personio.de',
    'https://helpling.jobs.personio.de.evil.example',
    'https://jobs.personio.de',
    'https://helpling.personio.de',
    'https://a.b.jobs.personio.de',
    'Helpling',
    'a/b',
    '',
  ])('refuses %j', (input) => {
    expect(resolveBoard(input)).toBeNull();
  });
});

describe('personio_jobs', () => {
  it('reads a board in one request, with the sections of the text and the company when the feed names one', async () => {
    const c = context();
    const result = await run(c.ctx, { detail: 'full' });
    expect(c.spent()).toBe(1);
    expect(data(result).jobs.map((j) => j.id)).toEqual(['9003', '9001', '9002']);
    const first = data(result).jobs.find((j) => j.id === '9001');
    expect(first).toMatchObject({
      source: 'personio',
      board: 'acme-gmbh',
      company: 'Acme GmbH',
      url: 'https://acme.jobs.personio.de/job/9001',
      locations: ['Berlin'],
    });
    expect(first?.description).toContain('Your role\nJoin us as Senior Frontend Engineer. We use React & TypeScript.');
    expect(first?.description).toContain('What you bring');
    expect(first?.description).toContain('Salary: 60000.00-80000.00 EUR yearly');
    expect(data(result).jobs.find((j) => j.id === '9003')?.title).toBe('Fullstack & Data Developer');
    expect(data(result).jobs.find((j) => j.id === '9002')?.locations).toEqual(['Munich', 'Berlin']);
    expect(data(result).boards).toEqual([{ board: 'acme-gmbh', feed_url: ACME, status: 'ok', jobs_total: 3, relevant: 3 }]);
  });

  it('filters by office, the additional ones included', async () => {
    const result = await run(context().ctx, { location_any: ['berlin'] });
    expect(data(result).jobs.map((j) => j.id)).toEqual(['9001', '9002']);
  });

  it('reports a board that does not exist, an error and an answer that is not a Personio feed, each on its own', async () => {
    const c = context([
      route(ACME, acme),
      route('https://ghost.jobs.personio.de/xml', 'not found', 404),
      route('https://down.jobs.personio.de/xml', '', 503),
      route('https://odd.jobs.personio.de/xml', '<html><body>hello</body></html>'),
      route('https://bomb.jobs.personio.de/xml', '<!DOCTYPE x [<!ENTITY a "b">]><workzag-jobs>&a;</workzag-jobs>'),
    ]);
    const statuses = async (boards: string[]) =>
      ((await tool.handler(tool.input.parse({ boards }), c.ctx)).data as ReturnType<typeof data>).boards.map((b) => [b.board, b.status]);
    expect(await statuses(['acme', 'ghost', 'down'])).toEqual([
      ['acme-gmbh', 'ok'],
      ['ghost', 'not_found'],
      ['down', 'error'],
    ]);
    expect(await statuses(['odd', 'bomb'])).toEqual([
      ['odd', 'not_this_ats'],
      ['bomb', 'not_this_ats'],
    ]);
  });

  it('reads an empty board as a board with no jobs', async () => {
    const result = await run(context([route(ACME, feed())]).ctx);
    expect(data(result).boards[0]).toMatchObject({ status: 'ok', jobs_total: 0 });
  });
});

describe('the budget per company board', () => {
  const keys = (boards: string[]) => tool.limits.keys?.(tool.input.parse({ boards })) ?? [];

  it('names each distinct company once, whichever way it was written, and none for what cannot be a board', () => {
    expect(keys(['acme', ' acme ', 'https://acme.jobs.personio.com/job/1', 'Nope!'])).toEqual(['acme']);
  });

  it('gives every company its own budget', () => {
    expect(adapter.keyRate).toEqual({ perHour: 20, perDay: 100 });
  });
});
