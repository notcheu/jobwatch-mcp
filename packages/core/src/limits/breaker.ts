import { Checkpoint, SessionInvalid } from '@jobwatch/sdk';
import type { BreakerReason, BreakerRow, Clock, Store } from '../store/store';

/** How long a checkpoint keeps the platform closed to us: the docs' rule is to wait at least 6 hours (docs/plans/09-security.md says 24 h after a real one). */
export const CHECKPOINT_TTL_S = 6 * 3600;

/** A checkpoint is more serious than a lost session and is never downgraded by one. */
const SEVERITY: Record<BreakerReason, number> = { needs_login: 1, checkpoint: 2 };

export type BreakerListener = (platform: string, row: BreakerRow | undefined) => void;

/**
 * One breaker per platform, persisted: a router restart must not forget a checkpoint and go back to hammering the site.
 * `needs_login` stays open until someone closes it (a successful `session_status` after a manual login);
 * `checkpoint` closes by itself after its time-to-live.
 */
export class CircuitBreaker {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly onChange?: BreakerListener,
  ) {}

  /** The current breaker of a platform, or undefined. An expired one is removed as a side effect. */
  state(platform: string): BreakerRow | undefined {
    const row = this.store.getBreaker(platform);
    if (row === undefined) return undefined;
    if (row.until !== null && row.until <= this.clock()) {
      this.store.deleteBreaker(platform);
      this.onChange?.(platform, undefined);
      return undefined;
    }
    return row;
  }

  /** Throws `needs_login` or `checkpoint` when the platform must not be touched. */
  check(platform: string): void {
    const row = this.state(platform);
    if (row === undefined) return;
    const details = { details: { platform } };
    if (row.reason === 'needs_login') {
      throw new SessionInvalid(`The ${platform} session is not signed in. Sign in again, then check it with session_status.`, details);
    }
    const retryAfterS = row.until === null ? undefined : Math.max(1, Math.ceil((row.until - this.clock()) / 1000));
    throw new Checkpoint(`${platform} asked for a security verification. Resolve it manually, then wait before retrying.`, {
      ...details,
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    });
  }

  /** Open (or keep open) the breaker. A `checkpoint` is not replaced by a weaker `needs_login`. */
  open(platform: string, reason: BreakerReason, ttlS?: number): BreakerRow {
    const existing = this.state(platform);
    if (existing !== undefined && SEVERITY[existing.reason] > SEVERITY[reason]) return existing;
    const now = this.clock();
    const ttl = ttlS ?? (reason === 'checkpoint' ? CHECKPOINT_TTL_S : undefined);
    const row: BreakerRow = { platform, reason, openedAt: now, until: ttl === undefined ? null : now + ttl * 1000 };
    this.store.putBreaker(row);
    this.onChange?.(platform, row);
    return row;
  }

  /** Close the breaker. Returns whether one was open. */
  close(platform: string): boolean {
    const had = this.store.deleteBreaker(platform);
    if (had) this.onChange?.(platform, undefined);
    return had;
  }

  /** All open breakers (expired ones are cleaned first). */
  all(): BreakerRow[] {
    return this.store.listBreakers().flatMap((row) => (this.state(row.platform) === undefined ? [] : [row]));
  }
}
