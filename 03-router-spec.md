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

## Repo layout: Nx monorepo (decided 2026-10-01)
npm workspaces + Nx (same setup as TraderTavern). Packages are private to the workspace (scope `@jobwatch`), not published.
```
jobwatch-mcp/
  nx.json  package.json  package-lock.json  tsconfig.base.json  .nvmrc  eslint.config.js
  packages/
    sdk/                @jobwatch/sdk      THE CONTRACT adapters build on: defineAdapter, defineTool, AdapterContext,
                                           BrowserSession, HttpClient, SearchLayout, error classes, SDK_API_VERSION.
                                           Subpath @jobwatch/sdk/testkit: FakeBrowserSession, contract-test runner.
                                           Light dependencies (zod only).
    core/               @jobwatch/core     THE ENGINE: config, registry (loadAdapters), handleCall pipeline, limits
                                           (ratelimit, breaker), store (SQLite), runtime (RuntimeBackend, DockerCliBackend,
                                           manager, watchdog), browser (session.ts over CDP, cdp.ts, fingerprint.ts),
                                           obs (pino, prom-client), built-in ops tools (session_status, memory_report).
                                           Depends on sdk only.
    adapters/           @jobwatch/adapters THE INSTALLED LIST: one static map  name -> () => import("@jobwatch/adapter-<name>")
                                           plus metadata. The single registration point shared by the server and the CLI.
    adapter-linkedin/   @jobwatch/adapter-linkedin   index.ts (defineAdapter), layouts/classic.ts, layouts/aiSearchResults.ts,
                                           parse.ts, selectors.ts, extract.js, fixtures/, catalog/ (generated snapshot), tests
    adapter-ats/ adapter-apec/ adapter-wttj/         same shape, added in later phases
  apps/
    mcp/                @jobwatch/mcp      composition root: reads config, asks @jobwatch/adapters for the ENABLED adapters,
                                           hands them to core, serves stateless Streamable HTTP, /healthz, /metrics.
                                           The router Dockerfile builds this app.
    cli/                @jobwatch/cli      `jobwatch` binary: adapters list|enable|disable, login <platform>, catalog gen|check, doctor
  tools/generators/adapter/                `nx g @jobwatch/tools:adapter <name>`: scaffolds a new adapter package
  images/browser/       Dockerfile, entrypoint.sh, chrome-seccomp.json (see 05)
  deploy/               compose.yml, nginx site files (see 10)
  docs/  spikes/  Dockerfile (router image, builds apps/mcp)  .dockerignore
  data/                 runtime state (gitignored): router SQLite, adapters.json
```
Dependency rules, enforced by Nx module boundaries (`@nx/enforce-module-boundaries` with tags `type:sdk`, `type:core`, `type:adapter`, `type:adapters`, `type:app`) and by lint:
- `sdk` depends on nothing in the workspace. `core` depends only on `sdk`.
- **`adapter-*` may depend only on `sdk`.** They cannot import `core`, other adapters, `playwright-core`, `better-sqlite3`, or Node's `fs`, `net`, `child_process`, `http(s)` (lint rule `no-restricted-imports`). Network and browser access exist only through `AdapterContext`.
- `adapters` depends on every `adapter-*` and on `sdk`. `apps/*` may depend on `core`, `sdk` and `adapters`.
- `playwright-core` is imported in exactly one file: `packages/core/src/browser/session.ts`.

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
Goal: a new platform is one generated package plus one registration line, with no engine change.

```ts
// packages/adapter-apec/src/index.ts  (imports ONLY @jobwatch/sdk)
import { defineAdapter, defineTool, z } from "@jobwatch/sdk";

export default defineAdapter({
  id: "apec",                              // the name used by `jobwatch adapters enable apec` and in adapters.json
  displayName: "APEC",
  description: "APEC job search (read-only).",
  sdkApi: 1,                               // SDK_API_VERSION this adapter was written against
  platform: "apec",                        // profile name, rate-limit and breaker key
  kind: "http",                            // "browser" => leased Chrome + BrowserSession; "http" => HttpClient, no container
  allowedHosts: ["www.apec.fr"],
  tools: [
    defineTool({
      name: "apec_search", title: "APEC job search (read-only)", description: "...read-only, no side effects...",
      input: z.object({ keywords: z.string().max(200), page: z.number().int().min(1).max(5).default(1) }).strict(),
      output: CardsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      limits: { timeoutS: 60, cost: 1, outputMaxBytes: 60_000 },
      handler: async ({ keywords, page }, { http, pace }) => { /* POST the search API, normalize */ },
    }),
  ],
});
```

### Registration and enable / disable
1. **Installed**: `packages/adapters/src/index.ts` is the one place that lists adapter packages:
   ```ts
   export const installed = {
     linkedin: () => import("@jobwatch/adapter-linkedin").then((m) => m.default),
     apec:     () => import("@jobwatch/adapter-apec").then((m) => m.default),
   } satisfies Record<string, () => Promise<AdapterModule>>;
   ```
   The generator adds the line. Both the server and the CLI import this map, so they always agree.
