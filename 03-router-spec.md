# 03 — Router specification

> **Related docs:** Load for router code (MCP app, Adapter SDK, limits, errors, config). Also load: `04` (tool schemas, catalog snapshot), `06` (RAM and state machine), `05` (CDP and browser driving), `07`/`08` (when writing an adapter), `09` (error and trust rules), `10` (config, healthz, metrics, deploy), `16` (diagrams). Follow a link only if the task needs it.

The router is the only custom service (plus adapters). It is always-on, small, single process, async.

## Responsibilities
1. Serve MCP over Streamable HTTP (stateless) at `/mcp`.
2. Answer `tools/list` from the static catalog (no spawn).
3. Validate `tools/call` arguments with the tool's input schema.
4. Enforce rate limits, daily budgets and the circuit breaker **before** touching a browser.
5. Manage runtimes (browser containers): spawn, health-check, reuse, preempt, reap, kill.
6. Run the adapter, normalize output, enforce output size caps.
7. Record structured logs and metrics.
8. Never trust the client: only catalog tools exist, only allowlisted hosts are reachable by adapters.

It does **not** implement OAuth (the front does), unless decision D7(c) is taken. It still validates that requests come through the front (shared secret header or mTLS on the private network; VERIFY best option for the chosen front).

## Suggested repo layout
```
jobwatch-mcp/
  docs/                      # these MD files
  Dockerfile                 # router image (multi-stage, see 10)
  .dockerignore
  package.json               # npm project (ESM, Node 26; .nvmrc)
  package-lock.json
  tsconfig.json              # strict
  src/
    app.ts                   # Express app + McpServer wiring, /healthz
    config.ts                # zod-validated config; env + config.yaml
    catalog/
      snapshot.ts            # `npm run catalog:gen`: registry -> catalog/*.json; drift check used by tests
      models.ts              # zod schemas + types: ToolDefinition limits, Budget, RatePolicy
    runtime/
      backend.ts             # RuntimeBackend interface
      dockerCli.ts           # DockerCliBackend
      manager.ts             # state machine per platform, semaphore, reaper
      watchdog.ts            # memory polling, thresholds
    browser/
      session.ts             # BrowserSession implementation over CDP (the only file importing playwright-core)
      cdp.ts                 # connectOverCDP wrapper, tab lifecycle, host allowlist
      fingerprint.ts         # startup self-check (navigator.webdriver etc.)
    adapters/
      sdk.ts                 # defineAdapter, defineTool, AdapterContext, BrowserSession, HttpClient
      registry.ts            # auto-discovers src/adapters/*/index.ts, builds tools/list, rejects duplicates
      linkedin/
        index.ts (defineAdapter), extract.js, parse.ts, selectors.ts, fixtures/
        layouts/classic.ts, layouts/aiSearchResults.ts   # one SearchLayout per LinkedIn search UI (see 07)
      apec/ wttj/ ats/       # later phases
    limits/
      ratelimit.ts, breaker.ts
    store/
      db.ts                  # sqlite (better-sqlite3) (WAL): counters, breaker, seen_ids, call_log
    obs/
      logging.ts, metrics.ts
  catalog/                   # static tool definitions (see 04)
    session_status.json, linkedin_search.json, linkedin_job.json, ...
  images/browser/            # Dockerfile + entrypoint.sh (see 05)
  deploy/                    # compose.yml, systemd units, nginx snippet (see 10)
  tests/                     # unit, contract, integration (see 11)
  data/                      # runtime state (gitignored)
  profiles/                  # browser profiles (gitignored, 0700)
```

## Core interfaces (sketch)

