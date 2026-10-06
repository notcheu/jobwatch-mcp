import type { McpModule, RatePolicy } from '@jobwatch/sdk';

/**
 * Budgets used when an adapter does not declare `rate`. A browser platform is a logged-in account that can be restricted,
 * so its default is the conservative LinkedIn budget of docs/plans/07-adapter-linkedin.md; plain HTTP sources are cheap and polite.
 * LinkedIn's numbers are conservative defaults (docs/plans/09-security.md): nothing is enabled until the operator turns it on.
 */
export const DEFAULT_RATE = {
  browser: { perHour: 120, perDay: 300 },
  http: { perHour: 600, perDay: 3000 },
} as const satisfies Record<McpModule['kind'], RatePolicy>;

export function effectiveRate(adapter: Pick<McpModule, 'kind' | 'rate'>): RatePolicy {
  return adapter.rate ?? DEFAULT_RATE[adapter.kind];
}
