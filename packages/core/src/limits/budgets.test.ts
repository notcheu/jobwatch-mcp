import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { BUDGETS_FILE, BudgetLocked, Budgets, budgetEnvName, readBudgetEnv, readBudgetsFile } from './budgets';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jw-budgets-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const defaults = { linkedin: { hourly: 200, daily: 400 }, 'linkedin-geo': { hourly: 60, daily: 300 } };
const declared = { perHour: 120, perDay: 300 };
const load = (env: Record<string, string> = {}) => Budgets.load({ dataDir, env, ids: ['linkedin', 'linkedin-geo', 'other'], defaults });

describe('the variables', () => {
  it('are named after the module id, with - as _', () => {
    expect(budgetEnvName('linkedin', 'hourly')).toBe('LINKEDIN_BUDGET_HOURLY');
    expect(budgetEnvName('linkedin-geo', 'daily')).toBe('LINKEDIN_GEO_BUDGET_DAILY');
    expect(budgetEnvName('ats-discovery', 'hourly')).toBe('ATS_DISCOVERY_BUDGET_HOURLY');
  });

  it('are read for the installed modules only, and a bad value is a configuration error naming it', () => {
    const env = { LINKEDIN_BUDGET_HOURLY: '150', LINKEDIN_BUDGET_DAILY: ' 350 ', NOPE_BUDGET_DAILY: '5', OTHER_BUDGET_DAILY: '' };
    expect(readBudgetEnv(env, ['linkedin', 'other'])).toEqual(new Map([['linkedin', { hourly: 150, daily: 350 }]]));
    for (const bad of ['-1', '1.5', 'abc', '1000001', '1e3']) {
      expect(() => readBudgetEnv({ LINKEDIN_BUDGET_DAILY: bad }, ['linkedin']), bad).toThrow(ConfigError);
    }
    expect(() => readBudgetEnv({ LINKEDIN_BUDGET_DAILY: 'x', OTHER_BUDGET_HOURLY: 'y' }, ['linkedin', 'other'])).toThrow(
      /LINKEDIN_BUDGET_DAILY[\s\S]*OTHER_BUDGET_HOURLY/,
    );
    expect(readBudgetEnv({ LINKEDIN_BUDGET_DAILY: '0' }, ['linkedin']).get('linkedin')).toEqual({ daily: 0 }); // 0 is allowed
  });
});

describe('the layers', () => {
  it('start from the defaults file, then what the module declares when it has no entry', async () => {
    const budgets = await load();
    expect(budgets.get('linkedin', declared)).toMatchObject({
      hourly: { value: 200, source: 'default', default: 200, envVar: 'LINKEDIN_BUDGET_HOURLY' },
      daily: { value: 400, source: 'default', default: 400 },
    });
    expect(budgets.get('other', declared)).toMatchObject({ hourly: { value: 120, source: 'default' }, daily: { value: 300 } });
    expect(budgets.policy('linkedin', declared)).toEqual({ perHour: 200, perDay: 400 });
  });

  it('put what was saved over the defaults, and the environment over both, one window at a time', async () => {
    await writeFile(join(dataDir, BUDGETS_FILE), JSON.stringify({ linkedin: { hourly: 100, daily: 250 } }));
    const budgets = await load({ LINKEDIN_BUDGET_HOURLY: '150' });
    expect(budgets.get('linkedin', declared)).toMatchObject({
      hourly: { value: 150, source: 'env', default: 200 }, // the variable beats the saved 100
      daily: { value: 250, source: 'config' },
    });
    expect(budgets.policy('linkedin', declared)).toEqual({ perHour: 150, perDay: 250 });
  });
});

