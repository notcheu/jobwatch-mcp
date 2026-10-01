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
    admit(adapter: AdapterModule, tool: ErasedTool<BaseContext>): Admission {
      breaker.check(adapter.platform);
      const ticket = limiter.take(adapter.platform, tool.limits.cost);
      return { settle: (cost) => limiter.settle(ticket, cost) };
    },
    failed(adapter: AdapterModule, error: JobwatchError): void {
      if (error.code === 'needs_login') breaker.open(adapter.platform, 'needs_login');
      else if (error.code === 'checkpoint') breaker.open(adapter.platform, 'checkpoint');
    },
  };
}

/** Policy lookup for a set of loaded adapters: unknown platforms fall back to the strictest default. */
export function policyFor(adapters: readonly AdapterModule[]) {
  const byPlatform = new Map(adapters.map((adapter) => [adapter.platform, effectiveRate(adapter)] as const));
  return (platform: string) => byPlatform.get(platform) ?? effectiveRate({ kind: 'browser' });
}
