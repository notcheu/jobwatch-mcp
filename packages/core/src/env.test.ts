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

  it('deploy/.env.example sets every variable that has a default, to that default', () => {
    const text = repoFile('deploy/.env.example');
    const active = parseDotenv(text);
    const defaults = parseEnv({ BASE_URL: 'https://mcp.example.com' });
    if (!defaults.ok) throw new Error('the defaults must parse');
    const differsOnPurpose = new Set(['BASE_URL', 'PORT', 'DASHBOARD_PORT', 'BROWSER_IMAGE']); // Compose has its own values for these
    const notSet = Object.entries(defaults.data)
      .filter(([name, value]) => value !== undefined && mentions(text, name) && active[name] === undefined) // no default, or not meant for Compose: skipped
      .map(([name]) => name);
    expect(notSet).toEqual([]);
    const parsed = parseEnv({ BASE_URL: 'https://mcp.example.com', ...active });
    if (!parsed.ok) throw new Error(parsed.problems.join('; '));
    for (const name of Object.keys(defaults.data)) {
      if (differsOnPurpose.has(name) || active[name] === undefined) continue;
      expect(parsed.data[name as keyof typeof parsed.data], name).toEqual(defaults.data[name as keyof typeof defaults.data]);
    }
  });

  it('deploy/.env.example lists every browser variable, disabled or not', () => {
    const text = repoFile('deploy/.env.example');
    expect(ENV_NAMES.filter((name) => name.startsWith('BROWSER_') && !mentions(text, name))).toEqual([]);
  });

  it('compose.yml has no defaults: what it reads is required, and .env.example sets it', () => {
    const compose = repoFile('deploy/compose.yml');
    expect(compose).not.toMatch(/\$\{[A-Z_]+:-/);
    const active = parseDotenv(repoFile('deploy/.env.example'));
    const required = [...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1] ?? '');
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => active[name] === undefined)).toEqual([]);
  });

  it('deploy/.env.example lists every variable compose.yml reads', () => {
    const text = repoFile('deploy/.env.example');
    const names = [...new Set([...repoFile('deploy/compose.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''))];
    const skipped = new Set(['XDG_RUNTIME_DIR', 'HOME']); // set by the shell, not by the operator
    expect(names.filter((name) => !skipped.has(name) && !mentions(text, name))).toEqual([]);
  });
});