```ts
interface RuntimeBackend {
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, graceS: number): Promise<void>;   // graceful then kill
  isRunning(handle: RuntimeHandle): Promise<boolean>;
  memoryBytes(handle: RuntimeHandle): Promise<number>;          // cgroup memory.current
  cdpUrl(handle: RuntimeHandle): Promise<string>;               // internal ws/http endpoint
}

// One adapter = one module that declares everything about a platform in one place (see "Adapter SDK" below).
interface AdapterModule {
  platform: string;                      // also the profile name and the rate-limit/breaker key
  kind: "browser" | "http";              // browser => leased Chrome + BrowserSession; http => HttpClient, no container
  allowedHosts: string[];                // enforced by the SDK, adapters cannot bypass it
  sessionCheck?(s: BrowserSession): Promise<SessionStatus>;   // browser adapters: logged in / needs_login / checkpoint
  tools: ToolDefinition[];               // built with defineTool()
}

interface ToolDefinition<I = unknown, O = unknown> {
  name: string; title: string; description: string;           // description states read-only, no side effects
  input: z.ZodType<I>; output: z.ZodType<O>;                  // zod; converted to JSON Schema for tools/list
  annotations: { readOnlyHint: true; openWorldHint: boolean; idempotentHint: boolean };   // readOnlyHint is literal true
  limits: { timeoutS: number; memory?: { highMb: number; maxMb: number }; cost: number; outputMaxBytes: number };
  handler(args: I, ctx: AdapterContext): Promise<AdapterResult>;
}

// Everything a handler may touch. No Playwright types, no raw CDP, no Node fs/net access by convention (lint rule).
interface AdapterContext {
  session: BrowserSession;               // browser adapters only (kind: "browser")
  http: HttpClient;                      // fetch wrapper: allowlist, timeout, size cap, per-host pacing
  log: Logger;                           // redacted structured logger
  pace(kind: "page" | "detail"): Promise<void>;   // human-like delay from the platform's pacing policy
}

// The ONLY browser surface adapters see. Implemented once over Playwright/CDP (browser/session.ts), so swapping
// Playwright for Patchright or raw CDP never touches an adapter.
interface BrowserSession {
  goto(url: string, opts?: { waitFor?: string; timeoutMs: number }): Promise<void>;   // host allowlist enforced
  evaluate<T>(script: string | (() => T), arg?: unknown): Promise<T>;                // runs in the page, result is JSON-serializable
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  text(selector: string): Promise<string | null>;
  url(): string;
}

interface AdapterResult {
  data: Record<string, unknown>;  // structured payload matching the tool's output schema
  text?: string;                  // compact markdown view (optional)
  warnings: string[];             // e.g. "remote filter not applied; post-filtered"
}
```

## Adapter SDK (adding a platform)
Goal: a new platform is one directory plus one test, with no router change.

```ts
// src/adapters/apec/index.ts
export default defineAdapter({
  platform: "apec",
  kind: "browser",
  allowedHosts: ["www.apec.fr"],
  sessionCheck: async (s) => { await s.goto("https://www.apec.fr/"); return parseLoginState(await s.evaluate(EXTRACT_LOGIN)); },
  tools: [
    defineTool({
      name: "apec_search", title: "APEC job search (read-only)", description: "...read-only, no side effects...",
      input: z.object({ keywords: z.string().max(200), page: z.number().int().min(1).max(5).default(1) }).strict(),
      output: CardsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      limits: { timeoutS: 90, cost: 1, outputMaxBytes: 60_000 },
      handler: async ({ keywords, page }, { session, pace }) => { /* goto, evaluate, parse */ },
    }),
  ],
});
```
Rules the SDK enforces, so adapter authors cannot break the ground rules:
- **One source of truth.** The tool's schemas, annotations, limits and handler live together. `tools/list` is built at startup from the registry (pure data, no container), so a new adapter appears in `tools/list` automatically.
- **Auto-discovery.** `registry.ts` imports every `src/adapters/*/index.ts` default export. Startup fails on duplicate tool names, a missing `readOnlyHint: true`, `additionalProperties` not false (`.strict()`), strings without `max()`, arrays without `max()`, or a description shorter than the read-only statement.
- **Catalog snapshot.** `npm run catalog:gen` writes `catalog/*.json` from the registry. It is committed, and a contract test fails if the snapshot differs from the registry, so every change to what Claude can see shows up in review. `04-…` describes the snapshot format.
- **Sandboxed surface.** Handlers get only `AdapterContext`. `BrowserSession` and `HttpClient` enforce `allowedHosts`; there is no click, type or generic navigation exposed to clients, and handlers cannot return values outside their `output` schema (validated before `shapeOutput`).
- **Lifecycle is not the adapter's job.** Leasing, tab open/close, timeouts, rate limiting, breaker, memory policy and error mapping stay in the router. An adapter signals problems by throwing `SessionInvalid`, `Checkpoint` or `AdapterBroken`.
- **Testable offline.** `@jobwatch/testkit` (in-repo) provides a `FakeBrowserSession` that replays saved, **logged-out or synthetic** HTML from `fixtures/` (never real logged-in pages), plus a contract test that runs every registered tool against its schemas.

Checklist for a new browser adapter: create `src/adapters/<platform>/index.ts`; add a profile name to the login CLI; add fixtures and a test; run `npm run catalog:gen`; add the platform's pacing and budget to `07-…`/`08-…`. Shared parsing helpers go in `adapters/_shared/`.

