import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z, type RatePolicy } from '@jobwatch/sdk';
import { ConfigError } from '../errors';

/**
 * The request budget of each installed module, in three layers (docs/plans/17-dashboard.md, "Budgets"):
 *   1. the environment, `<ID>_BUDGET_HOURLY` and `<ID>_BUDGET_DAILY` (`LINKEDIN_BUDGET_HOURLY`; `-` becomes `_`): it wins, and the
 *      dashboard shows it and cannot change it;
 *   2. what the operator saved from the dashboard, in `<dataDir>/budgets.json`;
 *   3. the defaults of `packages/mcp-modules/src/budgets.json`, edited by hand; a module with no entry there keeps the budget it
 *      declares itself (`rate`), or the engine default of its kind.
 * Each window is resolved on its own: hourly may come from the environment while daily comes from the saved config.
 */
export const BUDGETS_FILE = 'budgets.json';
export const BUDGET_MIN = 0;
export const BUDGET_MAX = 1_000_000;

export type BudgetWindow = 'hourly' | 'daily';
export type BudgetSource = 'env' | 'config' | 'default';

/** One window of one module: the effective value, where it came from, the default, and the variable that would pin it. */
export interface BudgetValue {
  value: number;
  source: BudgetSource;
  default: number;
  envVar: string;
}
export interface Budget {
  hourly: BudgetValue;
  daily: BudgetValue;
}
export type BudgetNumbers = Partial<Record<BudgetWindow, number>>;
export type BudgetDefaults = Readonly<Record<string, Readonly<Record<BudgetWindow, number>>>>;

/** `linkedin-geo` + `hourly` is `LINKEDIN_GEO_BUDGET_HOURLY`. */
export const budgetEnvName = (id: string, window: BudgetWindow): string =>
  `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BUDGET_${window.toUpperCase()}`;

const amount = z.number().int().min(BUDGET_MIN).max(BUDGET_MAX);
const fileSchema = z.record(z.string(), z.object({ hourly: amount.optional(), daily: amount.optional() }).strict());
export const budgetBodySchema = z.object({ hourly: amount.optional(), daily: amount.optional() }).strict();

/** The budget variables of these modules, validated: a value that is not a whole number from 0 to 1000000 is a configuration error. */
export function readBudgetEnv(env: Readonly<Record<string, string | undefined>>, ids: readonly string[]): Map<string, BudgetNumbers> {
  const found = new Map<string, BudgetNumbers>();
  const problems: string[] = [];
  for (const id of ids) {
    for (const window of ['hourly', 'daily'] as const) {
      const name = budgetEnvName(id, window);
      const raw = env[name]?.trim();
      if (raw === undefined || raw === '') continue;
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !amount.safeParse(parsed).success) {
        problems.push(`${name}: must be a whole number from ${BUDGET_MIN} to ${BUDGET_MAX}, got "${raw.slice(0, 20)}"`);
        continue;
      }
      found.set(id, { ...found.get(id), [window]: parsed });
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return found;
}

export async function readBudgetsFile(dataDir: string): Promise<Map<string, BudgetNumbers>> {
  const path = join(dataDir, BUDGETS_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new ConfigError([`${path}: ${error instanceof Error ? error.message : 'cannot be read'}`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError([`${path}: not valid JSON`]);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success)
    throw new ConfigError(parsed.error.issues.map((issue) => `${path}: ${issue.path.join('.') || 'file'}: ${issue.message}`));
  return new Map(Object.entries(parsed.data));
}

/** Atomic, sorted: a temp file in the same folder, then a rename (as `adapters.json`). */
async function writeBudgetsFile(dataDir: string, saved: ReadonlyMap<string, BudgetNumbers>): Promise<void> {
  const path = join(dataDir, BUDGETS_FILE);
  const sorted = Object.fromEntries([...saved.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o644 });
  await rename(temp, path);
}

/** Why a change was refused: both windows of that module are set by the environment. */
export class BudgetLocked extends Error {}

export interface BudgetsInit {
  dataDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Every installed module id: the ids whose variables are read and whose budget can be asked for. */
  ids: readonly string[];
  defaults: BudgetDefaults;
}

/** The resolved budgets, held in memory and updated by `set` so a change applies to the next call without a restart. */
export class Budgets {
  private constructor(
    private readonly init: BudgetsInit,
    private readonly fromEnv: ReadonlyMap<string, BudgetNumbers>,
    private saved: Map<string, BudgetNumbers>,
  ) {}

  static async load(init: BudgetsInit): Promise<Budgets> {
    return new Budgets(init, readBudgetEnv(init.env, init.ids), await readBudgetsFile(init.dataDir));
  }

  /** `declared` is the budget the module brings itself (its `rate`, or the engine default of its kind). */
  private resolve(id: string, window: BudgetWindow, declared: RatePolicy): BudgetValue {
    const base = {
      default: this.init.defaults[id]?.[window] ?? (window === 'hourly' ? declared.perHour : declared.perDay),
      envVar: budgetEnvName(id, window),
    };
    const env = this.fromEnv.get(id)?.[window];
    if (env !== undefined) return { ...base, value: env, source: 'env' };
    const saved = this.saved.get(id)?.[window];
    if (saved !== undefined) return { ...base, value: saved, source: 'config' };
    return { ...base, value: base.default, source: 'default' };
  }

  get(id: string, declared: RatePolicy): Budget {
    return { hourly: this.resolve(id, 'hourly', declared), daily: this.resolve(id, 'daily', declared) };
  }

  /** The policy the rate limiter applies to this module. */
  policy(id: string, declared: RatePolicy): RatePolicy {
    const budget = this.get(id, declared);
    return { perHour: budget.hourly.value, perDay: budget.daily.value };
  }

  /**
   * Save the windows that are not set by the environment (they are ignored when the environment pins them: the saved value would
   * never apply and would come back unexpectedly when the variable is removed). Throws `BudgetLocked` when nothing can be saved.
   */
  async set(id: string, change: BudgetNumbers, declared: RatePolicy): Promise<Budget> {
    const parsed = budgetBodySchema.parse(change);
    const locked = this.fromEnv.get(id) ?? {};
    const wanted = (['hourly', 'daily'] as const).filter((window) => parsed[window] !== undefined);
    if (wanted.length === 0) return this.get(id, declared);
    const free = wanted.filter((window) => locked[window] === undefined);
    if (wanted.length > 0 && free.length === 0)
      throw new BudgetLocked(
        `${wanted.map((window) => budgetEnvName(id, window)).join(' and ')} set${wanted.length === 1 ? 's' : ''} it: unset it to change it here.`,
      );
    const next = new Map(this.saved);
    const merged: BudgetNumbers = { ...next.get(id) };
    for (const window of free) merged[window] = parsed[window] as number;
    next.set(id, merged);
    await writeBudgetsFile(this.init.dataDir, next);
    this.saved = next;
    return this.get(id, declared);
  }
}
