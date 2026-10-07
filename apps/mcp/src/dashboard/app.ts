import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { API_PREFIX, apiErrorSchema, meSchema } from '@jobwatch/dashboard-api';
import type { EngineLogger } from '@jobwatch/core';
import express, { type NextFunction, type Request, type Response, type Express } from 'express';
import { ZodError } from 'zod';
import {
  checked,
  getCall,
  getDocs,
  getJob,
  getOverview,
  getSearch,
  getSettings,
  getTools,
  getUsage,
  listCalls,
  listJobs,
  getCustomAdapter,
  getCustomAdapterSample,
  listAtsLookups,
  listCustomAdapters,
  listPlaceLookups,
  listSavedPlaces,
  listCompanyBoards,
  listSearches,
  type DashboardData,
} from './api';
import type { Oidc } from './oidc';
import type { Session, SessionStore } from './sessions';

export interface DashboardDeps extends DashboardData {
  logger: EngineLogger;
  /** `https://<domain>`: the origin the dashboard is served from. Host and Origin checks compare with it. */
  publicOrigin: string;
  /** false: the router runs for local development, there is no sign-in and every request is the local operator. */
  authRequired: boolean;
  oidc: Oidc | undefined;
  sessions: SessionStore;
  /** A write is accepted this long after a sign-in. */
  writeWindowMs: number;
  /** The dashboard stops itself after this long without a request. */
  idleMs: number;
  /** Called on every request that gets past the checks: the idle timer restarts. */
  onActivity: () => void;
  /** Registers the endpoints that change something (they sit behind the CSRF and recent-sign-in checks). */
  writes?: (router: express.Router) => void;
  /** The built React app (`index.html` and `assets/`). Without it a plain page says the API is up. */
  staticDir: string | undefined;
}

const BASE = '/dashboard';
const SESSION_COOKIE = 'jw_dash';
const STATE_COOKIE = 'jw_dash_state';

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

const cookie = (
  name: string,
  value: string,
  options: { path: string; maxAgeS?: number; sameSite: 'Strict' | 'Lax'; secure: boolean },
): string =>
  `${name}=${encodeURIComponent(value)}; Path=${options.path}; HttpOnly; SameSite=${options.sameSite}${options.secure ? '; Secure' : ''}${
    options.maxAgeS === undefined ? '' : `; Max-Age=${options.maxAgeS}`
  }`;

/** Only paths inside the dashboard: a `next` that could send the browser anywhere else is replaced. */
function safeNext(value: unknown): string {
  return typeof value === 'string' && value.startsWith(`${BASE}/`) && !value.startsWith('//') && !value.includes('\\') && value.length < 300
    ? value
    : `${BASE}/`;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${BASE}/assets/login.css"></head><body><main>${body}</main></body></html>`;
}

