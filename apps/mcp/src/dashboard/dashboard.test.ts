/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read JSON answers field by field; their shapes are pinned by the strict schemas of dashboard-api */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  Budgets,
  CallLog,
  CircuitBreaker,
  RateLimiter,
  Store,
  createLogger,
  createRegistryHolder,
  loadModules,
  policyFor,
} from '@jobwatch/core';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { installedFixtures } from '../harness';
import { createDashboardApp, type DashboardDeps } from './app';
import { Oidc } from './oidc';
import { SessionStore } from './sessions';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12);
const ORIGIN = 'https://jobs.example.com';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
});
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

// ------------------------------------------------------------------------------------------------ a fake Google

async function fakeProvider(clientId: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const issued = new Map<string, { nonce: string; challenge: string }>();
  let port = 0;
  const behaviour = {
    email: 'me@example.com',
    emailVerified: true as boolean | undefined,
    audience: clientId,
    nonceOverride: undefined as string | undefined,
    expired: false,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return void res.end(
        JSON.stringify({
          issuer: `http://127.0.0.1:${port}`,
          authorization_endpoint: `http://127.0.0.1:${port}/auth`,
          token_endpoint: `http://127.0.0.1:${port}/token`,
          jwks_uri: `http://127.0.0.1:${port}/keys`,
        }),
      );
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        const entry = issued.get(form.get('code') ?? '');
        const verifierOk =
          entry !== undefined &&
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') === entry.challenge;
        if (entry === undefined || !verifierOk || form.get('client_secret') !== 'client-secret') {
          res.statusCode = 400;
          return void res.end('{"error":"invalid_grant"}');
        }
        const token = await new SignJWT({
          email: behaviour.email,
          ...(behaviour.emailVerified === undefined ? {} : { email_verified: behaviour.emailVerified }),
          nonce: behaviour.nonceOverride ?? entry.nonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(`http://127.0.0.1:${port}`)
          .setAudience(behaviour.audience)
          .setSubject('123')
          .setIssuedAt()
          .setExpirationTime(behaviour.expired ? Math.floor(Date.now() / 1000) - 60 : '5m')
          .sign(privateKey);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id_token: token, access_token: 'unused' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  port = await listen(server);
  return {
    issuer: `http://127.0.0.1:${port}`,
    keys: createLocalJWKSet({ keys: [jwk] }),
    behaviour,
    /** What the provider does after the user approves: remember the nonce and challenge, give back a code. */
    approve(authorizeUrl: string): string {
      const url = new URL(authorizeUrl);
      const code = `code-${issued.size + 1}`;
      issued.set(code, { nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '' });
      return code;
    },
  };
}

// ------------------------------------------------------------------------------------------------ the dashboard

function seededStore(): Store {
  const store = Store.open(':memory:');
  const job = (id: string, title: string, board: string | null = null) => ({
    id,
    board,
    title,
    company: 'Acme',
    location: 'Paris',
    url: `https://example.com/${id}`,
    description: `About us.\n\nWhat you'll do\n- Build ${title} with React\n\nWhat we're looking for\n- 5+ years of experience\n`,
  });
  store.putJob('linkedin', job('1000001', 'Frontend Engineer'), NOW - 3 * DAY);
  store.putJob('linkedin', job('1000002', 'Backend Engineer'), NOW - 2 * DAY);
  store.putJob('teamtailor', job('2000001', 'VP Engineering', 'bsport'), NOW - DAY);
  store.recordSearch(
    'linkedin',
    { keywords: ['react'], disallowed: [], found: ['1000001', '1000002'], returned: ['1000001'], excluded: [] },
    NOW - 3 * DAY,
  );
  return store;
}

function seededLog(): CallLog {
  const log = new CallLog(50);
  const call = (requestId: string, tool: string, platform: string, code: 'ok' | 'rate_limited', params: Record<string, unknown>) => {
    log.start({ requestId, tool, adapter: platform, platform, startedAt: NOW - 1000 });
    log.finish({
      tool,
      adapter: platform,
      platform,
      code,
      durationMs: 400,
      requestId,
      argsHash: 'hash',
      detail: {
        startedAt: NOW - 1000,
        unitsReserved: 5,
        unitsSpent: 3,
        responseBytes: 2000,
        estimatedTokens: 570,
        warnings: 0,
        params,
        paramsTruncated: false,
        jobText: { available: 8000, returned: 700 },
      },
    });
  };
  call('r1', 'linkedin_search', 'linkedin', 'ok', { keywords: 'react engineer', geo: 'france', skip_ids: ['1', '2'] });
  call('r2', 'teamtailor_jobs', 'teamtailor', 'ok', { boards: ['bsport'], title_any: ['vp'] });
  call('r3', 'linkedin_search', 'linkedin', 'rate_limited', { keywords: 'vue' });
  log.start({ requestId: 'live', tool: 'apec_search', adapter: 'apec', platform: 'apec', startedAt: NOW });
  return log;
}

async function build(over: Partial<DashboardDeps> = {}, authRequired = false, oidcFor?: (clock: { now: number }) => Oidc) {
  const store = seededStore();
  const registry = await loadModules(['probe'], installedFixtures);
  const holder = createRegistryHolder(registry, (ids) => loadModules(ids, installedFixtures));
  const breaker = new CircuitBreaker(store, () => NOW);
  const limiter = new RateLimiter(store, () => NOW, policyFor(registry.adapters));
  const sessions = new SessionStore(8 * 3600 * 1000, () => clock.now);
  const clock = { now: NOW };
  let activity = 0;
  const deps: DashboardDeps = {
    version: 'test',
    clock: () => clock.now,
    store,
    callLog: seededLog(),
    limiter,
    breaker,
    registry: () => holder.current(),
    installed: installedFixtures,
    budgets: await Budgets.load({ dataDir: tmpdir(), env: {}, ids: ['probe', 'other'], defaults: { probe: { hourly: 50, daily: 500 } } }),
    pinned: { adapters: false, utilities: false },
    runtime: () => undefined,
    settings: {
      signIn: 'none',
      idleStopMinutes: 30,
      sessionMaxHours: 8,
      writeWindowMinutes: 10,
      callBuffer: 2000,
      charsPerToken: 3.5,
      jobRetentionDays: 30,
      maxTabs: 3,
      browser: { idleStopSeconds: 120, memoryHighMb: 1200, memoryMaxMb: 1500 },
      adaptersPinned: false,
    },
    sessionStates: () =>
      new Map([
        [
          'linkedin',
          { platform: 'linkedin', logged_in: true, state: 'ok' as const, checked_at: new Date(NOW - 60_000).toISOString(), cached: false },
        ],
      ]),
    logger: createLogger({ level: 'silent' }),
    publicOrigin: ORIGIN,
    authRequired,
    oidc: oidcFor?.(clock),
    sessions,
    writeWindowMs: 10 * 60 * 1000,
    idleMs: 30 * 60 * 1000,
    onActivity: () => void (activity += 1),
    staticDir: undefined,
    ...over,
  };
  const port = await listen(createServer(createDashboardApp(deps)));
  // node:http, not fetch: fetch cannot set the Host header, and the Host check is part of what is tested
  const call = (
    path: string,
    init: { method?: string; cookie?: string; host?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: { host: init.host ?? new URL(ORIGIN).host, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, one);
            }
            const status = res.statusCode ?? 0;
            resolve(new Response([204, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  return { call, deps, clock, activity: () => activity, port, store };
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const cookiesOf = (response: Response): string[] => response.headers.getSetCookie().map((line) => line.split(';')[0] ?? '');

describe('the API in local development mode (no sign-in)', () => {
  it('answers as the local operator', async () => {
    const t = await build();
    const response = await t.call('/dashboard/api/v1/me', { host: '127.0.0.1:9' });
    expect(await json(response)).toMatchObject({ mode: 'local', email: null, version: 'test' });
  });

  it('gives the overview: health, tokens, running calls', async () => {
    const t = await build();
    const body = await json(await t.call('/dashboard/api/v1/overview'));
    expect(body).toMatchObject({
      health: { completed: 2, failed: 0, rateLimited: 1, active: 1 },
      tokensReturned: 1710,
      storedJobs: 3,
      callsInMemory: 4,
    });
  });

  it('lists calls newest first without their parameters, filters them, and pages', async () => {
    const t = await build();
    const page = await json(await t.call('/dashboard/api/v1/calls?limit=2'));
    expect(page.calls.map((c: any) => c.requestId)).toEqual(['live', 'r3']);
    expect(page.next).not.toBeNull();
    expect(JSON.stringify(page)).not.toContain('skip_ids');
    expect(page.calls[1]).toMatchObject({ keywords: ['vue'], code: 'rate_limited', estimatedTokens: 570 });
    const filtered = await json(await t.call('/dashboard/api/v1/calls?tool=teamtailor_jobs'));
    expect(filtered.calls.map((c: any) => c.requestId)).toEqual(['r2']);
    expect(filtered.calls[0].keywords).toEqual(['vp']);
    const running = await json(await t.call('/dashboard/api/v1/calls?code=running'));
    expect(running.calls.map((c: any) => c.requestId)).toEqual(['live']);
  });

  it('gives the full parameters of one call, and a 404 for a call that left memory', async () => {
    const t = await build();
    const first = (await json(await t.call('/dashboard/api/v1/calls?tool=linkedin_search&code=ok'))).calls[0];
    const detail = await json(await t.call(`/dashboard/api/v1/calls/${first.id}`));
    expect(detail.params).toEqual({ keywords: 'react engineer', geo: 'france', skip_ids: ['1', '2'] });
    expect(detail).toMatchObject({ adapter: 'linkedin', argsHash: 'hash', jobText: { available: 8000, returned: 700 } });
    const missing = await t.call('/dashboard/api/v1/calls/9999');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: 'not_found', message: 'That call is no longer in memory.' });
  });

  it('lists jobs without descriptions, sorted, filtered, searched and paged on the server', async () => {
    const t = await build();
    const all = await json(await t.call('/dashboard/api/v1/jobs?pageSize=10'));
    expect(all.total).toBe(3);
    expect(all.jobs.map((j: any) => j.id)).toEqual(['2000001', '1000002', '1000001']);
    expect(JSON.stringify(all)).not.toContain('What you');
    expect(all.jobs.find((j: any) => j.id === '1000001').foundBy).toEqual([{ keywords: ['react'], disallowed: [] }]);
    expect((await json(await t.call('/dashboard/api/v1/jobs?source=teamtailor'))).jobs.map((j: any) => j.id)).toEqual(['2000001']);
    expect((await json(await t.call('/dashboard/api/v1/jobs?q=backend'))).jobs.map((j: any) => j.id)).toEqual(['1000002']);
    expect((await json(await t.call('/dashboard/api/v1/jobs?found_by=REACT'))).total).toBe(2);
    expect((await json(await t.call('/dashboard/api/v1/jobs?found_by=react&found_by=vue'))).total).toBe(0); // the whole list is the search
    expect((await json(await t.call('/dashboard/api/v1/jobs?no_keywords=1'))).total).toBe(0);
    expect((await json(await t.call('/dashboard/api/v1/jobs?sort=title&dir=asc'))).jobs.map((j: any) => j.title)).toEqual([
      'Backend Engineer',
      'Frontend Engineer',
      'VP Engineering',
    ]);
    const second = await json(await t.call('/dashboard/api/v1/jobs?pageSize=10&page=2'));
    expect(second.jobs).toEqual([]);
    expect((await t.call('/dashboard/api/v1/jobs?pageSize=3')).status).toBe(400);
    expect((await t.call('/dashboard/api/v1/jobs?sort=password')).status).toBe(400);
  });

  it('gives one search with its health, its counts and its jobs, and a 404 for a search that did not run', async () => {
    const t = await build();
    t.deps.store.recordSearch(
      'linkedin',
      {
        keywords: ['staff', 'principal'],
        disallowed: ['Backend', 'x'],
        found: ['1000001', '1000002', '9000001', '9000002', '9000003', '9000004'],
        returned: ['1000001'],
        excluded: [
          { id: '1000002', reason: 'title', term: 'backend' },
          { id: '9000001', reason: 'description', term: 'Backend' },
          { id: '9000002', reason: 'title', term: 'x' },
          { id: '9000003', reason: 'title', term: 'x' },
          { id: '9000004', reason: 'title', term: 'x' },
        ],
      },
      NOW - DAY,
    );
    const detail = await json(
      await t.call(
        '/dashboard/api/v1/searches/linkedin?keywords=Principal&keywords=staff&disallowed=X&disallowed=backend&since=2026-10-01',
      ),
    );
    expect(detail).toMatchObject({
      source: 'linkedin',
      keywords: ['principal', 'staff'],
      disallowed: ['backend', 'x'],
      runs: 1,
      jobsFound: 6,
      jobsReturned: 1,
      jobsExcluded: 5,
      health: { status: 'bad', issues: ['mostly_discarded'] },
      jobsTruncated: false,
    });
    expect(detail.jobs[0]).toMatchObject({ id: '1000001', outcome: 'returned', title: 'Frontend Engineer' });
    expect(detail.jobs.find((j: any) => j.id === '1000002')).toMatchObject({
      outcome: 'excluded',
      title: 'Backend Engineer',
      excludedBy: { reason: 'title', term: 'backend' }, // the term that dropped it, and where
    });
    expect(detail.jobs.find((j: any) => j.id === '9000001')).toMatchObject({
      outcome: 'excluded',
      title: null,
      url: null, // text evicted
      excludedBy: { reason: 'description', term: 'Backend' },
    });
    expect(detail.jobs[0].excludedBy).toBeNull(); // a returned job was not dropped
    // the same keywords without these terms is another search, and did not run
    expect((await t.call('/dashboard/api/v1/searches/linkedin?keywords=principal&keywords=staff')).status).toBe(404);
    expect((await t.call('/dashboard/api/v1/searches/linkedin?keywords=nothing')).status).toBe(404);
    expect((await t.call('/dashboard/api/v1/searches/Bad%20Source?keywords=x')).status).toBe(404);
  });

  it('filters the jobs by the exact search: its keywords, and its disallowed terms or none', async () => {
    const t = await build();
    t.deps.store.recordSearch(
      'linkedin',
      {
        keywords: ['react'],
        disallowed: ['backend'],
        found: ['1000001', '1000002'],
        returned: ['1000001'],
        excluded: [{ id: '1000002', reason: 'title', term: 'backend' }],
      },
      NOW - DAY,
    );
    const total = async (query: string) => (await json(await t.call(`/dashboard/api/v1/jobs?${query}`))).total;
    expect(await total('found_by=react')).toBe(2); // whatever the terms
    expect(await total('found_by=react&no_disallowed=1')).toBe(2); // the search with no terms listed both
    expect(await total('found_by=react&disallowed=Backend')).toBe(2);
    expect(await total('found_by=react&disallowed=frontend')).toBe(0);
    const one = (await json(await t.call('/dashboard/api/v1/jobs/linkedin/1000002'))).foundBy;
    expect(one.map((search: any) => [search.disallowed, search.outcome, search.excludedBy])).toEqual([
      [['backend'], 'excluded', { reason: 'title', term: 'backend' }],
      [[], 'other', null],
    ]);
  });

  it('puts the searches in bad health on the overview: nothing found at all, or most of it discarded', async () => {
    const t = await build();
    expect((await json(await t.call('/dashboard/api/v1/overview'))).badSearches).toEqual({ count: 0, items: [] });
    const found = Array.from({ length: 6 }, (_unused, i) => `5${i}`);
    t.deps.store.recordSearch(
      'linkedin',
      {
        keywords: ['intern'],
        disallowed: ['unpaid'],
        found,
        returned: [],
        excluded: found.map((id) => ({ id, reason: 'title' as const, term: 'unpaid' })),
      },
      NOW - DAY,
    );
    t.deps.store.recordSearch('apec', { keywords: ['ghost'], disallowed: [], found: [], returned: [], excluded: [] }, NOW - 2 * DAY);
    t.deps.store.recordSearch('apec', { keywords: ['ghost'], disallowed: [], found: [], returned: [], excluded: [] }, NOW - DAY);
    const { badSearches } = await json(await t.call('/dashboard/api/v1/overview'));
    expect(badSearches.count).toBe(2);
    expect(badSearches.items.map((row: any) => [row.keywords, row.health.issues])).toEqual([
      [['intern'], ['mostly_discarded']], // and it carries its disallowed terms, so it can be told from the same keywords with other terms
      [['ghost'], ['no_results']],
    ]);
  });

  it('gives one job in full, with sections and hints, and a 404 otherwise', async () => {
    const t = await build();
    const job = await json(await t.call('/dashboard/api/v1/jobs/linkedin/1000001'));
    expect(job.description).toContain('Build Frontend Engineer with React');
    expect(job.outline.length).toBeGreaterThan(0);
    expect(job.hints).toMatchObject({ years: [5] });
    expect(job.hints.stack).toBeUndefined(); // no technology list is built in
    // the searches that found it, each with its counts and health and what it did with this job
    expect(job.foundBy).toEqual([
      {
        keywords: ['react'],
        disallowed: [],
        runs: 1,
        lastRun: new Date(NOW - 3 * DAY).toISOString(),
        jobsFound: 2,
        jobsReturned: 1,
        jobsExcluded: 0,
        health: { status: 'good', issues: [], discardedShare: 0 },
        outcome: 'returned',
        excludedBy: null,
      },
    ]);
    expect((await t.call('/dashboard/api/v1/jobs/linkedin/9999999')).status).toBe(404);
    expect((await t.call('/dashboard/api/v1/jobs/Bad%20Source/1')).status).toBe(404);
  });

  it('gives the keyword statistics, the tools with their budgets, and the usage of the calls in memory', async () => {
    const t = await build();
    const searches = await json(await t.call('/dashboard/api/v1/searches?since=2026-10-01'));
    expect(searches.searches).toEqual([
      {
        source: 'linkedin',
        keywords: ['react'],
        disallowed: [],
        runs: 1,
        firstRun: new Date(NOW - 3 * DAY).toISOString(),
        lastRun: new Date(NOW - 3 * DAY).toISOString(),
        jobsFound: 2,
        jobsReturned: 1,
        jobsExcluded: 0,
        jobsNew: 2,
        health: { status: 'good', issues: [], discardedShare: 0 },
      },
    ]);
    const tools = await json(await t.call('/dashboard/api/v1/tools'));
    const probe = tools.adapters.find((a: any) => a.id === 'probe');
    expect(probe).toMatchObject({ enabled: true, pinned: false, kind: 'http' });
    expect(probe.tools.map((x: any) => x.name)).toContain('probe_echo');
    expect(probe.rateHour).toMatchObject({ used: 0 });
    expect(tools.adapters.find((a: any) => a.id === 'other')).toMatchObject({ enabled: false, rateHour: null });
    const usage = await json(await t.call('/dashboard/api/v1/usage'));
    expect(usage.totals).toMatchObject({ calls: 3, errors: 1, estimatedTokens: 1710, textAvailableChars: 24_000, textReturnedChars: 2100 });
    expect(usage.byTool[0]).toMatchObject({ tool: 'linkedin_search', calls: 2, avgTokens: 570 });
    expect(usage.series).toHaveLength(1);
  });

  it('documents every installed module, enabled or not: annotations, hosts, arguments from the schema, examples', async () => {
    const t = await build();
    const docs = await json(await t.call('/dashboard/api/v1/docs'));
    const probe = docs.modules.find((m: any) => m.id === 'probe');
    expect(probe).toMatchObject({
      role: 'adapter',
      kind: 'http',
      enabled: true,
      allowedHosts: ['api.probe.example.com'],
      openHttps: false,
    });
    const echo = probe.tools.find((tool: any) => tool.name === 'probe_echo');
    expect(echo).toMatchObject({
      title: 'Echo (read-only)',
      annotations: { readOnly: true },
      needsBrowser: false,
      costMax: 1,
      params: [{ name: 'word', type: 'string', required: true, default: null, enum: null, min: null, max: 30 }],
      sampleInput: { word: '<word>' },
      examples: [{ title: 'Echo a word', prompt: 'Echo the word hello with the probe.', input: { word: 'hello' } }],
    });
    expect(docs.modules.find((m: any) => m.id === 'other')).toMatchObject({ enabled: false });
  });

  it('never returns a secret-looking key, a description in a list or a stack trace', async () => {
    const t = await build();
    const paths = ['/overview', '/calls', '/jobs', '/searches', '/tools', '/docs', '/usage', '/me'];
    for (const path of paths) {
      const text = await (await t.call(`/dashboard/api/v1${path}`)).text();
      expect(text, path).not.toMatch(/"(?:cookie|token|secret|password|authorization|client_secret|stack)"/i);
    }
  });

  it('counts every API request as activity', async () => {
    const t = await build();
    await t.call('/dashboard/api/v1/overview');
    await t.call('/dashboard/api/v1/calls');
    expect(t.activity()).toBe(2);
  });
});

describe('protection of every response', () => {
  it('sends the security headers and refuses a Host that is not the public one', async () => {
    const t = await build();
    const ok = await t.call('/dashboard/api/v1/overview');
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(ok.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-powered-by')).toBeNull();
    expect((await t.call('/dashboard/api/v1/overview', { host: 'evil.example.com' })).status).toBe(421);
  });

  it('with sign-in required, accepts only the public host, even for loopback names', async () => {
    const t = await build({}, true);
    expect((await t.call('/dashboard/api/v1/me', { host: '127.0.0.1:9' })).status).toBe(421);
  });

  it('answers 404 for unknown API paths and 400 for a bad query, with the error shape and no detail', async () => {
    const t = await build();
    expect(await json(await t.call('/dashboard/api/v1/nothing'))).toEqual({ error: 'not_found', message: 'No such endpoint.' });
    const bad = await t.call('/dashboard/api/v1/calls?limit=abc');
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: 'invalid_request', message: 'The query is not valid.' });
  });

  it('serves the placeholder page when no interface is installed, and the built app when it is', async () => {
    const t = await build();
    const page = await t.call('/dashboard/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/dashboard/api/v1');
  });
});

describe('sign-in with Google', () => {
  const clientId = 'client-id.apps.googleusercontent.com';

  async function withProvider() {
    const provider = await fakeProvider(clientId);
    const t = await build(
      {},
      true,
      (clock) =>
        new Oidc(
          { issuer: provider.issuer, clientId, clientSecret: 'client-secret', redirectUri: `${ORIGIN}/dashboard/auth/callback` },
          fetch,
          () => clock.now,
          provider.keys,
        ),
    );
    return { provider, t };
  }

  /** Walk the redirects a browser would: login -> provider -> callback. Returns the callback response. */
  async function signIn(
    t: Awaited<ReturnType<typeof withProvider>>['t'],
    provider: Awaited<ReturnType<typeof withProvider>>['provider'],
    next = '/dashboard/',
  ) {
    const start = await t.call(`/dashboard/auth/login?next=${encodeURIComponent(next)}`);
    expect(start.status).toBe(302);
    const stateCookie = cookiesOf(start).find((c) => c.startsWith('jw_dash_state='));
    const authorizeUrl = start.headers.get('location') ?? '';
    const code = provider.approve(authorizeUrl);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    return {
      authorizeUrl,
      callback: (cookie: string | null | undefined = stateCookie, query = `code=${code}&state=${state}`) =>
        t.call(`/dashboard/auth/callback?${query}`, cookie === null || cookie === undefined ? {} : { cookie }),
    };
  }

  it('shows a login page with a Sign in with Google button, and sends API callers away with 401', async () => {
    const { t } = await withProvider();
    expect((await t.call('/dashboard/api/v1/overview')).status).toBe(401);
    const redirect = await t.call('/dashboard/');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toContain('/dashboard/login');
    const login = await (await t.call('/dashboard/login')).text();
    expect(login).toContain('Sign in with Google');
    expect(login).toContain('/dashboard/auth/login');
    expect(login).not.toContain('<script');
  });

  it('sends the browser to the provider with PKCE S256, state, nonce and the openid email scope', async () => {
    const { t, provider } = await withProvider();
    const { authorizeUrl } = await signIn(t, provider);
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe(provider.issuer);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: clientId,
      response_type: 'code',
      scope: 'openid email',
      code_challenge_method: 'S256',
      redirect_uri: `${ORIGIN}/dashboard/auth/callback`,
    });
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('nonce')?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('signs in, sets a strict session cookie scoped to /dashboard, and then serves the API', async () => {
    const { t, provider } = await withProvider();
    const { callback } = await signIn(t, provider, '/dashboard/');
    const done = await callback();
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/dashboard/');
    const setCookie = done.headers.getSetCookie().find((line) => line.startsWith('jw_dash='));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\/dashboard(;|$)/);
    expect(setCookie).toMatch(/Secure/);
    const cookie = cookiesOf(done).find((c) => c.startsWith('jw_dash=')) ?? '';
    const me = await json(await t.call('/dashboard/api/v1/me', { cookie }));
    expect(me).toMatchObject({ mode: 'google', email: 'me@example.com' });
    expect(Date.parse(me['expiresAt'])).toBe(NOW + 8 * 3600 * 1000);
    expect((await t.call('/dashboard/api/v1/overview', { cookie })).status).toBe(200);
  });

  it('refuses a callback whose state cookie is missing or different (login CSRF), and a replayed state', async () => {
    const { t, provider } = await withProvider();
    const { callback } = await signIn(t, provider);
    expect((await callback(null)).headers.get('location')).toContain('/dashboard/login?error=1');
    expect((await callback('jw_dash_state=other')).headers.get('location')).toContain('error=1');
    const second = await signIn(t, provider);
    const first = await second.callback();
    expect(first.headers.get('location')).toBe('/dashboard/');
    expect((await second.callback()).headers.get('location')).toContain('error=1'); // the state is single use
  });

  it.each([
    ['an unverified email', (p: Awaited<ReturnType<typeof fakeProvider>>) => (p.behaviour.emailVerified = false)],
    ['a missing email_verified claim', (p: Awaited<ReturnType<typeof fakeProvider>>) => (p.behaviour.emailVerified = undefined)],
    ['another audience', (p: Awaited<ReturnType<typeof fakeProvider>>) => (p.behaviour.audience = 'someone-else')],
    ["a nonce that is not this sign-in's", (p: Awaited<ReturnType<typeof fakeProvider>>) => (p.behaviour.nonceOverride = 'forged')],
    ['an expired token', (p: Awaited<ReturnType<typeof fakeProvider>>) => (p.behaviour.expired = true)],
  ])('refuses %s and sets no session', async (_name, tamper) => {
    const { t, provider } = await withProvider();
    tamper(provider);
    const { callback } = await signIn(t, provider);
    const done = await callback();
    expect(done.headers.get('location')).toContain('/dashboard/login?error=1');
    expect(cookiesOf(done).some((c) => c.startsWith('jw_dash=') && c !== 'jw_dash=')).toBe(false);
  });

  it('refuses a code the provider did not issue', async () => {
    const { t, provider } = await withProvider();
    const { callback, authorizeUrl } = await signIn(t, provider);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    expect((await callback(null, `code=forged&state=${state}`)).headers.get('location')).toContain('error=1');
  });

  it('keeps `next` inside the dashboard', async () => {
    const { t, provider } = await withProvider();
    for (const next of ['https://evil.example/', '//evil.example', '/other', '/dashboard\\evil']) {
      const { callback } = await signIn(t, provider, next);
      expect((await callback()).headers.get('location')).toBe('/dashboard/');
    }
  });

  it('asks the provider to sign in again when asked to (reauth)', async () => {
    const { t } = await withProvider();
    const start = await t.call('/dashboard/auth/login?reauth=1');
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('prompt')).toBe('login');
  });

  it('ends the session on sign-out and when it expires', async () => {
    const { t, provider } = await withProvider();
    const { callback } = await signIn(t, provider);
    const cookie = cookiesOf(await callback()).find((c) => c.startsWith('jw_dash=')) ?? '';
    expect((await t.call('/dashboard/auth/logout', { method: 'POST', cookie })).status).toBe(403); // no CSRF header
    const out = await t.call('/dashboard/auth/logout', { method: 'POST', cookie, headers: { 'x-jw-csrf': '1', origin: ORIGIN } });
    expect(out.status).toBe(204);
    expect((await t.call('/dashboard/api/v1/overview', { cookie })).status).toBe(401);

    const again = await signIn(t, provider);
    const fresh = cookiesOf(await again.callback()).find((c) => c.startsWith('jw_dash=')) ?? '';
    t.clock.now += 8 * 3600 * 1000 + 1;
    expect((await t.call('/dashboard/api/v1/overview', { cookie: fresh })).status).toBe(401);
  });
});

describe('changes need CSRF protection and a recent sign-in', () => {
  async function signedIn() {
    const t = await build(
      {
        authRequired: true,
        writes: (router) => {
          router.post('/_probe', (_req, res) => void res.json({ changed: true }));
        },
      },
      true,
    );
    // the sessions used by the app are those of `t.deps`; create one through the same store
    const session = t.deps.sessions.create('me@example.com');
    return { t, cookie: `jw_dash=${session.id}`, session };
  }
  const write = (
    t: Awaited<ReturnType<typeof signedIn>>['t'],
    cookie: string,
    headers: Record<string, string> = { 'x-jw-csrf': '1', origin: ORIGIN },
  ) => t.call('/dashboard/api/v1/_probe', { method: 'POST', cookie, headers });

  it('accepts a change with the header, the right Origin and a recent sign-in', async () => {
    const { t, cookie } = await signedIn();
    expect(await json(await write(t, cookie))).toEqual({ changed: true });
  });

  it('refuses a change without the header, with another Origin, or with no sign-in', async () => {
    const { t, cookie } = await signedIn();
    expect((await write(t, cookie, { origin: ORIGIN })).status).toBe(403);
    expect((await write(t, cookie, { 'x-jw-csrf': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await write(t, cookie, { 'x-jw-csrf': '1' })).status).toBe(403);
    expect((await write(t, '')).status).toBe(401);
  });

  it('asks to sign in again when the sign-in is older than the window, and accepts reads all the same', async () => {
    const { t, cookie } = await signedIn();
    t.clock.now += 10 * 60 * 1000 + 1;
    const late = await write(t, cookie);
    expect(late.status).toBe(401);
    expect(await json(late)).toEqual({ error: 'reauth_required', message: 'Sign in again to make this change.' });
    expect((await t.call('/dashboard/api/v1/overview', { cookie })).status).toBe(200);
  });
});

describe('session states in the tools answer', () => {
  it('shows what the last session check found for a browser platform, and nothing for the others', async () => {
    const t = await build();
    const tools = await json(await t.call('/dashboard/api/v1/tools'));
    const probe = tools.adapters.find((a: any) => a.id === 'probe');
    expect(probe.session).toBeNull(); // an HTTP adapter has no session
    expect(tools.adapters.every((a: any) => 'session' in a)).toBe(true);
  });
});

describe('the Origin of a change in local development', () => {
  const put = (t: Awaited<ReturnType<typeof build>>, origin: string | undefined) =>
    t.call('/dashboard/api/v1/_probe', {
      method: 'POST',
      host: '127.0.0.1:18933',
      headers: { 'x-jw-csrf': '1', ...(origin ? { origin } : {}) },
    });
  const local = () => build({ writes: (router) => void router.post('/_probe', (_req, res) => void res.json({ changed: true })) }, false);

  it("accepts the page's own loopback origin, which is not the public one, and refuses any other", async () => {
    const t = await local();
    expect((await put(t, 'http://127.0.0.1:18933')).status).toBe(200);
    expect((await put(t, 'http://evil.example')).status).toBe(403);
    expect((await put(t, 'http://127.0.0.1:9999')).status).toBe(403); // another port is another origin
    expect((await put(t, undefined)).status).toBe(403);
  });

  it('with sign-in required, only the public origin is accepted, whatever the Host', async () => {
    const t = await build({ writes: (router) => void router.post('/_probe', (_req, res) => void res.json({ changed: true })) }, true);
    const session = t.deps.sessions.create('me@example.com');
    const send = (origin: string) =>
      t.call('/dashboard/api/v1/_probe', { method: 'POST', cookie: `jw_dash=${session.id}`, headers: { 'x-jw-csrf': '1', origin } });
    expect((await send(ORIGIN)).status).toBe(200);
    expect((await send(`http://${new URL(ORIGIN).host}`)).status).toBe(403); // same host, other scheme
  });
});

describe('usage over time', () => {
  const addDays = (store: Store) => {
    const row = (day: number, tool: string, platform: string, over: object = {}) =>
      store.recordDailyUsage({
        ts: Date.UTC(2026, 9, day, 10),
        tool,
        platform,
        error: false,
        responseBytes: 1000,
        tokens: 300,
        units: 2,
        durationMs: 500,
        textAvailable: 4000,
        textReturned: 400,
        ...over,
      });
    row(5, 'linkedin_search', 'linkedin');
    row(5, 'linkedin_search', 'linkedin', { error: true, durationMs: 1500, tokens: 100 });
    row(6, 'linkedin_search', 'linkedin');
    row(6, 'apec_search', 'apec', { tokens: 900, durationMs: 200 });
    row(8, 'apec_search', 'apec');
  };

  it('lifetime reads the persisted totals: per tool and per day, with averages and no percentiles', async () => {
    const t = await build();
    addDays(t.store);
    const usage = await json(await t.call('/dashboard/api/v1/usage?scope=lifetime'));
    expect(usage).toMatchObject({ scope: 'lifetime', granularity: 'day' });
    expect(usage.totals).toMatchObject({
      calls: 5,
      errors: 1,
      estimatedTokens: 1900,
      unitsSpent: 10,
      textAvailableChars: 20_000,
      textReturnedChars: 2000,
      durationP50Ms: null,
      durationP95Ms: null,
      durationMaxMs: 1500,
    });
    expect(usage.byTool.map((x: any) => [x.tool, x.calls, x.estimatedTokens, x.avgTokens])).toEqual([
      ['apec_search', 2, 1200, 600],
      ['linkedin_search', 3, 700, 233],
    ]);
    expect(usage.byTool.find((x: any) => x.tool === 'linkedin_search')).toMatchObject({ avgDurationMs: 833, maxDurationMs: 1500 });
    expect(usage.series.map((x: any) => [x.bucket.slice(0, 10), x.calls, x.errors])).toEqual([
      ['2026-10-05', 2, 1],
      ['2026-10-06', 2, 0],
      ['2026-10-08', 1, 0],
    ]);
  });

  it('historical reads a range of days and can be narrowed to one tool or platform', async () => {
    const t = await build();
    addDays(t.store);
    const range = await json(await t.call('/dashboard/api/v1/usage?scope=historical&from=2026-10-06&to=2026-10-07'));
    expect(range.totals.calls).toBe(2);
    expect(range.series.map((x: any) => x.bucket.slice(0, 10))).toEqual(['2026-10-06']);
    expect((await json(await t.call('/dashboard/api/v1/usage?scope=lifetime&platform=apec'))).totals.calls).toBe(2);
    expect((await json(await t.call('/dashboard/api/v1/usage?scope=lifetime&tool=linkedin_search'))).byTool).toHaveLength(1);
    expect((await json(await t.call('/dashboard/api/v1/usage?scope=lifetime&tool=nothing'))).totals.calls).toBe(0);
  });

  it('is the calls in memory, by the hour, with percentiles, when no scope is given', async () => {
    const t = await build();
    const usage = await json(await t.call('/dashboard/api/v1/usage'));
    expect(usage).toMatchObject({ scope: 'session', granularity: 'hour' });
    expect(usage.totals.durationP50Ms).toBe(400);
  });

  it('refuses a scope it does not know and a date it cannot read', async () => {
    const t = await build();
    expect((await t.call('/dashboard/api/v1/usage?scope=forever')).status).toBe(400);
    expect((await t.call('/dashboard/api/v1/usage?scope=historical&from=yesterday')).status).toBe(400);
  });
});

describe('settings', () => {
  it('shows the limits in force and nothing secret', async () => {
    const t = await build();
    const settings = await json(await t.call('/dashboard/api/v1/settings'));
    expect(settings).toMatchObject({
      signIn: 'none',
      idleStopMinutes: 30,
      sessionMaxHours: 8,
      writeWindowMinutes: 10,
      callBuffer: 2000,
      maxTabs: 3,
      browser: { memoryMaxMb: 1500 },
    });
    expect(Object.keys(settings).join(' ')).not.toMatch(/secret|password|authorization|oidc|client|cookie/i);
    expect(JSON.stringify(settings)).not.toMatch(/secret|password|authorization|cookie/i);
  });
});
