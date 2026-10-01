import type { AdapterModule, RatePolicy } from '@jobwatch/sdk';

/**
 * Budgets used when an adapter does not declare `rate`. A browser platform is a logged-in account that can be restricted,
 * so its default is the conservative LinkedIn budget of 07-adapter-linkedin.md; plain HTTP sources are cheap and polite.
 * LinkedIn's numbers are DEFAULTS PENDING MATTHIEU'S APPROVAL (09-security.md): nothing is enabled until he turns it on.
 */
export const DEFAULT_RATE = {
  browser: { perHour: 120, perDay: 300 },
  http: { perHour: 600, perDay: 3000 },
} as const satisfies Record<AdapterModule['kind'], RatePolicy>;

export function effectiveRate(adapter: Pick<AdapterModule, 'kind' | 'rate'>): RatePolicy {
  return adapter.rate ?? DEFAULT_RATE[adapter.kind];
}
