import type { AdapterModule, BaseContext, ErasedTool, JobwatchError } from '@jobwatch/sdk';
import type { Admission, CallGuard } from '../call';
import type { CircuitBreaker } from './breaker';
import { effectiveRate } from './policy';
import type { RateLimiter, UsageTicket } from './ratelimit';

/**
 * The two protections around every call, in the order that protects the platform best:
 *  1. the circuit breaker, so a platform that asked for a login or a verification is never touched (and no budget is spent);
 *  2. the rate limiter, which takes the tool's cost from the platform's budget.
 * When the handler later reports a lost session or a checkpoint, the breaker opens.
 */
export function createGuard(limiter: RateLimiter, breaker: CircuitBreaker): CallGuard {
  return {
    admit(adapter: AdapterModule, tool: ErasedTool<BaseContext>, args: unknown): Admission {
      breaker.check(adapter.platform);
      const keys = budgetKeys(tool, args);
      // The platform budget and one budget per company board, all or nothing: a board that is out of room refuses the call and
      // leaves every other budget untouched.
      const [ticket, ...keyTickets] = limiter.takeAll([
        { platform: adapter.platform, cost: reservation(tool, args) },
        ...keys.map((key) => ({ platform: `${adapter.platform}#${key}`, cost: 1 })),
      ]);
      return {
        reserved: reservation(tool, args),
        // A call can never really cost more than the tool's declared maximum: a larger report is an adapter bug, and must not be
        // able to lock the platform out.
        settle: (cost) => {
          limiter.settle(ticket as UsageTicket, Math.min(cost, tool.limits.cost));
          // A board is charged for the call that requested it. A call that touched nothing (the browser was busy, the queue
          // timed out) did not request any board, so every board gets its unit back.
          if (cost === 0) for (const keyTicket of keyTickets) limiter.settle(keyTicket, 0);
        },
      };
    },
    failed(adapter: AdapterModule, error: JobwatchError): void {
      if (error.code === 'needs_login') breaker.open(adapter.platform, 'needs_login');
      else if (error.code === 'checkpoint') breaker.open(adapter.platform, 'checkpoint');
    },
  };
}

/**
 * Units to reserve for this call: the tool's own estimate from the validated arguments, kept between 1 and the tool's maximum.
 * An estimate that throws or is not a number falls back to the maximum: refusing too much is safer than reserving too little.
 */
export function reservation(tool: ErasedTool<BaseContext>, args: unknown): number {
  const max = tool.limits.cost;
  const estimate = tool.limits.estimate as ((args: unknown) => number) | undefined;
  if (estimate === undefined) return max;
  try {
    const wanted = Math.ceil(estimate(args));
    return Number.isFinite(wanted) ? Math.min(max, Math.max(1, wanted)) : max;
  } catch {
    return max;
  }
}

/** Most boards one call may name: more is an adapter bug, and would turn one call into a very large transaction. */
const MAX_KEYS = 20;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * The boards this call will touch, from the tool's own `keys(args)`: lower-cased, made safe for a budget name, deduplicated.
 * A broken `keys` function (it throws, or returns junk) means no per-board budget for this call, never a refused call: the
 * platform budget still applies.
 */
export function budgetKeys(tool: ErasedTool<BaseContext>, args: unknown): string[] {
  const keys = tool.limits.keys as ((args: unknown) => readonly string[]) | undefined;
  if (keys === undefined) return [];
  let raw: readonly string[];
  try {
    raw = keys(args);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const clean = new Set<string>();
  for (const key of raw) {
    if (typeof key !== 'string') continue;
    const safe = key
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 100);
    if (KEY_PATTERN.test(safe)) clean.add(safe);
    if (clean.size >= MAX_KEYS) break;
  }
  return [...clean];
}

/** Policy lookup for a set of loaded adapters: unknown platforms fall back to the strictest default. */
export function policyFor(adapters: readonly AdapterModule[]) {
  const byPlatform = new Map(adapters.map((adapter) => [adapter.platform, effectiveRate(adapter)] as const));
  const byKey = new Map(adapters.map((adapter) => [adapter.platform, adapter.keyRate ?? effectiveRate(adapter)] as const));
  return (platform: string) => {
    // `greenhouse#algolia`: the budget of one board of a platform, not of the platform
    const at = platform.indexOf('#');
    if (at !== -1) return byKey.get(platform.slice(0, at)) ?? effectiveRate({ kind: 'browser' });
    return byPlatform.get(platform) ?? effectiveRate({ kind: 'browser' });
  };
}
