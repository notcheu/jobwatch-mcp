import { describe, expect, it } from 'vitest';
import { browserAdapter, httpAdapter } from './__fixtures__/adapters';
import { buildCatalog, catalogFileName, stableStringify } from './catalog';
import { summarizeAdapter } from './adapter';

describe('buildCatalog', () => {
  it('describes each tool in the documented snapshot format', () => {
    const [entry] = buildCatalog(httpAdapter);
    expect(entry).toMatchObject({
      name: 'echo_greeting',
      platform: 'echo',
      adapter: 'echo',
      needs_browser: false,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      limits: { timeout_s: 30, rate: { cost: 1 }, output_max_bytes: 4096 },
      allowed_hosts: ['api.example.com'],
    });
  });

  it('marks browser adapters as needing a browser', () => {
    expect(buildCatalog(browserAdapter)[0]?.needs_browser).toBe(true);
  });

  it('exposes the INPUT schema: strict object, bounded strings, optional defaulted fields', () => {
    const schema = buildCatalog(httpAdapter)[0]?.inputSchema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['name'] });
    expect((schema?.['properties'] as Record<string, Record<string, unknown>>)['name']).toMatchObject({ type: 'string', maxLength: 50 });
  });

  it('includes memory limits only when the tool sets them', () => {
    expect(buildCatalog(httpAdapter)[0]?.limits).not.toHaveProperty('memory');
  });
});

describe('stableStringify', () => {
  it('sorts keys at every level, indents by 2 and ends with a newline', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('is independent of key insertion order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('gives the same snapshot for the same adapter every time', () => {
    expect(stableStringify(buildCatalog(httpAdapter))).toBe(stableStringify(buildCatalog(httpAdapter)));
  });
});

describe('catalogFileName and summarizeAdapter', () => {
  it('names snapshot files after the tool', () => {
    expect(catalogFileName('apec_search')).toBe('apec_search.json');
  });

  it('summarises an adapter without handlers', () => {
    expect(summarizeAdapter(browserAdapter)).toEqual({
      id: 'sample-browser',
      displayName: 'Sample browser',
      description: 'Example browser adapter used by the SDK tests.',
      platform: 'sample',
      kind: 'browser',
      allowedHosts: ['www.example.com'],
      tools: [{ name: 'page_title', title: 'Page title (read-only)' }],
    });
  });
});
