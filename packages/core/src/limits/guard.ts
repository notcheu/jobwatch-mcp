import type { AdapterModule, BaseContext, ErasedTool, JobwatchError } from '@jobwatch/sdk';
import type { Admission, CallGuard } from '../call';
import type { CircuitBreaker } from './breaker';
import { effectiveRate } from './policy';
import type { RateLimiter } from './ratelimit';

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
      const ticket = limiter.take(adapter.platform, reservation(tool, args));
      // A call can never really cost more than the tool's declared maximum: a larger report is an adapter bug, and must not be able
      // to lock the platform out.
      return { settle: (cost) => limiter.settle(ticket, Math.min(cost, tool.limits.cost)) };
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

/** Policy lookup for a set of loaded adapters: unknown platforms fall back to the strictest default. */
export function policyFor(adapters: readonly AdapterModule[]) {
  const byPlatform = new Map(adapters.map((adapter) => [adapter.platform, effectiveRate(adapter)] as const));
  return (platform: string) => byPlatform.get(platform) ?? effectiveRate({ kind: 'browser' });
}