describe('saving', () => {
  it('stores the numbers, applies them at once and keeps them across a restart', async () => {
    const budgets = await load();
    const saved = await budgets.set('linkedin', { hourly: 50, daily: 0 }, declared);
    expect(saved).toMatchObject({ hourly: { value: 50, source: 'config' }, daily: { value: 0, source: 'config' } });
    expect(budgets.policy('linkedin', declared)).toEqual({ perHour: 50, perDay: 0 });
    expect(JSON.parse(await readFile(join(dataDir, BUDGETS_FILE), 'utf8'))).toEqual({ linkedin: { hourly: 50, daily: 0 } });
    expect((await load()).policy('linkedin', declared)).toEqual({ perHour: 50, perDay: 0 });
  });

  it('keeps the window it was not asked to change, and the other modules', async () => {
    const budgets = await load();
    await budgets.set('linkedin', { hourly: 50 }, declared);
    await budgets.set('linkedin', { daily: 90 }, declared);
    await budgets.set('linkedin-geo', { daily: 10 }, declared);
    expect(await readBudgetsFile(dataDir)).toEqual(
      new Map([
        ['linkedin', { hourly: 50, daily: 90 }],
        ['linkedin-geo', { daily: 10 }],
      ]),
    );
  });

  it('refuses numbers outside 0 to 1000000, fractions and unknown keys, and writes nothing', async () => {
    const budgets = await load();
    for (const bad of [{ hourly: -1 }, { daily: 1_000_001 }, { hourly: 1.5 }, { daily: Number.NaN }, { nope: 1 } as never]) {
      await expect(budgets.set('linkedin', bad, declared)).rejects.toThrow();
    }
    await expect(readFile(join(dataDir, BUDGETS_FILE), 'utf8')).rejects.toThrow(); // no file
    expect((await budgets.set('linkedin', { hourly: 0, daily: 1_000_000 }, declared)).daily.value).toBe(1_000_000); // the bounds are allowed
  });

  it('does not store a window the environment sets, but saves the other one', async () => {
    const budgets = await load({ LINKEDIN_BUDGET_HOURLY: '150' });
    const result = await budgets.set('linkedin', { hourly: 10, daily: 90 }, declared);
    expect(result).toMatchObject({ hourly: { value: 150, source: 'env' }, daily: { value: 90, source: 'config' } });
    expect(await readBudgetsFile(dataDir)).toEqual(new Map([['linkedin', { daily: 90 }]])); // no stale hourly to come back later
  });

  it('refuses, naming the variable, when the environment sets every window it was asked to change', async () => {
    const budgets = await load({ LINKEDIN_BUDGET_HOURLY: '150', LINKEDIN_BUDGET_DAILY: '300' });
    await expect(budgets.set('linkedin', { hourly: 1, daily: 2 }, declared)).rejects.toThrow(BudgetLocked);
    await expect(budgets.set('linkedin', { hourly: 1 }, declared)).rejects.toThrow('LINKEDIN_BUDGET_HOURLY');
    expect(await readBudgetsFile(dataDir)).toEqual(new Map());
  });

  it('does nothing for an empty change', async () => {
    const budgets = await load();
    expect((await budgets.set('linkedin', {}, declared)).hourly.source).toBe('default');
    await expect(readFile(join(dataDir, BUDGETS_FILE), 'utf8')).rejects.toThrow();
  });
});

describe('the file', () => {
  it('is absent on a fresh install, and a damaged one is a configuration error naming it', async () => {
    expect(await readBudgetsFile(dataDir)).toEqual(new Map());
    await writeFile(join(dataDir, BUDGETS_FILE), '{ not json');
    await expect(readBudgetsFile(dataDir)).rejects.toThrow(/budgets\.json: not valid JSON/);
    await writeFile(join(dataDir, BUDGETS_FILE), JSON.stringify({ linkedin: { hourly: -3 } }));
    await expect(readBudgetsFile(dataDir)).rejects.toThrow(ConfigError);
    await writeFile(join(dataDir, BUDGETS_FILE), JSON.stringify({ linkedin: { weekly: 3 } }));
    await expect(readBudgetsFile(dataDir)).rejects.toThrow(ConfigError);
  });
});
