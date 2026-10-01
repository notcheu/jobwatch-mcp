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
    sdk/                @jobwatch/sdk      THE CONTRACT adapters build on: defineAdapter, defineHttpTool/defineBrowserTool, AdapterContext,
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
  tools/new-adapter/                       `npm run new:adapter -- <id> [--kind http|browser]`: scaffolds a new adapter package
                                           (a plain Node script, not an Nx plugin generator: no build pipeline for ten small files)
  images/browser/       Dockerfile, entrypoint.sh, chrome-seccomp.json (see 05)
  deploy/               compose.yml, nginx site files (see 10)
  docs/  spikes/  Dockerfile (router image, builds apps/mcp)  .dockerignore
  data/                 runtime state (gitignored): router SQLite, adapters.json
```
Dependency rules, enforced by Nx module boundaries (`@nx/enforce-module-boundaries` with tags `type:sdk`, `type:core`, `type:adapter`, `type:adapters`, `type:app`) and by lint:
- `sdk` depends on nothing in the workspace. `core` depends only on `sdk`.
- **`adapter-*` may depend only on `sdk`.** They cannot import `core`, other adapters, `playwright-core`, `node:sqlite`, or Node's `fs`, `net`, `child_process`, `http(s)` (lint rule `no-restricted-imports`). Network and browser access exist only through `AdapterContext`.
- `adapters` depends on every `adapter-*` and on `sdk`. `apps/*` may depend on `core`, `sdk` and `adapters`.
- `playwright-core` is imported in exactly one file: `packages/core/src/browser/session.ts`.

## Engine interfaces (sketch) and where the adapter contract lives

```ts
interface RuntimeBackend {
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, graceS: number): Promise<void>;   // graceful then kill
  isRunning(handle: RuntimeHandle): Promise<boolean>;
  memoryBytes(handle: RuntimeHandle): Promise<number>;          // cgroup memory.current
  cdpUrl(handle: RuntimeHandle): Promise<string>;               // internal ws/http endpoint
}

// Adapter-facing types (AdapterModule, ToolDefinition, AdapterContext, BrowserSession, HttpClient, AdapterResult, errors)
// are implemented in packages/sdk/src. THE CODE IS THE SOURCE OF TRUTH for them; read it instead of a sketch here:
//   version.ts  errors.ts  hosts.ts  context.ts  tool.ts  adapter.ts  schema.ts  validate.ts  catalog.ts
// Only the engine-side interface below is still a sketch until Phase 1 step 5.
```

## Implemented in `packages/core` (Phase 1, step 3)
- **`loadConfig(env)`** (`config.ts`): validates every `JW_*` variable with zod, collects all problems at once, never echoes values. Empty values count as unset (docker compose passes `VAR=`). Cross-checks: `http` base URL only for loopback; **`JW_AUTH=none` only with a loopback `JW_BASE_URL`** (a no-auth server can never run behind the public hostname); `JW_MEM_HIGH_MB < JW_MEM_MAX_MB`; the metrics port differs from the MCP port. Unknown `JW_*` variables are reported as warnings (typos). `describeConfig` redacts the shared secret.
- **Enabled adapters** (`adapters-config.ts`): `<dataDir>/adapters.json`, written atomically (temp file + rename), sorted and de-duplicated. Precedence: `JW_ADAPTERS` > file > nothing. A missing file means nothing enabled; a present but broken file is an error, never "nothing". Enabling refuses ids that are not installed; **disabling always works** so a stale entry (an adapter deleted from the code) can be removed; editing is refused while `JW_ADAPTERS` is set.
- **`loadAdapters(enabledIds, installed)`** (`registry.ts`): imports only the enabled adapters, runs `validateAdapter` on each, and fails with every problem at once: unknown id, module id different from its key, a loader that throws, duplicate tool names across adapters, two adapters on one platform with different kinds. **`listTools(registry)`** answers `tools/list` from the definitions: pure data, no handler, no container (tested with a handler call counter).
- **Logging** (`logging.ts`): pino JSON with ISO timestamps; the logger an adapter receives is tagged with its id and sanitizes free-form fields: sensitive keys (`cookie`, `token`, `secret`, `password`, `authorization`, `session`, `api key`, `li_at`) become `[redacted]`, URL values lose query string, userinfo and fragment, nested objects are omitted.

## Implemented in `apps/mcp` and `apps/cli` (Phase 1, step 4)
- **HTTP surface** (`apps/mcp/src/app.ts`): `GET /healthz` returns only `{"ok":true}`; `POST /mcp` is stateless Streamable HTTP (a new MCP server and transport per request, no session id, nothing remembered); `GET` and `DELETE /mcp` are 405; everything else is 404. Bodies are capped at 256 KB; malformed JSON gets a JSON-RPC parse error, never a stack trace. Metrics are served on a **separate listener** (`JW_METRICS_PORT`), so `/metrics` does not exist on the MCP port and cannot be reached through the OAuth front or Nginx.
- **`tools/list`** is answered by `listTools(registry)`: pure data from the enabled adapters, so no handler runs and no container starts (tested with a handler counter). A disabled adapter's tools are neither listed nor callable.
- **`tools/call`** goes through `callTool` in `@jobwatch/core` (`call.ts`): unknown tool is an MCP protocol error (`-32602`); invalid arguments, handler failures, timeouts, a result that does not match the output schema (`adapter_broken`) and a result over `outputMaxBytes` are all tool errors (`isError`) with the documented codes. Errors that are not `JobwatchError` are logged in full and returned as a generic `internal` error with a `request_id`: a message from inside an adapter or library may contain URLs, cookies or HTML. Arguments are never logged, only a 12-character hash. A timeout stops waiting but cannot cancel a running handler; the browser lease (step 6) is what bounds the damage. The context a handler receives comes from a `ContextProvider`; **this build has none** (`noRuntime`), so calling a tool returns a clear `internal` error until steps 5 and 6.
- **Result shape:** `structuredContent` is the validated `data` and matches the tool's `outputSchema`; `content[0].text` is the adapter's Markdown or the JSON, followed by any warnings; `_meta.jobwatch` carries `request_id`, `adapter`, `fetched_at` and `warnings`. (Decision: the envelope fields live in `_meta` and the text, not in `structuredContent`, so the structured part always validates against the schema in the catalog.)
- **Authentication:** `JW_AUTH=front` (default): with `JW_FRONT_SHARED_SECRET` set the router requires `Authorization: Bearer <secret>` (constant-time comparison); without it the router relies on network isolation (no published port, only the front reaches it) and logs a warning. VERIFY when the stack is assembled that babs/mcp-auth-proxy can inject that header towards the upstream. `JW_AUTH=none` (loopback only, enforced in `loadConfig`) additionally rejects any request whose `Host` header is not the loopback host, against DNS rebinding.
- **Startup is fail-fast:** a bad configuration or a broken enabled adapter prints every problem and exits 1. `SIGTERM` and `SIGINT` close the listeners and drain in-flight requests (10 s, then connections are cut).
- **CLI** (`jobwatch`, `apps/cli`): `adapters list [--json]`, `adapters enable|disable <id...>`, `--help`, `--version`. It needs only `JW_DATA_DIR` and `JW_ADAPTERS`, never the public base URL. Exit codes: 0 ok, 1 usage or configuration error, 2 an installed adapter is broken. Output has no colour codes (safe to pipe); `--json` is clean JSON (the build step is silent). Run it as `npm run jobwatch -- adapters list` in the repository, or `jobwatch adapters list` inside the router container.
- **Build:** `nx run-many -t build -p @jobwatch/mcp @jobwatch/cli` bundles each app into one ESM file with esbuild (`dist/apps/mcp/main.js` 3.6 MB, `dist/apps/cli/main.js` 1.0 MB). The unscoped name `nx build mcp` does not resolve; use the scoped project names.

## Implemented in `packages/core`: store, rate limits, breaker (Phase 1, step 5a)
- **Store** (`store/store.ts`, `node:sqlite`): the router's only persistent state, in `<JW_DATA_DIR>/jobwatch.sqlite` (override `JW_DB_PATH`; `:memory:` in tests). WAL, `busy_timeout`, file mode 0600, parent directory created. Schema versioned with `PRAGMA user_version` and forward-only migrations; a database written by a NEWER build is refused. Tables: `usage` (rate-limit events), `breaker`, `call_log` (ts, request id, tool, adapter, platform, outcome, duration, 12-character arguments hash: no column can hold arguments, cookies or page content). Retention: call log 30 days, usage events 2 days, pruned at startup and every six hours. `Store.close()` is idempotent. `seen_ids` is not created yet (needed only by the `seen_filter` tool of Phase 4).
- **Rate limiter** (`limits/ratelimit.ts`): two sliding windows per platform, one hour and 24 hours, from the adapter's `rate` (`perHour`, `perDay`) or the engine default (browser 120/300, http 600/3000: the LinkedIn numbers are defaults pending Matthieu's approval, `09-security.md`). A tool's `limits.cost` is taken up front, in one transaction with the check, so concurrent calls can never overshoot (tested: 6 simultaneous calls against a budget of 3 give exactly 3 successes). A refused call is not charged; a call whose handler fails is (the request reached the platform). `rate_limited` carries `retry_after_s`: the time until enough of the oldest events leave the window for the call to fit (the longer of the two windows when both block). The budget survives a restart.
- **Circuit breaker** (`limits/breaker.ts`): per platform, persisted, so a router restart never forgets a checkpoint. `needs_login` stays open until closed (by a successful `session_status` after a manual login, step 7); `checkpoint` closes by itself after six hours. A checkpoint is never downgraded to `needs_login`. The breaker opens when a handler throws `SessionInvalid` or `Checkpoint`; while open the platform is neither called nor charged.
- **Order around a call** (`limits/guard.ts`, used by `callTool`): validate arguments, then breaker, then rate limiter, then the handler. (Reverse of the early sketch: checking the breaker first means a platform that asked for a login spends no budget.) Every outcome, including refusals, goes to the call log through a recorder; a recorder that throws never fails the call.
- **Metrics:** `jw_breaker_open{platform,reason}` (1 while open). Server wiring in `apps/mcp/src/server.ts`; a database that cannot be opened stops startup, because running without limits would mean nothing stops us from hammering a platform after a checkpoint.

## Implemented in `packages/core`: runtime manager (Phase 1, step 5b)
- **`RuntimeBackend`** (`runtime/backend.ts`): `start`, `stop`, `inspect`, `memoryBytes`, `listManaged`, `remove`. `DockerCliBackend` shells out to `docker` with an argument ARRAY (no shell) and validates every value first (names, image, volume, network, memory, seccomp path, environment) so a hostile value can never become an option: the image comes last after `--`. The tests pin every hardening flag of `06` (`--cap-drop ALL`, `no-new-privileges`, custom seccomp, `--read-only`, tmpfs, `--memory` = `--memory-swap`, `--oom-score-adj 500`, named profile volume, `jobwatch.managed` label) and assert there is no published port, no host mount, no `--privileged`. Memory is read inside the container as `memory.current - inactive_file` (the working set), and an unreadable value is an error, never `0` (found by a test: an empty read parsed as zero bytes and would have silenced the watchdog).
- **`RuntimeManager`** (`runtime/manager.ts`): the state machine of `06` as ONE slot, since a second platform can only run after the first is gone. `lease(platform)` queues FIFO behind a capacity-1 semaphore (`busy` + `retry_after_s` after `JW_QUEUE_TIMEOUT_S`), reuses a warm runtime of the same platform, stops an idle runtime of another platform immediately (preemption), recycles one older than `JW_MAX_LIFETIME_S` at the next lease (never mid-call) or one that died while idle, and cold-starts otherwise with one retry and a 30 s start timeout (a failed start removes its container and surfaces a generic `internal` error with no docker output). The idle timer (`JW_IDLE_TTL_S`) stops the runtime; a lease arriving mid-stop waits for it and starts fresh. Stopping is: optional `quit` hook (Browser.close, 10 s cap, errors ignored), then `docker stop -t 10` (SIGTERM then SIGKILL), then `docker rm`; if stop fails the container is removed by force. Profile volumes are never touched.
- **Watchdog** (every 5 s, while busy or idle): container gone -> the lease's `signal` is aborted with `oom_killed` (kernel OOM) or `internal`; working set at 70 % of the runtime's cap -> `onWarn` hook (at most every 30 s); at 90 % -> abort with `budget_exceeded` and stop the runtime. Thresholds follow the per-lease cap, a failed reading is logged and retried (it never kills a working browser), and no timer is left behind once the runtime is gone. `Lease.signal.reason` is the `JobwatchError` the call returns; `Lease.peakBytes()` feeds the call log.
- **Hooks for step 6:** `ready` (DevTools answered, fingerprint check; a rejection fails the start), `quit`, `onWarn`. The manager is complete and tested without a browser.
- **Server wiring:** the manager exists only when an enabled adapter is `kind: "browser"`; an HTTP-only router never touches docker. At startup it removes containers labelled `jobwatch.managed` left by a previous router (a docker that is unreachable is logged, not fatal), and shutdown stops the browser. New settings: `JW_BROWSER_NETWORK` (default `jobwatch-browsers`; under compose the real name is `<project>_jobwatch-browsers`), `JW_BROWSER_SECCOMP` (absolute path as seen by the docker CLI in the router container). Metrics: `jw_runtime_state`, `jw_runtime_cold_starts_total`, `jw_runtime_cold_start_seconds`, `jw_runtime_stops_total{reason}`, `jw_runtime_rss_bytes`, `jw_queue_wait_seconds`.
- **Not done here (step 6):** turning a lease into an `AdapterContext` (CDP connection by IP, the single tab, host allowlist), the fingerprint check, and the `ContextProvider` that `callTool` needs. Until then browser tools still return the clear `internal` "no runtime" error.

## Adapter SDK (adding a platform)
Goal: a new platform is one generated package plus one registration line, with no engine change.

```ts
// packages/adapter-apec/src/index.ts  (imports ONLY @jobwatch/sdk)
import { SDK_API_VERSION, defineAdapter, defineHttpTool, z } from "@jobwatch/sdk";

const searchTool = defineHttpTool({
  name: "apec_search", title: "APEC job search (read-only)",
  description: "Searches APEC job offers by keywords. Read-only, no side effects.",
  input: z.object({ keywords: z.string().max(200), page: z.number().int().min(1).max(5).default(1) }).strict(),
  output: CardsOutput,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  limits: { timeoutS: 60, cost: 1, outputMaxBytes: 60_000 },
  handler: async ({ keywords, page }, { http, pace }) => {
    const res = await http.postJson("https://www.apec.fr/cms/webservices/rechercheOffre", body(keywords, page));
    const parsed = res.json(ApecSearchResponse);        // a changed response shape throws AdapterBroken, never an empty list
    return { data: normalize(parsed), warnings: [] };
  },
});

export default defineAdapter({
  id: "apec",                              // the name used by `jobwatch adapters enable apec` and in adapters.json
  displayName: "APEC",
  description: "APEC job search (read-only).",
  sdkApi: SDK_API_VERSION,                 // the contract version this adapter was written against
  platform: "apec",                        // profile name, rate-limit and breaker key
  kind: "http",                            // "browser" => leased single-tab Chrome + BrowserSession; "http" => HttpClient, no container
  allowedHosts: ["www.apec.fr"],           // bare hostnames, exact match, https only
  rate: { perHour: 600, perDay: 3000 },    // optional budget for the platform; omit for the default of the adapter kind
  tools: [searchTool],
});
```
Tools are built with `defineHttpTool` (handler context: `{ http, log, pace }`) or `defineBrowserTool` (adds `session`). The compiler rejects a browser tool inside an HTTP adapter, `readOnlyHint: false`, a handler result that does not match the `output` schema, and any use of `ctx.session` in an HTTP tool (type tests in `packages/sdk/src/validate.test.ts`).

### Registration and enable / disable
1. **Installed**: `packages/adapters/src/index.ts` is the one place that lists adapter packages:
   ```ts
   export const installed = {
     linkedin: () => import("@jobwatch/adapter-linkedin").then((m) => m.default),
     apec:     () => import("@jobwatch/adapter-apec").then((m) => m.default),
   } satisfies Record<string, () => Promise<AdapterModule>>;
   ```
   The generator adds the line between the `<installed:begin>` / `<installed:end>` markers, sorted. Both the server and the CLI import this map, so they always agree.
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
- **Catalog snapshots.** Each adapter package has `catalog/*.json`, written by `npm run catalog:gen` (it runs every adapter's contract test with `JW_UPDATE_CATALOG=1`, like `vitest -u`; the Nx cache is skipped on purpose) and committed. The snapshots are excluded from prettier: they are deterministic output reviewed as a diff. A contract test (sdk testkit) fails if the snapshot differs from the adapter's definitions, so every change to what Claude can see shows up in that adapter's diff. Snapshots exist for every installed adapter; only enabled ones are served.
- **Sandboxed surface.** Handlers get only `AdapterContext` (`session`, `http`, `log`, `pace`). `BrowserSession` and `HttpClient` enforce `allowedHosts`; no click, type or generic navigation is ever exposed; handler results are validated against the tool's `output` schema before `shapeOutput`.
- **Lifecycle is not the adapter's job.** Leasing, the single tab (`06`), timeouts, rate limiting, breaker, memory policy and error mapping stay in core. An adapter signals problems by throwing `SessionInvalid`, `Checkpoint` or `AdapterBroken`.
- **Honest limit:** adapters run in-process, so an adapter is trusted code. The SDK narrows what it is handed and lint forbids dangerous imports, but it is not a sandbox. Only adapters from this repository are installed; loading external packages by name is deliberately not supported (`JW_EXTRA_ADAPTERS` rejected, 2026-10-01).
- **Entry points of `@jobwatch/sdk`:** `.` (the contract; imports nothing from Node), `./testkit` (fakes and the contract runner; tests only), `./catalog-fs` (read/write catalog snapshots; Node only, used by the CLI and the contract test).
- **Implemented checks (`validateAdapter`, a pure function the registry, `doctor` and the contract test all call):** `sdk-api`, `id`, `platform`, `hosts`, `tools`, `tool-name`, `tool-unique`, `read-only`, `description` (title 1-80, description 20-600 characters and the word "read-only"), `limits` (timeout 1-300 s, cost 1-100, output 1 KB-256 KB, memory `128 <= high < max <= 4096`), `schema` (must be expressible as JSON Schema), `schema-strict` (every object `additionalProperties: false`), `schema-bounded` (every string `maxLength` unless enum/const, every array `maxItems`, including strings hidden in unions and nullable values). Cross-adapter checks (duplicate tool names or ids across adapters) belong to the registry in core.
- **Host allowlist (`isUrlAllowed` / `assertUrlAllowed`):** https only, no credentials in the URL, default port only, hostname must EQUAL a listed host (no subdomain or suffix matching, no IP literals). Core's real `BrowserSession` and `HttpClient` must call it on every navigation and request, including redirects; the fakes already do.
- **Testable offline.** `@jobwatch/sdk/testkit` provides `FakeBrowserSession` (replays saved, **logged-out or synthetic** HTML from the adapter's `fixtures/`, never real logged-in pages), a fake `HttpClient`, and `runAdapterContract(adapter)` which checks the startup rules, the snapshot, and every tool's output against its schema.

Checklist for a new adapter: `npm run new:adapter -- <id>` (creates `packages/adapter-<id>`, adds the line and the dependency to `packages/adapters`, runs `npm install`, formats the files and writes the first catalog snapshot); write tools, fixtures and tests; `npm run catalog:gen` after every change to a tool definition; add its pacing and budget to `07-…`/`08-…`; for a browser adapter, add its profile name to the login CLI; `jobwatch adapters enable <id>` on the host.

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
JW_BROWSER_NETWORK=jobwatch-browsers          # internal Docker network of the browsers (compose names it <project>_jobwatch-browsers)
JW_BROWSER_SECCOMP=                           # absolute path of the Chrome seccomp profile in the router container; unset = Docker default
JW_PROFILE_VOLUME_PREFIX=jw-profile-         # browser profiles are named Docker volumes jw-profile-<platform> (no host paths: works on Linux and macOS)
JW_AUTH=front                                # front | none (none only for local development, loopback only; see compose.dev.yml)
JW_DATA_DIR=/srv/jobwatch/data                # router SQLite, adapters.json (enabled adapters)
JW_DB_PATH=                                   # optional: SQLite file; default <JW_DATA_DIR>/jobwatch.sqlite
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
