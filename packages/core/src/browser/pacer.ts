import type { PaceKind, Pacing } from '@jobwatch/sdk';

/** Browser adapters: 2.5 to 5 s between page loads (07-adapter-linkedin.md). HTTP adapters are paced per host by the client. */
export const DEFAULT_BROWSER_PACING: Pacing = { minMs: 2500, maxMs: 5000 };
export const NO_PACING: Pacing = { minMs: 0, maxMs: 0 };

export interface PacerOptions {
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `ctx.pace()`: wait a random time in [minMs, maxMs] counted from the previous `pace()` call or load, never less than needed.
 * The first call after a pause longer than the delay returns at once, so idle time is not wasted.
 */
export function createPacer(pacing: Pacing, options: PacerOptions = {}): (kind: PaceKind) => Promise<void> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let last: number | undefined;
  return async () => {
    const target = pacing.minMs + Math.floor(random() * (pacing.maxMs - pacing.minMs + 1));
    const wait = last === undefined ? 0 : Math.max(0, target - (now() - last));
    if (wait > 0) await sleep(wait);
    last = now();
  };
}
