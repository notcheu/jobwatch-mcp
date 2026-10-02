import { JobwatchError, type RatePolicy } from '@jobwatch/sdk';
import type { Clock, Store } from '../store/store';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface WindowUsage {
  used: number;
  limit: number;
}

export interface RateStatus {
  hour: WindowUsage;
  day: WindowUsage;
}

interface Window {
  name: 'hour' | 'day';
  ms: number;
  limit: number;
}

/**
 * Per-platform budget over two sliding windows (one hour and 24 hours), persisted so a restart does not reset it.
 * `take` checks and records in ONE transaction: two calls can never both pass the last remaining point.
 * Cost is taken before the call runs and is not refunded when the call fails: a failed request still reached the platform.
 */
/** What `take` charged, kept to settle the real cost afterwards. */
export interface UsageTicket {
  id: number;
  platform: string;
  cost: number;
}

export class RateLimiter {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly policyFor: (platform: string) => RatePolicy,
  ) {}

  private windows(platform: string): Window[] {
    const policy = this.policyFor(platform);
    return [
      { name: 'hour', ms: HOUR_MS, limit: policy.perHour },
      { name: 'day', ms: DAY_MS, limit: policy.perDay },
    ];
  }

  /**
   * Bring the charge of a finished call to what it really spent. Less than reserved: the difference is given back (0 removes the
   * event). More than reserved: the excess is recorded as a further event, never refused, because the requests were already made;
   * the next call then finds less room. Not a number, or negative: ignored.
   */
  settle(ticket: UsageTicket, actual: number): void {
    if (!Number.isFinite(actual) || actual < 0) return;
    const units = Math.floor(actual);
    if (units > ticket.cost) {
      this.store.addUsage(ticket.platform, this.clock(), units - ticket.cost);
      return;
    }
    this.store.settleUsage(ticket.id, units);
  }

  /** Take `cost` points or throw `rate_limited` with the number of seconds until the call would fit. */
  take(platform: string, cost: number): UsageTicket {
    return this.store.transaction(() => {
      const now = this.clock();
      const events = this.store.usageSince(platform, now - DAY_MS);
      let waitMs = 0;
      let blocking: { window: Window; used: number } | undefined;

      for (const window of this.windows(platform)) {
        const inside = events.filter((event) => event.ts > now - window.ms);
        const used = inside.reduce((sum, event) => sum + event.cost, 0);
        if (used + cost <= window.limit) continue;

        if (cost > window.limit) {
          throw new JobwatchError(
            'rate_limited',
            `A single call costs more (${cost}) than the ${window.name}ly budget of ${platform} (${window.limit}).`,
            {
              details: { platform, window: window.name, limit: window.limit },
            },
          );
        }
        // Wait until enough of the oldest events leave the window for the call to fit.
        let remaining = used;
        let lastDropped = inside[0]?.ts ?? now;
        for (const event of inside) {
          if (remaining + cost <= window.limit) break;
          remaining -= event.cost;
          lastDropped = event.ts;
        }
        const needed = lastDropped + window.ms - now;
        if (needed > waitMs) {
          waitMs = needed;
          blocking = { window, used };
        }
      }

      if (blocking !== undefined) {
        throw new JobwatchError(
          'rate_limited',
          `Rate limit reached for ${platform}: ${blocking.used} of ${blocking.window.limit} used in the last ${blocking.window.name}.`,
          {
            retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)),
            details: { platform, window: blocking.window.name, limit: blocking.window.limit },
          },
        );
      }
      return { id: this.store.addUsage(platform, now, cost), platform, cost };
    });
  }

  /** How much of each window is used right now (for `memory_report` and `doctor`). */
  status(platform: string): RateStatus {
    const now = this.clock();
    const events = this.store.usageSince(platform, now - DAY_MS);
    const [hour, day] = this.windows(platform) as [Window, Window];
    const used = (window: Window) => events.filter((event) => event.ts > now - window.ms).reduce((sum, event) => sum + event.cost, 0);
    return { hour: { used: used(hour), limit: hour.limit }, day: { used: used(day), limit: day.limit } };
  }
}