## tools/call flow (pseudo-code)
```ts
async function handleCall(toolName: string, rawArgs: unknown, request: Request) {
  const spec = registry.tool(toolName);                   // unknown tool -> protocol error
  const args = spec.input.parse(rawArgs);                // zod; ZodError -> invalid_arguments
  if (spec.platform) {                                    // browser- or http-backed
    limiter.check(spec.platform, spec.cost);              // throws RateLimited(retryAfter)
    breaker.check(spec.platform);                         // throws NeedsLogin / CheckpointOpen
  }
  let res: AdapterResult;
  if (spec.needsBrowser) {
    await using lease = await runtimes.lease(spec.platform, spec.budget);  // global semaphore=1, preempts idle others
    const ctx = await browser.openWorkingTab(spec.platform);               // one tab, host allowlist enforced
    try {
      res = await withTimeout(spec.handler(args, ctx), spec.timeoutS * 1000);
    } catch (e) {
      if (e instanceof SessionInvalid) breaker.open(spec.platform, "needs_login");
      if (e instanceof Checkpoint) breaker.open(spec.platform, "checkpoint", { ttlS: 6 * 3600 });
      throw e;
    } finally {
      await ctx.closeTab();                               // always
    }
    runtimes.touch(spec.platform);                        // (re)start idle timer, default 120 s
  } else {
    res = await spec.handler(args, httpCtx);            // plain HTTP adapters
  }
  return shapeOutput(res, spec.outputLimits);             // cap bytes, add structured content + text
}
```

## Concurrency model
- Global async semaphore (capacity 1, small in-house FIFO class or `async-mutex`) for browser leases (configurable later; default 1 because RAM is limited).
- Waiters are served FIFO with a **queue timeout** (default 60 s) → error `busy` with `retry_after`.
- Plain-HTTP adapters (ATS APIs) run outside the semaphore, with their own small concurrency limit (e.g., 4) and per-host pacing.
- Tool calls from the same client may arrive in parallel; serialization happens at the lease, not in the client.

## Error model
Tool errors return MCP `isError: true` with a JSON body `{ "code": "...", "message": "...", "retry_after_s": int|null, "details": {...} }`. Codes:
`invalid_arguments`, `needs_login`, `checkpoint`, `rate_limited`, `busy`, `budget_exceeded` (memory), `oom_killed`, `timeout`, `adapter_broken` (selector drift: extracted 0 cards / missing fields), `upstream_error`, `internal`.
Never include cookies, tokens, full URLs with session parameters, or raw HTML in errors.

## Output rules
- Structured result + optional compact Markdown. Hard cap per call (default 60 KB of text; adapters paginate/truncate with `truncated: true` and counts).
- Always include `source`, `fetched_at` (UTC ISO), `warnings`.
- Mark text coming from web pages as **untrusted content** (field name `untrusted_text` or a wrapper) so the client can treat it as data, not instructions.

## Configuration (env + `config.yaml`)
```
JW_BASE_URL=https://mcp.example.com          # public URL (resource identifier)
JW_FRONT_SHARED_SECRET=...                    # header from the OAuth front (or mTLS)
JW_RUNTIME=docker                             # docker | systemd-scope
JW_BROWSER_IMAGE=localhost/jobwatch-browser:1
JW_PROFILES_DIR=/srv/jobwatch/profiles
JW_DATA_DIR=/srv/jobwatch/data
JW_IDLE_TTL_S=120  JW_MAX_LIFETIME_S=1800  JW_QUEUE_TIMEOUT_S=60
JW_MEM_HIGH_MB=900 JW_MEM_MAX_MB=1100         # defaults; per-tool budgets override (see 06)
JW_LOG_LEVEL=info
JW_METRICS_ENABLED=false                      # true => Prometheus /metrics on JW_METRICS_PORT
JW_METRICS_PORT=9464
```

## Health and ops endpoints
- `GET /healthz` (unauthenticated, returns only `{"ok":true}`) for the Docker/compose healthcheck and Nginx upstream checks.
- Prometheus metrics, **optional, off by default**: when `JW_METRICS_ENABLED=true` the router serves `GET /metrics` (Prometheus text format, `prom-client`) on a **separate listener** (`JW_METRICS_PORT`, default 9464), never on the MCP port, so it cannot be reached through the OAuth front or Nginx. Metrics: `jw_tool_calls_total{tool,platform,result}`, `jw_tool_duration_seconds{tool}`, `jw_runtime_state{platform,state}`, `jw_runtime_cold_starts_total{platform}`, `jw_runtime_peak_rss_bytes{platform}`, `jw_rate_limit_tokens{platform}`, `jw_breaker_open{platform,reason}`, `jw_queue_wait_seconds`. Labels are low-cardinality only: no args, no URLs, no ids.
- Ops tool `memory_report` (catalog, read-only) returns runtime states and recent peak RSS.

## Logging
JSON lines: `ts, request_id, tool, platform, duration_ms, cold_start, peak_rss_mb, result(ok|code), args_hash`. Do not log raw arguments containing user data beyond search keywords; never log tokens or cookies.

## Graceful shutdown
On SIGTERM: stop accepting calls, let in-flight finish (max 20 s), stop all runtimes gracefully, close DB.

## Startup self-checks
1. Catalog loads and validates.
2. Runtime backend reachable (`docker info`).
3. Browser image present (no pull at runtime unless configured).
4. Orphan cleanup: remove containers with the `jobwatch.managed=true` label left from a crash.
