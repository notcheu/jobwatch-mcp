import { JobwatchError } from '@jobwatch/sdk';

/**
 * FIFO async semaphore. The browser lease uses capacity 1: one browser at a time (RAM, docs/plans/06-memory-and-lifecycle-policy.md).
 * Waiters are served strictly in arrival order; a waiter that is not served within `timeoutMs` gets a `busy` error
 * and leaves the queue (so it can never be served later by mistake).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: { grant: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(capacity = 1) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.available = capacity;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves with a one-shot `release` function. Rejects with `busy` after `timeoutMs`. */
  acquire(timeoutMs: number, retryAfterS: number): Promise<() => void> {
    if (this.available > 0 && this.waiters.length === 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(this.makeRelease());
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new JobwatchError('busy', 'Another call is using the browser; the queue wait ran out.', {
              retryAfterS,
              details: { waited_s: Math.round(timeoutMs / 1000) },
            }),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next !== undefined) next.grant();
      else this.available += 1;
    };
  }
}
