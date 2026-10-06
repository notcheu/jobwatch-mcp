import { createServer, type Server } from 'node:http';
import type { EngineLogger } from '@jobwatch/core';
import { createDashboardApp, type DashboardDeps } from './app';
import { Oidc } from './oidc';
import { SessionStore } from './sessions';

export interface DashboardSettings {
  port: number;
  /** The interface it binds. Sign-in required: every interface (the reverse proxy reaches it). No sign-in (local development): the MCP listen address, loopback. */
  host: string;
  /** Where the operator opens the dashboard. */
  url: string;
  /** `https://<domain>`: the origin it is served from. */
  publicOrigin: string;
  authRequired: boolean;
  oidc: { issuer: string; clientId: string; clientSecret: string } | undefined;
  idleS: number;
  sessionMaxS: number;
  writeWindowS: number;
  staticDir: string | undefined;
}

export interface DashboardStatus {
  running: boolean;
  url: string;
  /** When it stops if nobody uses it. */
  stopsAt: string | null;
  sessions: number;
  requests: number;
  signIn: 'google' | 'none';
}

/** The data side of the dashboard (everything but sign-in and timers), supplied by the server. */
export type DashboardData = Omit<
  DashboardDeps,
  'logger' | 'publicOrigin' | 'authRequired' | 'oidc' | 'sessions' | 'writeWindowMs' | 'idleMs' | 'onActivity' | 'staticDir' | 'writes'
>;

/**
 * Starts and stops the dashboard listener on demand (docs/plans/17-dashboard.md, section 2). The listener exists only between
 * `start` and `stop` (or the idle stop): when it is off nothing is bound and `/dashboard` has no backend. It can only be started
 * from the host, through the control socket; no web request and no MCP tool can start it.
 */
export class DashboardManager {
  private server: Server | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastActivity = 0;
  private idleMs = 0;
  private requests = 0;
  private sessions: SessionStore | undefined;

  constructor(
    private readonly settings: DashboardSettings,
    private readonly data: DashboardData,
    private readonly logger: EngineLogger,
    private readonly clock: () => number = Date.now,
    private readonly extra: Pick<DashboardDeps, 'writes'> & { fetcher?: typeof fetch } = {},
  ) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  /** The port the listener is bound to (useful when the configured port is 0), or undefined when it is off. */
  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
  }

  /** Open the listener. Calling it again while it runs renews the idle countdown and returns the same status. */
  async start(options: { ttlMinutes?: number } = {}): Promise<DashboardStatus> {
    const { settings } = this;
    if (settings.authRequired && settings.oidc === undefined)
      throw new Error(
        "Signing in needs a Google client: set DASHBOARD_OIDC_CLIENT_ID and DASHBOARD_OIDC_CLIENT_SECRET (compose passes the connector's OIDC_CLIENT_ID and OIDC_CLIENT_SECRET by default), and add the redirect URI " +
          `${settings.publicOrigin}/dashboard/auth/callback to that client.`,
      );
    this.idleMs = Math.max(60, Math.round(options.ttlMinutes === undefined ? settings.idleS : options.ttlMinutes * 60)) * 1000;
    this.lastActivity = this.clock();
    if (this.server !== undefined) return this.status();

    const sessions = new SessionStore(settings.sessionMaxS * 1000, this.clock);
    this.sessions = sessions;
    const oidc =
      settings.authRequired && settings.oidc !== undefined
        ? new Oidc(
            { ...settings.oidc, redirectUri: `${settings.publicOrigin}/dashboard/auth/callback` },
            this.extra.fetcher ?? fetch,
            this.clock,
          )
        : undefined;
    const app = createDashboardApp({
      ...this.data,
      logger: this.logger,
      publicOrigin: settings.publicOrigin,
      authRequired: settings.authRequired,
      oidc,
      sessions,
      writeWindowMs: settings.writeWindowS * 1000,
      idleMs: this.idleMs,
      staticDir: settings.staticDir,
      ...(this.extra.writes === undefined ? {} : { writes: this.extra.writes }),
      onActivity: () => {
        this.lastActivity = this.clock();
        this.requests += 1;
      },
    });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.requests = 0;
    this.arm();
    this.logger.info(
      { port: settings.port, signIn: oidc === undefined ? 'none' : 'google', idleS: this.idleMs / 1000 },
      'dashboard_started',
    );
    return this.status();
  }

  /** Close the listener, end every session. Safe to call when it is already off. */
  async stop(reason: 'stopped' | 'idle' | 'shutdown' = 'stopped'): Promise<DashboardStatus> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const server = this.server;
    this.server = undefined;
    this.sessions?.revokeAll();
    this.sessions = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      this.logger.info({ reason, requests: this.requests }, 'dashboard_stopped');
    }
    return this.status();
  }

  status(): DashboardStatus {
    const running = this.server !== undefined;
    return {
      running,
      url: this.settings.url,
      stopsAt: running ? new Date(this.lastActivity + this.idleMs).toISOString() : null,
      sessions: this.sessions?.size ?? 0,
      requests: this.requests,
      signIn: this.settings.authRequired ? 'google' : 'none',
    };
  }

  /** One timer, re-armed to the moment the idle limit would pass; it stops the dashboard when nobody used it since. */
  private arm(): void {
    clearTimeout(this.timer);
    const wait = Math.max(1000, this.lastActivity + this.idleMs - this.clock());
    this.timer = setTimeout(() => {
      if (this.clock() - this.lastActivity >= this.idleMs) void this.stop('idle');
      else this.arm();
    }, wait);
    this.timer.unref();
  }
}