2. **Enabled**: which installed adapters the router actually plugs in. Stored in `adapters.json` in the data directory (`/data/adapters.json` in the container): `{ "enabled": ["linkedin"] }`. Environment override: `JW_ADAPTERS=linkedin,apec` (wins over the file; the CLI refuses to edit while it is set). **Default on a fresh install: nothing enabled**, so only the built-in ops tools are exposed; the LinkedIn adapter must be enabled on purpose (its usage budget needs Matthieu's approval, `09-security.md`).
3. **Plugging**: `apps/mcp` calls `loadAdapters(enabledNames, installed)` from core. It imports only the enabled adapters, runs the startup checks below, and builds `tools/list` from them. An unknown name is a startup error. A disabled adapter contributes no tools, its runtime is never started, and its profile volume is untouched.
4. **Changing the set requires a router restart** (`docker compose restart router`); the connector may need to be refreshed in Claude to see the new tool list (VERIFY in Phase 2). Stateless HTTP cannot push `tools/list_changed`.

### CLI (`jobwatch`, package `apps/cli`)
```
jobwatch adapters list [--json]      all INSTALLED adapters: id, platform, kind, tools, allowed hosts, ENABLED / disabled
jobwatch adapters enable  <id...>    add to adapters.json (validates the id exists in `installed`)
jobwatch adapters disable <id...>    remove from adapters.json
jobwatch login <platform>            browser login mode (05); only for enabled browser adapters
jobwatch catalog gen | check         regenerate / verify the committed per-adapter catalog snapshots
jobwatch doctor                      config, Docker socket, image, data dir, enabled adapters, SDK version compatibility
```
The CLI ships inside the router image too, so on the host: `docker compose exec router jobwatch adapters list`. Writing `adapters.json` is atomic (temp file + rename) and the file is the only state the CLI changes.

### Rules the SDK and registry enforce, so adapter authors cannot break the ground rules
- **One source of truth.** A tool's schemas, annotations, limits and handler live together. `tools/list` is built at startup from the enabled adapters (pure data, no container).
- **Startup checks** (per adapter, fail fast): `sdkApi` equals the running `SDK_API_VERSION`; `id` and tool names are unique; `readOnlyHint: true` on every tool; input schemas are `.strict()`; every string has `max()` and every array has `max()`; descriptions state read-only behaviour; every host in `allowedHosts` is a bare hostname.
- **Catalog snapshots.** Each adapter package has `catalog/*.json`, written by `jobwatch catalog gen` (`nx run <adapter>:catalog`) and committed. A contract test (sdk testkit) fails if the snapshot differs from the adapter's definitions, so every change to what Claude can see shows up in that adapter's diff. Snapshots exist for every installed adapter; only enabled ones are served.
- **Sandboxed surface.** Handlers get only `AdapterContext` (`session`, `http`, `log`, `pace`). `BrowserSession` and `HttpClient` enforce `allowedHosts`; no click, type or generic navigation is ever exposed; handler results are validated against the tool's `output` schema before `shapeOutput`.
- **Lifecycle is not the adapter's job.** Leasing, the single tab (`06`), timeouts, rate limiting, breaker, memory policy and error mapping stay in core. An adapter signals problems by throwing `SessionInvalid`, `Checkpoint` or `AdapterBroken`.
- **Honest limit:** adapters run in-process, so an adapter is trusted code. The SDK narrows what it is handed and lint forbids dangerous imports, but it is not a sandbox. Only adapters from this repository are installed; loading external packages by name is deliberately not supported (`JW_EXTRA_ADAPTERS` rejected, 2026-10-01).
- **Testable offline.** `@jobwatch/sdk/testkit` provides `FakeBrowserSession` (replays saved, **logged-out or synthetic** HTML from the adapter's `fixtures/`, never real logged-in pages), a fake `HttpClient`, and `runAdapterContract(adapter)` which checks the startup rules, the snapshot, and every tool's output against its schema.

Checklist for a new adapter: `nx g @jobwatch/tools:adapter <id>`; write tools, fixtures and tests; `jobwatch catalog gen`; the generator already added the line to `packages/adapters`; add its pacing and budget to `07-…`/`08-…`; for a browser adapter, add its profile name to the login CLI; `jobwatch adapters enable <id>` on the host.

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
    const ctx = await browser.useSingleTab(spec.platform);                // the ONE tab (never a second), host allowlist enforced
    try {
      res = await withTimeout(spec.handler(args, ctx), spec.timeoutS * 1000);
    } catch (e) {
      if (e instanceof SessionInvalid) breaker.open(spec.platform, "needs_login");
      if (e instanceof Checkpoint) breaker.open(spec.platform, "checkpoint", { ttlS: 6 * 3600 });
      throw e;
    } finally {
      await ctx.parkTab();                                // always: goto about:blank, never close
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
JW_BASE_URL=https://mcp.noguetith.fr          # public URL (resource identifier)
JW_FRONT_SHARED_SECRET=...                    # header from the OAuth front (or mTLS)
JW_RUNTIME=docker                             # docker | systemd-scope
JW_BROWSER_IMAGE=localhost/jobwatch-browser:1
JW_PROFILE_VOLUME_PREFIX=jw-profile-         # browser profiles are named Docker volumes jw-profile-<platform> (no host paths: works on Linux and macOS)
JW_AUTH=front                                # front | none (none only for local development, loopback only; see compose.dev.yml)
JW_DATA_DIR=/srv/jobwatch/data                # router SQLite, adapters.json (enabled adapters)
JW_ADAPTERS=                                  # optional comma list, e.g. linkedin,apec; overrides adapters.json when set; default: none enabled
JW_IDLE_TTL_S=120  JW_MAX_LIFETIME_S=1800  JW_QUEUE_TIMEOUT_S=60
JW_MEM_HIGH_MB=1200 JW_MEM_MAX_MB=1500        # defaults, measured in S5 (see 06); per-tool budgets override
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
