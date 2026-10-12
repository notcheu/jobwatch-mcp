import { describe, expect, it } from 'vitest';
import { customToolName } from './module';
import { nameTakenBy, type NameContext } from './names';

const context: NameContext = {
  custom: [
    { handle: 'deezer', moduleId: 'custom-deezer' }, // one of the first: it keeps its prefix
    { handle: 'bpce-adapter', moduleId: 'bpce-adapter' },
  ],
  modules: [
    { id: 'ashby', platform: 'ashby', tools: ['ashby_jobs'] },
    { id: 'ats-discovery', platform: 'ats-discovery', tools: ['ats_find'] },
    { id: 'ops', platform: 'router', tools: ['memory_report', 'session_status'] },
  ],
};

describe('the tool of a custom adapter', () => {
  it('is its id with underscores, with nothing added', () => {
    expect(customToolName('bpce-adapter')).toBe('bpce_adapter');
    expect(customToolName('acme')).toBe('acme');
    expect(customToolName('custom-deezer')).toBe('custom_deezer'); // an older one, as it always was
  });
});

describe('what a new custom adapter cannot be called', () => {
  it('is free when nothing has its id or its tool name', () => {
    expect(nameTakenBy('acme-adapter', context)).toBeUndefined();
    expect(nameTakenBy('deezer', context)).toBeUndefined(); // the old one is `custom-deezer`: a different id and tool
    expect(nameTakenBy('ashby-jobs-adapter', context)).toBeUndefined();
  });

  it.each([
    ['an adapter of the router', 'ashby', /name of an adapter of the router/],
    ['a utility', 'ats-discovery', /name of an adapter of the router/],
    ['the platform of a module', 'router', /name of an adapter of the router/],
    ['another custom adapter', 'bpce-adapter', /name of a custom adapter/],
    ['an older custom adapter, by its real id', 'custom-deezer', /name of a custom adapter/],
  ])('is refused when it is the id of %s', (_what, name, message) => {
    expect(nameTakenBy(name, context)).toMatch(message);
  });

  it.each([
    ['a tool of an adapter', 'ashby-jobs', /tool of the adapter "ashby"/], // `ashby_jobs`
    ['a utility tool', 'ats-find', /tool of the adapter "ats-discovery"/],
    ['an ops tool of the router', 'memory-report', /tool of the adapter "ops"/],
    ['the tool of a custom adapter', 'bpce-adapter', /name of a custom adapter/],
  ])('is refused when it would make the tool of %s twice', (_what, name, message) => {
    expect(nameTakenBy(name, context)).toMatch(message);
  });

  it('is refused for a name whose tool is the tool of an older custom adapter', () => {
    // `custom-deezer` is the id of the older one, and `custom_deezer` its tool; the same name typed with an underscore cannot be a handle
    expect(nameTakenBy('custom-deezer', context)).toMatch(/custom adapter/);
  });
});