const LOGIN_CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.5 system-ui,sans-serif}
main{width:min(92vw,380px);padding:32px;border:1px solid #23272e;border-radius:12px;background:#12151a;text-align:center}
h1{margin:0 0 4px;font-size:20px}p{margin:8px 0 20px;color:#9aa3ad}
a.button{display:inline-flex;gap:10px;align-items:center;justify-content:center;width:100%;box-sizing:border-box;padding:11px 16px;border-radius:8px;background:#fff;color:#1f1f1f;font-weight:600;text-decoration:none}
a.button:hover{background:#f1f3f4}.error{color:#ff8a80}svg{width:18px;height:18px}`;

const GOOGLE_G =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

/**
 * The dashboard HTTP application, mounted under `/dashboard` (docs/plans/17-dashboard.md). It serves a sign-in page with a
 * "Sign in with Google" button, the sign-in routes, the built React app and the JSON API. It reads the router's state and calls no
 * site, starts no browser and spends no rate-limit unit.
 */
export function createDashboardApp(deps: DashboardDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  const origin = new URL(deps.publicOrigin);
  const secure = origin.protocol === 'https:';
  const now = (): number => deps.clock();

  // --- every response: no framing, no sniffing, no referrer, a strict content policy, nothing cached
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // --- Host must be the public host (no DNS rebinding); the local development mode also accepts loopback names
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const local = !deps.authRequired && ['127.0.0.1', 'localhost', '::1'].includes(hostname);
    if (host !== origin.host.toLowerCase() && !local) return void res.status(421).type('text').send('Misdirected request');
    next();
  });

  app.get(`${BASE}/assets/login.css`, (_req, res) => void res.type('text/css').send(LOGIN_CSS));

  // The Origin a change must come from: the public origin when sign-in is required; in local development the dashboard has its own
  // loopback port (the Host check has already limited the name to loopback), so its own origin is accepted.
  const originOk = (req: Request): boolean => {
    const sent = req.headers.origin;
    if (sent === undefined) return false;
    if (sent === origin.origin) return true;
    return !deps.authRequired && sent === `http://${req.headers.host ?? ''}`;
  };

  // --- who is calling
  const sessionOf = (req: Request): Session | undefined => deps.sessions.get(readCookie(req, SESSION_COOKIE));
  const localSession: Session = { id: 'local', email: 'local', signedInAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
  const identify = (req: Request): Session | undefined => (deps.authRequired ? sessionOf(req) : localSession);

  const sendError = (res: Response, status: number, error: string, message: string): void => {
    res.status(status).json(checked(apiErrorSchema, { error, message }));
  };

  // --- sign-in pages and routes (only when sign-in is required)
  app.get(`${BASE}/login`, (req, res) => {
    if (!deps.authRequired || identify(req) !== undefined) return void res.redirect(safeNext(req.query['next']));
    const failed = typeof req.query['error'] === 'string';
    const next = encodeURIComponent(safeNext(req.query['next']));
    res
      .type('html')
      .send(
        page(
          'jobwatch dashboard',
          `<h1>jobwatch dashboard</h1><p>Sign in to see the runs, stored jobs and tool state.</p>${
            failed ? '<p class="error">That sign-in did not work. Try again.</p>' : ''
          }<a class="button" href="${BASE}/auth/login?next=${next}">${GOOGLE_G}<span>Sign in with Google</span></a>`,
        ),
      );
  });

  app.get(`${BASE}/auth/login`, async (req, res) => {
    if (!deps.authRequired || deps.oidc === undefined) return void res.redirect(`${BASE}/`);
    try {
      const { url, state } = await deps.oidc.begin(safeNext(req.query['next']), req.query['reauth'] === '1');
      res.setHeader('Set-Cookie', cookie(STATE_COOKIE, state, { path: `${BASE}/auth`, maxAgeS: 600, sameSite: 'Lax', secure }));
      res.redirect(url);
    } catch (error) {
      deps.logger.warn({ err: error }, 'dashboard_signin_unavailable');
      res.redirect(`${BASE}/login?error=1`);
    }
  });

  app.get(`${BASE}/auth/callback`, async (req, res) => {
    const clear = cookie(STATE_COOKIE, '', { path: `${BASE}/auth`, maxAgeS: 0, sameSite: 'Lax', secure });
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    try {
      if (deps.oidc === undefined) throw new Error('sign-in is not configured');
      // The browser that started the sign-in is the one that finishes it (login CSRF).
      if (state === '' || code === '' || readCookie(req, STATE_COOKIE) !== state) throw new Error('state mismatch');
      const identity = await deps.oidc.complete(code, state);
      const previous = sessionOf(req);
      if (previous !== undefined) deps.sessions.revoke(previous.id);
      const session = deps.sessions.create(identity.email);
      deps.logger.info({ email: identity.email }, 'dashboard_signed_in');
      res.setHeader('Set-Cookie', [
        clear,
        cookie(SESSION_COOKIE, session.id, {
          path: BASE,
          maxAgeS: Math.max(1, Math.floor((session.expiresAt - now()) / 1000)),
          sameSite: 'Strict',
          secure,
        }),
      ]);
      res.redirect(identity.next);
    } catch (error) {
      deps.logger.warn({ reason: error instanceof Error ? error.message : 'failed' }, 'dashboard_signin_refused');
      res.setHeader('Set-Cookie', clear);
      res.redirect(`${BASE}/login?error=1`);
    }
  });

  // --- the API
  const api = express.Router();
  api.use((req, res, next) => {
    const session = identify(req);
    if (session === undefined) return sendError(res, 401, 'unauthorized', 'Sign in to use the dashboard.');
    res.locals['session'] = session;
    deps.onActivity();
    // A change needs a header only the app sets, the right Origin and a sign-in that is recent enough.
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['x-jw-csrf'] !== '1' || !originOk(req))
        return sendError(res, 403, 'forbidden', 'This request did not come from the dashboard.');
      if (deps.authRequired && now() - session.signedInAt > deps.writeWindowMs)
        return sendError(res, 401, 'reauth_required', 'Sign in again to make this change.');
    }
    next();
  });

  const wrap =
    (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = await handler(req, res);
        if (!res.headersSent) res.json(body);
      } catch (error) {
        next(error);
      }
    };

  api.get('/me', (_req, res) => {
    const session = res.locals['session'] as Session;
    const local = session.id === 'local';
    const iso = (ms: number): string => new Date(ms).toISOString();
    res.json(
      checked(meSchema, {
        mode: local ? 'local' : 'google',
        email: local ? null : session.email,
        signedInAt: local ? null : iso(session.signedInAt),
        expiresAt: local ? null : iso(session.expiresAt),
        idleStopAt: iso(now() + deps.idleMs),
        writableUntil: local ? null : iso(session.signedInAt + deps.writeWindowMs),
        version: deps.version,
      }),
    );
  });
  api.get(
    '/overview',
    wrap(() => getOverview(deps)),
  );
  api.get(
    '/calls',
    wrap((req) => listCalls(deps, req.query)),
  );
  api.get(
    '/calls/:id',
    wrap((req, res) => {
      const call = getCall(deps, Number(req.params['id']));
      if (call === undefined) return void sendError(res, 404, 'not_found', 'That call is no longer in the call log.');
      return call;
    }),
  );
  api.get(
    '/jobs',
    wrap((req) => listJobs(deps, req.query)),
  );
  api.get(
    '/jobs/:source/:id',
    wrap((req, res) => {
      const job = getJob(deps, String(req.params['source']), String(req.params['id']));
      if (job === undefined) return void sendError(res, 404, 'not_found', 'That job is not stored.');
      return job;
    }),
  );
  api.get(
    '/searches',
    wrap((req) => listSearches(deps, req.query)),
  );
  api.get(
    '/searches/:source',
    wrap((req, res) => {
      const search = getSearch(deps, String(req.params['source']), req.query);
      if (search === undefined) return void sendError(res, 404, 'not_found', 'No such search in this window.');
      return search;
    }),
  );
  api.get(
    '/ats-lookups',
    wrap((req) => listAtsLookups(deps, req.query)),
  );
  api.get(
    '/custom-adapters',
    wrap(() => listCustomAdapters(deps)),
  );
  api.get(
    '/custom-adapters/sample/:kind',
    wrap((req) => getCustomAdapterSample(req.params['kind'])),
  );
  api.get(
    '/custom-adapters/:handle',
    wrap((req, res) => {
      const found = getCustomAdapter(deps, String(req.params['handle']));
      if (found === undefined) return void sendError(res, 404, 'not_found', 'No such custom adapter.');
      return found;
    }),
  );
  api.get(
    '/place-lookups',
    wrap((req) => listPlaceLookups(deps, req.query)),
  );
  api.get(
    '/places',
    wrap((req) => listSavedPlaces(deps, req.query)),
  );
  api.get(
    '/company-boards',
    wrap((req) => listCompanyBoards(deps, req.query)),
  );
  api.get(
    '/tools',
    wrap(() => getTools(deps)),
  );
  api.get(
    '/docs',
    wrap(() => getDocs(deps)),
  );
  api.get(
    '/usage',
    wrap((req) => getUsage(deps, req.query)),
  );
  api.get(
    '/settings',
    wrap(() => getSettings(deps)),
  );
  deps.writes?.(api);
  api.use((_req, res) => sendError(res, 404, 'not_found', 'No such endpoint.'));
  app.use(`${API_PREFIX}`, api);

  app.post(`${BASE}/auth/logout`, (req, res) => {
    if (req.headers['x-jw-csrf'] !== '1' || !originOk(req)) return void res.status(403).end();
    const session = sessionOf(req);
    if (session !== undefined) deps.sessions.revoke(session.id);
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', { path: BASE, maxAgeS: 0, sameSite: 'Strict', secure }));
    res.status(204).end();
  });

  // --- the app itself
  if (deps.staticDir !== undefined && existsSync(join(deps.staticDir, 'index.html'))) {
    const dir = deps.staticDir;
    app.use(
      `${BASE}/assets`,
      (req, res, next) => (identify(req) === undefined ? res.status(401).end() : next()),
      express.static(join(dir, 'assets'), { index: false }),
    );
  }
  app.get([BASE, `${BASE}/`, new RegExp(`^${BASE}/(?!api/|auth/|assets/).*`)], (req, res) => {
    if (identify(req) === undefined) return void res.redirect(`${BASE}/login?next=${encodeURIComponent(safeNext(req.path))}`);
    deps.onActivity();
    if (deps.staticDir !== undefined && existsSync(join(deps.staticDir, 'index.html')))
      return void res.sendFile(join(deps.staticDir, 'index.html'));
    res
      .type('html')
      .send(
        page(
          'jobwatch dashboard',
          `<h1>jobwatch dashboard</h1><p>The API is running at <code>${API_PREFIX}</code>. The interface is not installed.</p>`,
        ),
      );
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return sendError(res, 400, 'invalid_request', 'The query is not valid.');
    deps.logger.error({ err: error, path: req.path }, 'dashboard_request_failed');
    sendError(res, 500, 'internal', 'Something went wrong.');
  });
  app.use((_req, res) => void res.status(404).type('text').send('Not found'));
  return app;
}
