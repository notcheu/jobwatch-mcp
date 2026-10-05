import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEnv as parseDotenv } from 'node:util';
import { ENV_NAMES, parseEnv } from './env';

const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('parseEnv', () => {
  it('applies the defaults and ignores the variables of other tools', () => {
    const result = parseEnv({ BASE_URL: 'https://mcp.example.com', PATH: '/usr/bin' });
    expect(result).toMatchObject({ ok: true, data: { PORT: 8080, AUTH: 'front', LOG_LEVEL: 'info', BROWSER_LOCAL_CHROME: false } });
  });

  it('turns text into numbers and booleans', () => {
    const result = parseEnv({ BASE_URL: 'https://mcp.example.com', PORT: '9000', METRICS_ENABLED: 'true' });
    expect(result).toMatchObject({ ok: true, data: { PORT: 9000, METRICS_ENABLED: true } });
  });

  it('treats an empty value as not set', () => {
    const result = parseEnv({ BASE_URL: 'https://mcp.example.com', PORT: '', DEFAULT_LOCATION: '' });
    expect(result).toMatchObject({ ok: true, data: { PORT: 8080 } });
    if (result.ok) expect(result.data.DEFAULT_LOCATION).toBeUndefined();
  });

  it('lists every problem with the variable name, never its value', () => {
    const result = parseEnv({ PORT: 'secret-looking-text', LOG_LEVEL: 'loud' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.length).toBeGreaterThanOrEqual(3); // BASE_URL is required too
    expect(result.problems.join(' ')).toContain('PORT');
    expect(result.problems.join(' ')).not.toContain('secret-looking-text');
  });

  it('reports a variable with the old JW_ prefix and does not read it', () => {
    const result = parseEnv({ BASE_URL: 'https://mcp.example.com', JW_PORT: '9000' });
    expect(result).toMatchObject({ ok: true, data: { PORT: 8080 }, warnings: [expect.stringContaining('JW_PORT')] });
  });
});

describe('docs/environment-variables.md', () => {
  it('documents every variable the schema reads', () => {
    const doc = repoFile('docs/environment-variables.md');
    const missing = ENV_NAMES.filter((name) => !new RegExp(`\`${name}\``).test(doc));
    expect(missing).toEqual([]);
  });
});

describe('the example env files', () => {
  const mentions = (text: string, name: string): boolean => new RegExp(`^#? ?${name}=`, 'm').test(text);

  it('.env.local lists every variable the server reads, and its active values are valid', () => {
    const text = repoFile('.env.local');
    expect(ENV_NAMES.filter((name) => !mentions(text, name))).toEqual([]);
    expect(parseEnv(parseDotenv(text))).toMatchObject({ ok: true, data: { AUTH: 'none', BROWSER_LOCAL_CHROME: true } });
  });

  it('deploy/.env.example lists every variable compose.yml reads', () => {
    const text = repoFile('deploy/.env.example');
    const names = [...new Set([...repoFile('deploy/compose.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''))];
    const skipped = new Set(['XDG_RUNTIME_DIR', 'HOME']); // set by the shell, not by the operator
    expect(names.filter((name) => !skipped.has(name) && !mentions(text, name))).toEqual([]);
  });
});
