import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  email: string;
  signedInAt: number;
  expiresAt: number;
}

/**
 * Sign-ins in memory (docs/plans/17-dashboard.md, section 8): a restart signs everyone out, `revokeAll` (dashboard stop) too. A
 * session ends at `expiresAt` at the latest; there is no separate idle timer, because the dashboard itself stops when idle.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly maxAgeMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  create(email: string): Session {
    this.sweep();
    const now = this.clock();
    const session: Session = { id: randomBytes(32).toString('base64url'), email, signedInAt: now, expiresAt: now + this.maxAgeMs };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (id === undefined) return undefined;
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (session.expiresAt <= this.clock()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Sign in again on the same session id: the id changes (no fixation) and the sign-in time is renewed. */
  renew(old: Session): Session {
    this.sessions.delete(old.id);
    return this.create(old.email);
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}
