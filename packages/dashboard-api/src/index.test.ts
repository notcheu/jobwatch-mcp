import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  CUSTOM_ADAPTER_FILE_FORMAT,
  MAX_ADAPTER_FILE_BYTES,
  adapterFileName,
  adapterFileText,
  callDetailSchema,
  callRowSchema,
  jobDetailSchema,
  jobRowSchema,
  meSchema,
  parseAdapterFile,
} from './index';

const row = {
  id: 1,
  requestId: 'r',
  tool: 't',
  platform: 'p',
  state: 'done',
  code: 'ok',
  startedAt: '2026-10-09T12:00:00.000Z',
  durationMs: 5,
  unitsReserved: 1,
  unitsSpent: 1,
  responseBytes: 10,
  estimatedTokens: 3,
  warnings: 0,
  keywords: null,
};
const job = {
  source: 'linkedin',
  id: '1',
  board: null,
  title: 't',
  company: 'c',
  location: 'l',
  url: 'https://x/1',
  firstSeen: '2026-10-09T12:00:00.000Z',
  fetchedAt: '2026-10-09T12:00:00.000Z',
  lastSeen: '2026-10-09T12:00:00.000Z',
  descriptionChars: 3,
  salary: null,
  foundBy: [],
};

describe('the response types', () => {
  it('are mounted under /dashboard', () => {
    expect(API_PREFIX).toBe('/dashboard/api/v1');
  });

  it('reject a field they do not name, so a database column cannot leak through them', () => {
    expect(callRowSchema.safeParse(row).success).toBe(true);
    expect(callRowSchema.safeParse({ ...row, params: { keywords: 'x' } }).success).toBe(false);
    expect(jobRowSchema.safeParse(job).success).toBe(true);
    expect(jobRowSchema.safeParse({ ...job, description: 'the whole text' }).success).toBe(false);
    expect(
      meSchema.safeParse({
        mode: 'google',
        email: 'a@b.c',
        signedInAt: null,
        expiresAt: null,
        idleStopAt: null,
        writableUntil: null,
        version: 'x',
        token: 'y',
      }).success,
    ).toBe(false);
  });

  it('carry the salary as numbers and a label, and nothing else', () => {
    const salary = { min: 65_000, max: 90_000, currency: 'EUR', variable: null };
    expect(jobRowSchema.safeParse({ ...job, salary }).success).toBe(true);
    expect(jobRowSchema.safeParse({ ...job, salary: { ...salary, extra: 1 } }).success).toBe(false);
  });

  it('keep the parameters of a call and the description of a job to their detail types', () => {
    expect(
      callDetailSchema.safeParse({
        ...row,
        adapter: 'a',
        argsHash: null,
        params: { a: 1 },
        paramsTruncated: false,
        paramsDropped: false,
        jobText: null,
      }).success,
    ).toBe(true);
    expect(
      jobDetailSchema.safeParse({
        ...job,
        description: 'd',
        summary: 's',
        summaryKind: null,
        outline: [],
        hints: { years: [], remote: [], salary: null },
      }).success,
    ).toBe(true);
  });
});

describe('the file of an exported custom adapter', () => {
  const entry = {
    handle: 'bpce',
    name: 'BPCE careers',
    kind: 'http' as const,
    url: 'https://recrutement.bpce.fr',
    script: 'async function read(board, filters) {\n  return { postings: [] };\n}',
    filters: [
      {
        name: 'contract',
        description: 'The contract.',
        type: 'multiselect' as const,
        options: [{ value: 'cdi', label: 'CDI' }, { value: 'cdd' }],
      },
      { name: 'remote', description: 'Remote only.', type: 'boolean' as const, default: true },
    ],
  };

  it('is named after the handle', () => {
    expect(adapterFileName('bpce')).toBe('bpce.adapter.json');
  });

  it('holds what is typed in the modal and nothing else, readable, with a final line break', () => {
    const text = adapterFileText(entry);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'version', 'handle', 'name', 'kind', 'url', 'script', 'filters']);
    expect(JSON.parse(text)).toMatchObject({ format: CUSTOM_ADAPTER_FILE_FORMAT, version: 1, handle: 'bpce' });
    expect(text).toContain('\n  "handle": "bpce"'); // indented
  });

  it('reads back as the adapter it was made from', () => {
    expect(parseAdapterFile(adapterFileText(entry))).toEqual({ file: { format: CUSTOM_ADAPTER_FILE_FORMAT, version: 1, ...entry } });
  });

  it.each([
    ['text that is not JSON', 'nope', /not JSON/],
    ['JSON that is not an adapter', '{"a":1}', /not an exported custom adapter/],
    ['an array', '[]', /not an exported custom adapter/],
    ['another format', JSON.stringify({ format: 'other', version: 1 }), /not an exported custom adapter/],
    [
      'a version this dashboard does not know',
      JSON.stringify({ format: CUSTOM_ADAPTER_FILE_FORMAT, version: 2 }),
      /version 2; this dashboard reads version 1/,
    ],
    ['a missing field', JSON.stringify({ format: CUSTOM_ADAPTER_FILE_FORMAT, version: 1, handle: 'bpce' }), /not valid \(name/],
    ['a handle that is not one', adapterFileText({ ...entry, handle: 'Bad-Handle' }), /not valid \(handle/],
    ['an address that is too short', adapterFileText({ ...entry, url: 'x' }), /not valid \(url/],
    [
      'a filter that breaks the rules',
      adapterFileText({ ...entry, filters: [{ name: 'x', description: 'x', type: 'select', options: [{ value: 'a' }] }] }),
      /not valid \(filters/,
    ],
    ['more than the file may hold', 'x'.repeat(MAX_ADAPTER_FILE_BYTES + 1), /too large/],
  ])('refuses %s, with a sentence', (_what, text, message) => {
    const result = parseAdapterFile(text);
    expect('error' in result && result.error).toMatch(message);
  });

  it('refuses a field it does not know, so a file cannot carry more than the form takes', () => {
    const text = JSON.stringify({ ...JSON.parse(adapterFileText(entry)), enabled: true });
    expect('error' in parseAdapterFile(text)).toBe(true);
  });
});
