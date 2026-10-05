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
    core/               @jobwatch/core     THE ENGINE: config, registry (loadModules), handleCall pipeline, limits
                                           (ratelimit, breaker), store (SQLite), runtime (RuntimeBackend, DockerCliBackend,
                                           manager, watchdog), browser (session.ts over CDP, cdp.ts, fingerprint.ts),
                                           obs (pino, prom-client), built-in ops tools (session_status, memory_report).
                                           Depends on sdk only.
    mcp-modules/        @jobwatch/mcp-modules THE INSTALLED LISTS: two static maps, `installedAdapters` and `installedUtilities`
                                           (name -> () => import("@jobwatch/adapter-<name>" or "@jobwatch/utility-<name>")), plus
                                           `installedModules` (both) and the describe functions. The single registration point
                                           shared by the server and the CLI.
    adapter-linkedin/   @jobwatch/adapter-linkedin   index.ts (defineAdapter), layouts/classic.ts, layouts/aiSearchResults.ts,
                                           parse.ts, selectors.ts, extract.js, fixtures/, catalog/ (generated snapshot), tests
    adapter-ats/ adapter-apec/ adapter-wttj/         same shape, added in later phases
  apps/
    mcp/                @jobwatch/mcp      composition root: reads config, asks @jobwatch/mcp-modules for the ENABLED modules,
                                           hands them to core, serves stateless Streamable HTTP, /healthz, /metrics.
                                           The router Dockerfile builds this app.
    cli/                @jobwatch/cli      `jobwatch` binary: adapters list|enable|disable, login start|stop <platform>, doctor
  tools/new-module/                        `npm run new:adapter -- <id> [--kind http|browser]` and `npm run new:utility -- <id>`: scaffold a new adapter or utility package
                                           (a plain Node script, not an Nx plugin generator: no build pipeline for ten small files)
  images/browser/       Dockerfile, entrypoint.sh, chrome-seccomp.json (see 05)
  deploy/               compose.yml, nginx site files (see 10)
  docs/plans/           the numbered design docs (00 to 16); docs/measurements.md holds the Phase 0 measurements
  Dockerfile            router image (builds apps/mcp)   .dockerignore
  data/                 runtime state (gitignored): router SQLite, adapters.json
```
Dependency rules, enforced by Nx module boundaries (`@nx/enforce-module-boundaries` with tags `type:sdk`, `type:core`, `type:adapter`, `type:utility`, `type:modules`, `type:app`) and by lint:
- `sdk` depends on nothing in the workspace. `core` depends only on `sdk`.
- **`adapter-*` may depend only on `sdk`.** They cannot import `core`, other adapters, `playwright-core`, `node:sqlite`, or Node's `fs`, `net`, `child_process`, `http(s)` (lint rule `no-restricted-imports`). Network and browser access exist only through `AdapterContext`.
- `utility-*` follow the same rule as `adapter-*`: `sdk` only.
- `mcp-modules` depends on every `adapter-*`, every `utility-*` and on `sdk`. `apps/*` may depend on `core`, `sdk` and `mcp-modules`.
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
- **`loadConfig(env)`** (`config.ts`): validates the environment with the zod schema of `env.ts` (`parseEnv`), collects all problems at once, never echoes values. Empty values count as unset (docker compose passes `VAR=`). Cross-checks: `http` base URL only for loopback; **`AUTH=none` only with a loopback `BASE_URL`** (a no-auth server can never run behind the public hostname); `BROWSER_MEM_HIGH_MB < BROWSER_MEM_MAX_MB`; the metrics port differs from the MCP port. Unknown `JW_*` variables are reported as warnings (typos). `describeConfig` redacts the shared secret.
- **Enabled modules** (`adapters-config.ts`: `resolveEnabledModules`, `setModulesEnabled`): `<dataDir>/adapters.json`, written atomically (temp file + rename), sorted and de-duplicated. Precedence, per list: `ADAPTERS` / `UTILITIES` > file > nothing. A missing file means nothing enabled; a present but broken file is an error, never "nothing". Enabling refuses ids that are not installed; **disabling always works** so a stale entry (an adapter deleted from the code) can be removed; editing is refused while `ADAPTERS` is set.
- **`loadModules(enabledIds, installed)`** (`registry.ts`): imports only the enabled adapters, runs `validateAdapter` on each, and fails with every problem at once: unknown id, module id different from its key, a loader that throws, duplicate tool names across adapters, two adapters on one platform with different kinds. **`listTools(registry)`** answers `tools/list` from the definitions: pure data, no handler, no container (tested with a handler call counter).
- **Logging** (`logging.ts`): pino JSON with ISO timestamps; the logger an adapter receives is tagged with its id and sanitizes free-form fields: sensitive keys (`cookie`, `token`, `secret`, `password`, `authorization`, `session`, `api key`, `li_at`) become `[redacted]`, URL values lose query string, userinfo and fragment, nested objects are omitted.

## Implemented in `apps/mcp` and `apps/cli` (Phase 1, step 4)
- **HTTP surface** (`apps/mcp/src/app.ts`): `GET /healthz` returns only `{"ok":true}`; `POST /mcp` is stateless Streamable HTTP (a new MCP server and transport per request, no session id, nothing remembered); `GET` and `DELETE /mcp` are 405; everything else is 404. Bodies are capped at 256 KB; malformed JSON gets a JSON-RPC parse error, never a stack trace. Metrics are served on a **separate listener** (`METRICS_PORT`), so `/metrics` does not exist on the MCP port and cannot be reached through the OAuth front or Nginx.
- **`tools/list`** is answered by `listTools(registry)`: pure data from the enabled adapters, so no handler runs and no container starts (tested with a handler counter). A disabled adapter's tools are neither listed nor callable.
- **`tools/call`** goes through `callTool` in `@jobwatch/core` (`call.ts`): unknown tool is an MCP protocol error (`-32602`); invalid arguments, handler failures, timeouts, a result that does not match the output schema (`adapter_broken`) and a result over `outputMaxBytes` are all tool errors (`isError`) with the documented codes. Errors that are not `JobwatchError` are logged in full and returned as a generic `internal` error with a `request_id`: a message from inside an adapter or library may contain URLs, cookies or HTML. Arguments are never logged, only a 12-character hash. A timeout stops waiting but cannot cancel a running handler; the browser lease (step 6) is what bounds the damage. The context a handler receives comes from a `ContextProvider`; **this build has none** (`noRuntime`), so calling a tool returns a clear `internal` error until steps 5 and 6.
- **Result shape:** `structuredContent` is the validated `data` and matches the tool's `outputSchema`; `content[0].text` is the adapter's Markdown or the JSON, followed by any warnings; `_meta.jobwatch` carries `request_id`, `adapter`, `fetched_at` and `warnings`. (Decision: the envelope fields live in `_meta` and the text, not in `structuredContent`, so the structured part always validates against the schema in the catalog.)
- **Authentication:** `AUTH=front` (default): with `FRONT_SHARED_SECRET` set the router requires `Authorization: Bearer <secret>` (constant-time comparison); without it the router relies on network isolation (no published port, only the front reaches it) and logs a warning. VERIFY when the stack is assembled that babs/mcp-auth-proxy can inject that header towards the upstream. `AUTH=none` (loopback only, enforced in `loadConfig`) additionally rejects any request whose `Host` header is not the loopback host, against DNS rebinding.
- **Startup is fail-fast:** a bad configuration or a broken enabled adapter prints every problem and exits 1. `SIGTERM` and `SIGINT` close the listeners and drain in-flight requests (10 s, then connections are cut).
- **CLI** (`jobwatch`, `apps/cli`): `adapters list [--json]`, `adapters enable|disable <id...>`, and the same three for `utilities` (each command only sees modules of its own role and says which command a misplaced id belongs to), `--help`, `--version`. It needs only `DATA_DIR`, `ADAPTERS` and `UTILITIES`, never the public base URL. Exit codes: 0 ok, 1 usage or configuration error, 2 an installed adapter is broken. Output has no colour codes (safe to pipe); `--json` is clean JSON (the build step is silent). Run it as `npm run jobwatch -- adapters list` in the repository, or `jobwatch adapters list` inside the router container.
- **Build:** `nx run-many -t build -p @jobwatch/mcp @jobwatch/cli` bundles each app into one ESM file with esbuild (`dist/apps/mcp/main.js` 3.6 MB, `dist/apps/cli/main.js` 1.0 MB). The unscoped name `nx build mcp` does not resolve; use the scoped project names.

## Implemented in `packages/core`: store, rate limits, breaker (Phase 1, step 5a)
- **Store** (`store/store.ts`, `node:sqlite`): the router's only persistent state, in `<DATA_DIR>/jobwatch.sqlite` (override `DB_PATH`; `:memory:` in tests). WAL, `busy_timeout`, file mode 0600, parent directory created. Schema versioned with `PRAGMA user_version` and forward-only migrations; a database written by a NEWER build is refused. Tables: `usage` (rate-limit events), `breaker`, `call_log` (ts, request id, tool, adapter, platform, outcome, duration, 12-character arguments hash: no column can hold arguments, cookies or page content). Retention: call log 30 days, usage events 2 days, pruned at startup and every six hours. `Store.close()` is idempotent. `seen_ids` is not created yet (needed only by the `seen_filter` tool of Phase 4).
- **Rate limiter** (`limits/ratelimit.ts`): two sliding windows per platform, one hour and 24 hours, from the adapter's `rate` (`perHour`, `perDay`) or the engine default (browser 120/300, http 600/3000: the LinkedIn numbers are defaults pending the owner's approval, `09-security.md`). A tool's `limits.cost` is taken up front, in one transaction with the check, so concurrent calls can never overshoot (tested: 6 simultaneous calls against a budget of 3 give exactly 3 successes). A refused call is not charged; a call whose handler fails is (the request reached the platform). `rate_limited` carries `retry_after_s`: the time until enough of the oldest events leave the window for the call to fit (the longer of the two windows when both block). The budget survives a restart.
- **Circuit breaker** (`limits/breaker.ts`): per platform, persisted, so a router restart never forgets a checkpoint. `needs_login` stays open until closed (by a successful `session_status` after a manual login, step 7); `checkpoint` closes by itself after six hours. A checkpoint is never downgraded to `needs_login`. The breaker opens when a handler throws `SessionInvalid` or `Checkpoint`; while open the platform is neither called nor charged.
- **Order around a call** (`limits/guard.ts`, used by `callTool`): validate arguments, then breaker, then rate limiter, then the handler. (Reverse of the early sketch: checking the breaker first means a platform that asked for a login spends no budget.) Every outcome, including refusals, goes to the call log through a recorder; a recorder that throws never fails the call.
- **Metrics:** `jw_breaker_open{platform,reason}` (1 while open). Server wiring in `apps/mcp/src/server.ts`; a database that cannot be opened stops startup, because running without limits would mean nothing stops us from hammering a platform after a checkpoint.

## Implemented in `packages/core`: runtime manager (Phase 1, step 5b)
- **`RuntimeBackend`** (`runtime/backend.ts`): `start`, `stop`, `inspect`, `memoryBytes`, `listManaged`, `remove`. `DockerCliBackend` shells out to `docker` with an argument ARRAY (no shell) and validates every value first (names, image, volume, network, memory, seccomp path, environment) so a hostile value can never become an option: the image comes last after `--`. The tests pin every hardening flag of `06` (`--cap-drop ALL`, `no-new-privileges`, custom seccomp, `--read-only`, tmpfs, `--memory` = `--memory-swap`, `--oom-score-adj 500`, named profile volume, `jobwatch.managed` label) and assert there is no published port, no host mount, no `--privileged`. Memory is read inside the container as `memory.current - inactive_file` (the working set), and an unreadable value is an error, never `0` (found by a test: an empty read parsed as zero bytes and would have silenced the watchdog).
- **`RuntimeManager`** (`runtime/manager.ts`): the state machine of `06` as ONE slot, since a second platform can only run after the first is gone. `lease(platform)` queues FIFO behind a capacity-1 semaphore (`busy` + `retry_after_s` after `BROWSER_QUEUE_TIMEOUT_S`), reuses a warm runtime of the same platform, stops an idle runtime of another platform immediately (preemption), recycles one older than `BROWSER_MAX_LIFETIME_S` at the next lease (never mid-call) or one that died while idle, and cold-starts otherwise with one retry and a 30 s start timeout (a failed start removes its container and surfaces a generic `internal` error with no docker output). The idle timer (`BROWSER_IDLE_TTL_S`) stops the runtime; a lease arriving mid-stop waits for it and starts fresh. Stopping is: optional `quit` hook (Browser.close, 10 s cap, errors ignored), then `docker stop -t 10` (SIGTERM then SIGKILL), then `docker rm`; if stop fails the container is removed by force. Profile volumes are never touched.
- **Watchdog** (every 5 s, while busy or idle): container gone -> the lease's `signal` is aborted with `oom_killed` (kernel OOM) or `internal`; working set at 70 % of the runtime's cap -> `onWarn` hook (at most every 30 s); at 90 % -> abort with `budget_exceeded` and stop the runtime. Thresholds follow the per-lease cap, a failed reading is logged and retried (it never kills a working browser), and no timer is left behind once the runtime is gone. `Lease.signal.reason` is the `JobwatchError` the call returns; `Lease.peakBytes()` feeds the call log.
- **Hooks for step 6:** `ready` (DevTools answered, fingerprint check; a rejection fails the start), `quit`, `onWarn`. The manager is complete and tested without a browser.
- **Server wiring:** the manager exists only when an enabled adapter is `kind: "browser"`; an HTTP-only router never touches docker. At startup it removes containers labelled `jobwatch.managed` left by a previous router (a docker that is unreachable is logged, not fatal), and shutdown stops the browser. New settings: `BROWSER_NETWORK` (default `jobwatch-browsers`; under compose the real name is `<project>_jobwatch-browsers`), `BROWSER_SECCOMP` (absolute path as seen by the docker CLI in the router container). Metrics: `jw_runtime_state`, `jw_runtime_cold_starts_total`, `jw_runtime_cold_start_seconds`, `jw_runtime_stops_total{reason}`, `jw_runtime_rss_bytes`, `jw_queue_wait_seconds`.
- **Not done here (step 6):** turning a lease into an `AdapterContext` (CDP connection by IP, the single tab, host allowlist), the fingerprint check, and the `ContextProvider` that `callTool` needs. Until then browser tools still return the clear `internal` "no runtime" error.

## Implemented in `packages/core`: browser layer, HTTP client, contexts (Phase 1, step 6)
- **`createContextProvider`** (`contexts.ts`) builds the `AdapterContext` of each call and replaces the old "no runtime" stub. HTTP adapters get an allowlisted `HttpClient`, a sanitizing logger and a pacer. Browser adapters additionally lease the runtime (with the largest per-tool memory budget), connect over CDP **by IP**, and receive the guarded single-tab session. On release, in order and best-effort: park the tab on `about:blank`, drop the connection, hand the lease back; a failing step never skips the next one, and a failed connection releases the lease and returns a generic error naming only the platform. The lease's `signal` is raced against the handler in `callTool`, so a browser killed for memory (`budget_exceeded`) or by the kernel (`oom_killed`) fails the call at once instead of at the tool timeout.
- **`HttpClient`** (`http/client.ts`): checks the host allowlist on the request and on **every redirect hop** (a redirect off the allowlist is refused before it is requested), manual redirects (max 3; 301/302/303 become GET), a timeout (`timeout` code), a 2 MB body cap (declared length and streaming), a per-host politeness gap (500 ms, queued so concurrent calls cannot burst), concurrency 4. Adapters cannot set `Cookie`, `Authorization`, `Host`, `Origin`, `Sec-*`, `Proxy-*` or headers with line breaks; no cookies are sent or kept and `Set-Cookie` is never exposed; network errors become a generic `upstream_error` with no detail in the message. Known gap: it does not resolve DNS itself, so an allowed hostname that someone points at a private address is not caught (the hosts are fixed public sites).
- **`BrowserSession`** (`browser/pageSession.ts` + `browser/session.ts`): the logic is tested against a minimal `PageLike`; `session.ts`, the only file importing `playwright-core` (loaded lazily, so an HTTP-only router never loads it), connects by IP, takes the tab Chrome started with, never calls `newPage`, closes extra tabs and any popup at once, and parks instead of closing. `goto` refuses (before touching the page) any URL off the allowlist: https only, exact host, no credentials, default port. A second layer aborts every document or frame navigation the page makes by itself to a host not in the allowlist. **Decision:** sub-resources (scripts, images, XHR) are NOT filtered, because they are the site's own, and blocking them would also change how the session looks to LinkedIn (S5 found that blocking images did not help memory anyway). Errors are mapped to `timeout`, `upstream_error` or `internal` with no URL in the message; the original is kept as `cause` for the log.
- **`evaluate` contract (found by the integration test):** Playwright treats a string as an expression, so `'() => 1'` returned the function, not `1`, and the fingerprint check refused a healthy browser. A string script is now a function expression CALLED with the argument (JSON-encoded, never spliced in as code); the unit tests pin the exact wrapping.
- **Startup fingerprint check** (`browser/fingerprint.ts`, run by the `ready` hook): `webdriver` not true, no `HeadlessChrome`, `window.chrome` present, plugins not empty, no `__playwright*`/`__pw*` globals, and `navigator.languages` equal to the configured list (`BROWSER_ACCEPT_LANGS`, spike finding G8). `BROWSER_FINGERPRINT=enforce` (default) fails the start on a mismatch, `warn` logs it, `off` skips it. The check connects with no allowed hosts and only reads `about:blank`.
- **Cost model** (`limits/guard.ts`, `ratelimit.ts`, `call.ts`, `contexts.ts`): one unit is one request to the site (an HTTP request, a page load, a request made from inside the page, a "next page" press). Three steps, in this order:
  1. **Reserve.** Before the handler runs, the guard reserves the tool's `limits.estimate(args)` (what THIS call is likely to need, from its validated arguments, kept between 1 and `limits.cost`; no estimate, or one that throws, reserves `limits.cost`, the maximum). It is reserved in the same transaction as the check, so concurrent calls cannot both take the last units. A small request is therefore not refused for room that a big one would have needed.
  2. **Measure.** Every call has a meter, kept by the engine, not by the adapter: each `ctx.http` request and each `session.goto` is counted when it is attempted (a request that fails may still have reached the site). An adapter reports only contact the engine cannot see, with `ctx.spend(n)`: a request made from inside the page (Apec), a "next page" press (WTTJ).
  3. **Settle**, once, in a `finally`, whatever way the call ended. Success: the handler's own `cost` if it returned one, else the meter. Failure after some work: the meter, not the reservation. Failure before anything was touched (the browser was busy, the queue timed out): 0. Less than reserved: the difference goes back (0 removes the event). More than reserved: the excess is recorded as a further event, never refused, because the requests were already made; a count above the tool's maximum is capped there (a buggy adapter must not lock a platform out). A nonsense report (NaN, negative) is ignored and the reservation stands.
- **Budget per company board** (ATS adapters, `keyRate` + `limits.keys(args)`): a tool may name the boards a call touches (the resolved label, e.g. `bsport` or `careers.bsport.io/en`); each board then has its own budget, stored under the usage key `platform#board`, next to the platform ceiling. The guard reserves the estimate on every key in one transaction (`takeAll`), so a call is accepted only if the platform and every board have room; otherwise the whole call is refused with `rate_limited`, the error names `platform/board` and `retry_after_s` is when it fits. Settling spreads the measured cost back over the keys; a call that touched nothing refunds them all. A handle and a custom domain of the same company are two keys. `memory_report` lists the boards used in the last 24 hours (`boards`, busiest first, at most 25).
- **Places on LinkedIn** (`packages/sdk/src/linkedinGeo.ts`, `adapter-linkedin/src/geo.ts`, utility `utility-linkedin-geo`, enabled with `jobwatch utilities enable linkedin-geo`): LinkedIn's public location autocomplete (`/jobs-guest/api/typeaheadHits?typeaheadType=GEO&query=...`, no login, no cookie, an unofficial endpoint, so every failure is soft) turns a place name into a geoId. (1) The HTTP adapter `linkedin-geo` has the tool `linkedin_locations`: look places up, remember a name for a geoId (`save_as` + `id`), forget one, list them; its own platform and budget (60 per hour, 300 per day, one unit per lookup, saving costs none). (2) `linkedin_search` resolves its `geo` by itself in this order: a numeric geoId, an alias from `LINKEDIN_GEO_ALIASES`, a remembered name, then one lookup whose best hit is remembered (the result says what it chose and the other matches; a failed lookup is never remembered and the name goes into the address as it is). The lookup counts as one unit of the LinkedIn budget. (3) `jobwatch linkedin-geo` (alias `linked-geo`) does the lookups and the remembering from the host through the control socket (`linkedin-geo.lookup`, `.save`, `.forget`, `.list`, which run `linkedin_locations` through the normal guard, budget and call history). Remembered names live in `platform_memory` (migration 8; `ctx.memory`, a key-value memory shared by adapters, keys by convention prefixed by the adapter, values up to 400 characters, 1000 entries, the oldest dropped).
- **Market, country and job agnostic (decided 2026-10-03).** Generic code (the SDK, the engine, the generic adapters LinkedIn, WTTJ and the company-board ATS tools, the dashboard) assumes no market, language of the operator, job family or currency. What depends on them is a tool argument (search `keywords`, `geo`, `title_any`, `location_any`, `disallowed_terms`, `hint_terms`), a deployment variable (`DEFAULT_LOCATION`, `LINKEDIN_GEO_ALIASES`, `BROWSER_LANG`, `BROWSER_ACCEPT_LANGS`) or the browser's own locale (the dashboard formats dates, numbers and currencies with it). Market-specific adapters (Apec for France, an ATS for its own site) may be specific; their specifics stay inside their package. Text rules that cannot avoid natural language (salary words, years of experience, home working, section headings) cover several languages and are extended by adding words, not by naming a market. The check for a change: could someone searching for a different job in a different country use this unchanged?
- **Hints from the text** (`extractHints`, `salary.ts`): the hints are read from the description, so they are deliberately conservative. `salary_text` is a yearly amount that either has the shape of a salary (2 or 3 digits then `k` or a group of thousands, with a currency of any kind: `65k€`, `€65.000`, `$120,000`, `CHF 95k`) or sits on a line (or under one) that names a salary; the line must not be about meal vouchers, funding, valuation or revenue and the figure must not be a million, a daily or a monthly one. When a text has several candidates, one next to a salary word is preferred to one that only has the right shape, wherever it is ("salary is 78.000€ per year with 10k€ variable" beats "our clients pay 120k€"); among equals the first wins. The salary is also stored in four columns of `jobs` (`salary_min`, `salary_max`, `salary_currency`, `salary_variable`, migration 7), read when the job is stored; jobs stored before are filled once when the database is upgraded; a range with the currency in front (`€72.000 - €115.000`) and a variable part (`26.400€ + variable 12.500€`) are read. `years_hints` counts a number of years only when the same line speaks of experience. `remote_hints` puts the specific forms first (`2 remote day per week`, `3 days in the office per week`). Fixed on 2026-10-03 after real Teamtailor pages gave `500k€/day` and a 6 € meal voucher as salaries.
- **Shared job helpers** (`packages/sdk/src/jobtext.ts`, exported from `@jobwatch/sdk`): `termMatcher(terms)` is the whole-word, case-insensitive, never-a-regex matcher behind every `disallowed_terms` argument; `matchedTerms(text, terms)` lists which of the caller's `hint_terms` a text contains (`matched_terms`; there is no built-in technology list); `extractHints(text)` computes `years_hints`, `remote_hints` and `salary_text`. Adapters cannot import each other, so anything two job adapters need lives here.
- **Hosts** (`sdk/src/hosts.ts`, `core/src/http/`): `allowedHosts` entries are bare hostnames (exact) or one-label wildcards (`*.teamtailor.com` matches `bsport.teamtailor.com`, not `a.b.teamtailor.com` or the bare domain; `*.com` is invalid). An `http` adapter may also declare `openHttps: true` to reach any public https host (ATS boards on a company's own domain); the catalog then shows `open_https: true`. The HTTP client refuses everything that is not https, port 443, credential-free; for an open host it additionally refuses names that cannot be public (IP literals, single labels, `.local`, `.internal`, `.lan`, `.home.arpa`...), resolves the name and refuses it unless **every** address is public (loopback, private, link-local and the cloud metadata range, carrier-grade NAT, documentation, multicast and reserved ranges, IPv6 unique-local and link-local, and IPv4 hidden in IPv4-mapped, NAT64 and 6to4 forms), and repeats the check on every redirect hop. Each such request logs `open_https_request` with the host only. Browser adapters cannot be open.
- **HTTP body cap:** 8 MB per response by default (`http/client.ts`); the biggest public job boards (Pennylane's on Ashby) are 4 MB of JSON.
- **Source of a job (decided 2026-10-02: it must always be known).** Every row of `jobs` is keyed by `platform` = the adapter's platform, set by the engine from the adapter and never taken from the adapter's own data, so a job can never be filed under another source. `board` (schema version 4) records where within the platform it was found: the company handle at an ATS (`bsport` on Teamtailor, `algolia` on Greenhouse), `null` for LinkedIn and Apec. `ctx.jobs.get` returns both as `source` and `board`. The same job id on two platforms stays two rows.
- **Platforms with search cards** (`sdk/src/visit.ts`): LinkedIn, Apec and WTTJ list cards in a search and need one more read per job. `readNew(jobs, cards, plan)` and `readByIds(jobs, ids, plan)` are the shared strategy (skip ids; then a disallowed title, never stored; then the stored copy, judged from the database; then a visit up to `maxJobs` and a time budget, STORED at once and only then judged on its description; newly read jobs first, capped by `maxReturned`). The platform only supplies `plan.visit(id)`, how to read one job, and `plan.board`. Rules described for LinkedIn in `07-adapter-linkedin.md` apply to all of them.
- **History of searches** (`store.ts` migration 5, `recordSearch` in `JobStore`): the first time the router stores something a caller typed. Each search tool records, once per call, `{ query, found, returned }`: the search keywords (`keywords` for LinkedIn and Apec, the `title_any` words joined with ` | ` for an ATS, empty for WTTJ matches and a whole board), every job id the search listed, and the ids it handed back. Tables `search_runs` (time, platform, keywords up to 200 characters, true counts) and `search_hits` (run, job id, returned); at most 1000 ids per run, the returned ones first. Nothing else about the arguments is kept (no locations, no excluded terms, no credentials), the rows are deleted with the jobs after `JOB_RETENTION_DAYS`, and `call_log` still holds only a hash of the arguments. Read it with `stored_searches` and `stored_jobs`.
- **`stored_jobs`** (`core/src/ops/storedJobs.ts`, same `ops` adapter): the jobs stored in a date window (by `first_seen`, `last_seen` or `fetched_at`), with optional text (`detail`) and per-keyword statistics (`terms`, `stats`). It reads `Store.listJobs`, starts nothing and settles its cost to 0. Together with `stored_job_texts` it lets the routine build a weekly summary without calling any adapter.
- **`stored_job_texts`** (`core/src/ops/jobTexts.ts`, in the always-loaded `ops` adapter): the text of jobs earlier calls already read, any platform, from the database. It exists because a browser adapter's job tool leases the browser before it looks at the database, so even a fully stored batch would start Chrome; this one is an HTTP-kind tool on the `ops` platform, starts nothing and settles its cost to 0. `part` picks the full text, the summary, the outline, or one section (`splitSections` / `partsOf`).
- **Job summaries** (`sdk/src/summary.ts`): `summarizeJob(text)` is a rule-based shortener, not a model (a model has no place in a read-only, deterministic router on a RAM-limited host; the npm summarizers found were unmaintained since 2022, English-only and rank the company pitch first). It cuts the text at the headings it recognises (English, French, German, Spanish: role, requirements, nice to have, benefits, about, process, legal) and keeps the start of the role and requirements; with no headings it starts where the role seems to (`you will`, `we are looking for`, `as a Title,`...) and says `excerpt`. `splitSections` / `partsOf` return a part on its own; `describeJob` shapes the text fields of a returned job for `detail` `summary`, `full` or `none`. The stored description is never shortened.
- **Company-board adapters** (`sdk/src/boards.ts`): Teamtailor, Greenhouse, Lever, Ashby and the other ATS adapters share their filters and judging. An adapter resolves a handle or URL, fetches the board and returns `BoardPosting`s; `judgeBoardPostings` applies the rules (refresh `last_seen` of everything listed; date range, `title_any`, `location_any`; a disallowed TITLE is neither stored nor returned; the rest is stored at once with its full description; with `title_then_description` a disallowed DESCRIPTION is excluded but stays stored; `only_new`; `max_results` and the result size cap) and builds the common job shape (`source`, `board`, `read_from`, `new`, `first_seen`, `last_seen`, hints). A rule changed there changes for every ATS. The per-board report status is `ok | not_found | not_this_ats | invalid | refused | error`.
- **Job store** (`ctx.jobs`, SDK `JobStore`; implemented in `contexts.ts` over `Store`): the adapter's memory of postings whose page it read. `known(ids)`, `get(id)`, `put(job)`, `touch(ids)`; scoped to the adapter's platform by the engine, so an adapter cannot read another platform's rows. Table `jobs` (schema version 3): `platform, id, first_seen, fetched_at, last_seen, title, company, location, url, description`; title, company and location are capped at 300 characters, the description at 20 000, ids must match `[A-Za-z0-9_-]{1,64}`. A second `put` refreshes the text, `fetched_at` and `last_seen` and keeps `first_seen`; `touch(ids)` refreshes only `last_seen`, for jobs seen again without reading their page (a search card), so a posting that is still listed is never evicted. **Eviction:** rows whose `last_seen` is older than `JOB_RETENTION_DAYS` (default 30, 1 to 3650) are deleted at start-up and every six hours with the other pruning, and logged as `pruned {jobs}`. After eviction a posting counts as new again. The adapter decides what to store; the convention (07) is: every job whose page was read and whose title was accepted, whatever its description said, so that other terms can judge it later without another page read.
- **Pacing** (`browser/pacer.ts`): `ctx.pace()` waits a random 2.5 to 5 s since the previous call (an adapter may set `pacing`), counting time already spent. HTTP adapters default to none (the client paces per host).
- **Dashboard API** (`apps/mcp/src/dashboard/`, types in `packages/dashboard-api`): an Express app mounted under `/dashboard` that serves a sign-in page with a "Sign in with Google" button, the sign-in routes (`/dashboard/auth/login`, `/auth/callback`, `/auth/logout`), the built interface when installed, and the JSON API `/dashboard/api/v1/{me,overview,calls,calls/:id,jobs,jobs/:source/:id,searches,tools,usage}`. Every response is parsed by a strict schema of `packages/dashboard-api` before it is sent, so a database row or an extra field cannot leak; lists carry no job text and no call parameters, only the detail endpoints do. Sign-in is OpenID Connect (authorization code, PKCE S256, `state` in a cookie bound to the browser, `nonce`, ID token verified against the provider's keys, `email_verified` required); there is no email allowlist (the Google app decides). In local development the Origin of a change may be the dashboard's own loopback origin. Sessions live in memory (`jw_dash` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, path `/dashboard`, 8 hours at most). Changes (`PUT /dashboard/api/v1/adapters/:id` with `{enabled}`, which writes `adapters.json` and hot-reloads, putting the file back when the new list does not load, and `POST /dashboard/api/v1/router/restart`, refused while calls run unless `force`) go through `deps.writes` and need the header `X-JW-CSRF: 1`, the public `Origin` and a sign-in within `DASHBOARD_WRITE_WINDOW_S` (default 600); otherwise `401 reauth_required`. The Host must be the public host (`421` otherwise); with `AUTH=none` on loopback there is no sign-in and the caller is the local operator. Config: `DASHBOARD_PORT` (8090), `DASHBOARD_IDLE_S` (1800), `DASHBOARD_SESSION_MAX_S` (28800), `DASHBOARD_WRITE_WINDOW_S` (600), `DASHBOARD_OIDC_ISSUER` (Google), `DASHBOARD_OIDC_CLIENT_ID` and `DASHBOARD_OIDC_CLIENT_SECRET` (the secret is redacted from the config log). The listener is a `DashboardManager` (`manager.ts`): closed at startup, opened by `dashboard.start` on the control socket (optionally with a time to live in minutes), closed by `dashboard.stop`, by the idle timer (`DASHBOARD_IDLE_S`, each request pushes it back) or when the router stops, which also ends every session. It refuses to start where sign-in is required and no Google client is configured. `DASHBOARD_URL` is what the CLI prints (default `<BASE_URL origin>/dashboard/`) and `DASHBOARD_STATIC_DIR` the built interface (`apps/dashboard`, copied to `/app/dashboard` in the image).
- **Daily totals** (`store.ts` migration 6, `tool_usage_daily`, kept 400 days): every finished call adds its counts, errors, response bytes, estimated tokens, units spent, duration (sum and maximum) and job text available/returned to the row of its UTC day and tool. No parameters, keywords or ids: counts and durations only. `GET /dashboard/api/v1/usage?scope=session|lifetime|historical&from&to&tool&platform` reads them (`session` reads the calls in memory instead).
- **Hot reload and the control socket** (`registryHolder.ts`, `control.ts`, `apps/mcp/src/server.ts`): the registry is held in a `RegistryHolder`; `reload(ids)` builds and validates the new registry first and swaps it atomically, so a bad adapter leaves the old list in place and a call already running keeps the tool it looked up. The MCP server, the guard policy and the ops tools read the live registry. A browser adapter enabled while the router runs creates the browser runtime then (it is created lazily). `ADAPTERS` pins the list and refuses a reload. The router listens on a Unix socket `control.sock` in the data directory (mode 0600, no network port) for `ping` and `adapters.reload`; `jobwatch adapters enable|disable` sends `adapters.reload` after writing the file and says so, or asks for a restart when no router answers. The server is stateless, so Claude sees the new tool list only when its connector refreshes or reconnects. See `17-dashboard.md` section 6.4.
- **Dashboard call history:** `DASHBOARD_CALL_BUFFER` (100 to 20000, default 2000) calls are kept in memory (`CallLog`, `core/src/dashboard/callLog.ts`) with their validated parameters (capped at 16 KB each and 4 MiB in total, the oldest dropped first; memory only: not in the database, not in a log line, not in `memory_report`), the units reserved and spent, the bytes of the text sent to Claude and `estimatedTokens`, computed as characters divided by `TOKEN_CHARS_PER_TOKEN` (1 to 10, default 3.5). Nothing reads the buffer yet; `docs/plans/17-dashboard.md` builds on it.
- **Multi-tab:** `BROWSER_MAX_TABS` (integer, min 1, default 3, no upper limit) gives `config.maxTabs`, passed to `connectBrowser` through the context provider; 1 means a single tab. `BrowserSession` has `maxTabs` and `openTab()`; see `06-…` Multi-tab.
- **Container environment:** the router passes `CHROME_LANG` (`BROWSER_LANG`, default `fr-FR`) and `ACCEPT_LANGS` to the browser container. The language list is personal: it lives only in the untracked `deploy/.env`.
- **Images:** `images/browser/` (Dockerfile, entrypoint, seccomp profile) is promoted from the spikes; the router image bakes the seccomp profile at `/etc/jobwatch/chrome-seccomp.json` and defaults `BROWSER_SECCOMP` to it, because the docker CLI reads that file inside the router container. `playwright-core` 1.63.0 stays external to the bundle and is installed from `apps/mcp/external-deps.package.json`.
- **Tests:** unit tests use fakes (`npm test`, about 10 s). `npm run test:integration` (`tests/integration/run.sh`) builds the browser image and runs a router-like container on an internal network against a REAL browser container through the real `docker` CLI; it is not part of CI.

## Implemented in `packages/core`: built-in ops tools (Phase 1, step 7a)
- **The `ops` adapter** (`ops/ops.ts`) is built into the engine: `loadModules(enabled, installed, builtins)` always loads it, validates it by the same rules as any adapter, and reserves its id. So even on a fresh install with nothing enabled, `tools/list` shows `session_status` and `memory_report` (built-ins first). It has its own platform (`ops`), so an open breaker on LinkedIn never blocks it. `Registry.enabled` holds the selected adapters without the built-ins (metrics and `adapters list` use that).
- **`session_status(platform | "all")`**: for every enabled browser adapter with a `sessionCheck`, leases the browser, runs the check, and returns `{platform, logged_in, state: ok|needs_login|checkpoint|unknown, checked_at, cached, note}`. Rules: **a platform whose breaker says `checkpoint` is answered from the breaker without contacting the site** (a pending verification must not be provoked by another page load); only a healthy answer is cached (10 minutes), because after a lost session the user signs in again and expects the next check to see it; `ok` closes a `needs_login` breaker, `needs_login` and `checkpoint` open theirs; a rate limit, timeout, budget or connection failure is `unknown` with the reason, never a verdict on the session; unexpected errors give a generic note. Each real check spends one point of the platform's budget.
- **`memory_report`**: process memory and uptime, runtime state (platform, uptime, peak MB, queue length), per enabled platform the rate usage and any open breaker, and the last 20 calls (time, tool, outcome, duration). No arguments, hashes, container addresses or names, or paths.
- A test of the engine's own rules caught the first draft: the `platform` string had a pattern but no `max()`, so the startup check refused the built-in until it was bounded.

## Adapters and utilities: one module interface

The SDK declares `ModuleBase` (id, display name, description, `platform`, `allowedHosts`, `rate` / `keyRate`, `pacing`) and two kinds of module built on it, joined as `McpModule`:
- **Adapter** (`defineAdapter`, `role` omitted): fetches jobs from a platform, browser or HTTP, and stores what it reads.
- **Utility** (`defineUtility`, `role: 'utility'`): helper tools that fetch no jobs (a place lookup, finding a company's ATS). Always HTTP; never a browser, a login or `openHttps`.

The registry, the call path, the rate limiter and circuit breaker (keyed by `platform`, for both kinds), the catalog, `validateAdapter`, `tools/list` and the dashboard all work on `McpModule`; only the CLI and the enabled lists tell the two apart (`roleOf(module)`). A utility gets the same per-platform budget as an adapter: `rate` (or the HTTP default), and `keyRate` when a tool names `keys`. Tool names and platforms stay unique across both kinds. Packages: `packages/adapter-<platform>` and `packages/utility-<name>`, both depending on `@jobwatch/sdk` only (lint-enforced); `packages/adapters` is the installed map for both.

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
Tools are built with `defineHttpTool` (handler context: `{ http, jobs, log, pace }`) or `defineBrowserTool` (adds `session`). The compiler rejects a browser tool inside an HTTP adapter, `readOnlyHint: false`, a handler result that does not match the `output` schema, and any use of `ctx.session` in an HTTP tool (type tests in `packages/sdk/src/validate.test.ts`).

### Registration and enable / disable
1. **Installed**: `packages/mcp-modules/src/index.ts` is the one place that lists adapter and utility packages, in two maps:
   ```ts
   export const installedAdapters = {
     linkedin: () => import("@jobwatch/adapter-linkedin").then((m) => m.default),
     apec:     () => import("@jobwatch/adapter-apec").then((m) => m.default),
   } satisfies InstalledAdapterMap;
   export const installedUtilities = {
     "linkedin-geo": () => import("@jobwatch/utility-linkedin-geo").then((m) => m.default),
   } satisfies InstalledUtilityMap;
   ```
   `installedModules` is both merged (ids are unique across the two). The generators add a line between the `<adapters:begin>` / `<adapters:end>` or the `<utilities:begin>` / `<utilities:end>` markers, sorted. Both the server and the CLI import these maps, so they always agree. The types and functions are split the same way: `AdapterSummary` / `UtilitySummary` (and `ModuleSummary` for both) in the SDK, `InstalledAdapters` / `InstalledUtilities` / `InstalledModules` in core, `describeInstalledAdapters` / `describeInstalledUtilities` / `describeInstalledModules` in `mcp-modules`. An adapter in the utilities map, or the reverse, is reported as broken.
2. **Enabled**: which installed modules the router actually plugs in. Stored in `adapters.json` in the data directory (`/data/adapters.json` in the container): `{ "enabled": ["linkedin"], "utilities": ["linkedin-geo"] }`: `enabled` lists adapters, `utilities` lists utilities (a file without `utilities` is valid). Environment overrides: `ADAPTERS=linkedin,apec` and `UTILITIES=linkedin-geo` (each wins over its list in the file; the CLI refuses to edit a list while its variable is set). **Default on a fresh install: nothing enabled**, so only the built-in ops tools are exposed; the LinkedIn adapter must be enabled on purpose (its usage budget needs the owner's approval, `09-security.md`).
3. **Plugging**: `apps/mcp` calls `loadModules(enabledNames, installedModules)` from core. It imports only the enabled adapters, runs the startup checks below, and builds `tools/list` from them. An unknown name is a startup error. A disabled adapter contributes no tools, its runtime is never started, and its profile volume is untouched.
4. **Changing the set requires a router restart** (`docker compose restart router`); the connector may need to be refreshed in Claude to see the new tool list (VERIFY in Phase 2). Stateless HTTP cannot push `tools/list_changed`.

### CLI (`jobwatch`, package `apps/cli`)
```
jobwatch adapters list [--tools] [--json] [<id...>]
                                     all INSTALLED adapters: id, platform, kind, tools, allowed hosts, ENABLED / disabled;
                                     --tools adds every tool with its parameters (required starred, defaults, cost) = what
                                     tools/list returns; --json gives the full catalog entries; ids narrow the list
jobwatch adapters enable  <id...>    add to adapters.json (validates the id exists in `installed`), then hot-reload a running router
jobwatch adapters disable <id...>    remove from adapters.json, then hot-reload a running router
jobwatch linkedin-geo <text> [--save <name> [--pick <n>]] | --list | --forget <name>
                                     find the LinkedIn geoId of a place, remember names for places (needs the linkedin-geo utility)
jobwatch login start|stop <platform>  browser login mode (05); only for enabled browser adapters
jobwatch dashboard start [--ttl <minutes>] | stop | status
                                     open or close the operator dashboard on the running router (`17-dashboard.md`)
jobwatch doctor                      config, Docker socket, image, data dir, enabled adapters, SDK version compatibility
```
The CLI ships inside the router image too, so on the host: `docker compose exec router jobwatch adapters list`. Writing `adapters.json` is atomic (temp file + rename) and the file is the only state the CLI changes.

### Rules the SDK and registry enforce, so adapter authors cannot break the ground rules
- **One source of truth.** A tool's schemas, annotations, limits and handler live together. `tools/list` is built at startup from the enabled adapters (pure data, no container).
- **Startup checks** (per adapter, fail fast): `sdkApi` equals the running `SDK_API_VERSION`; `id` and tool names are unique; `readOnlyHint: true` on every tool; input schemas are `.strict()`; every string has `max()` and every array has `max()`; descriptions state read-only behaviour; every host in `allowedHosts` is a bare hostname.
- **Catalog snapshots.** Each adapter package has `catalog/*.json`, written by `npm run catalog:gen` (it runs every adapter's contract test with `UPDATE_CATALOG=1`, like `vitest -u`; the Nx cache is skipped on purpose) and committed. The snapshots are excluded from prettier: they are deterministic output reviewed as a diff. A contract test (sdk testkit) fails if the snapshot differs from the adapter's definitions, so every change to what Claude can see shows up in that adapter's diff. Snapshots exist for every installed adapter; only enabled ones are served.
- **Sandboxed surface.** Handlers get only `AdapterContext` (`session`, `http`, `log`, `pace`). `BrowserSession` and `HttpClient` enforce `allowedHosts`; no click, type or generic navigation is ever exposed; handler results are validated against the tool's `output` schema before `shapeOutput`.
- **Lifecycle is not the adapter's job.** Leasing, the single tab (`06`), timeouts, rate limiting, breaker, memory policy and error mapping stay in core. An adapter signals problems by throwing `SessionInvalid`, `Checkpoint` or `AdapterBroken`.
- **Honest limit:** adapters run in-process, so an adapter is trusted code. The SDK narrows what it is handed and lint forbids dangerous imports, but it is not a sandbox. Only adapters from this repository are installed; loading external packages by name is deliberately not supported (`EXTRA_ADAPTERS` rejected, 2026-10-01).
- **Entry points of `@jobwatch/sdk`:** `.` (the contract; imports nothing from Node), `./testkit` (fakes and the contract runner; tests only), `./catalog-fs` (read/write catalog snapshots; Node only, used by the CLI and the contract test).
- **Implemented checks (`validateAdapter`, a pure function the registry, `doctor` and the contract test all call):** `sdk-api`, `id`, `platform`, `hosts`, `tools`, `tool-name`, `tool-unique`, `read-only`, `description` (title 1-80, description 20-600 characters and the word "read-only"), `limits` (timeout 1-300 s, cost 1-100, output 1 KB-256 KB, memory `128 <= high < max <= 4096`), `schema` (must be expressible as JSON Schema), `schema-strict` (every object `additionalProperties: false`), `schema-bounded` (every string `maxLength` unless enum/const, every array `maxItems`, including strings hidden in unions and nullable values). Cross-adapter checks (duplicate tool names or ids across adapters) belong to the registry in core.
- **Host allowlist (`isUrlAllowed` / `assertUrlAllowed`):** https only, no credentials in the URL, default port only, hostname must EQUAL a listed host (no subdomain or suffix matching, no IP literals). Core's real `BrowserSession` and `HttpClient` must call it on every navigation and request, including redirects; the fakes already do.
- **Testable offline.** `@jobwatch/sdk/testkit` provides `FakeBrowserSession` (replays saved, **logged-out or synthetic** HTML from the adapter's `fixtures/`, never real logged-in pages), a fake `HttpClient`, and `runAdapterContract(adapter)` which checks the startup rules, the snapshot, and every tool's output against its schema.

Checklist for a new adapter: `npm run new:adapter -- <id>` (creates `packages/adapter-<id>`, adds the line and the dependency to `packages/mcp-modules`, runs `npm install`, formats the files and writes the first catalog snapshot); write tools, fixtures and tests; `npm run catalog:gen` after every change to a tool definition; add its pacing and budget to `07-…`/`08-…`; for a browser adapter, add its profile name to the login CLI; `jobwatch adapters enable <id>` on the host. A new utility is the same with `npm run new:utility -- <id>` (always HTTP; creates `packages/utility-<id>`, registered in the utilities map; `jobwatch utilities enable <id>`).

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
- Always include `source` (the platform: `linkedin`, `apec`, `teamtailor`...), `fetched_at` (UTC ISO), `warnings`. Jobs from an ATS that hosts many companies also carry `board` (the company handle at that ATS, `bsport`); where a tool says whether a text came from the page or from the router database, that field is `read_from`, never `source`.
- Mark text coming from web pages as **untrusted content** (field name `untrusted_text` or a wrapper) so the client can treat it as data, not instructions.

## Configuration (env + `config.yaml`)
```
BASE_URL=https://mcp.example.com          # public URL (resource identifier)
FRONT_SHARED_SECRET=...                    # header from the OAuth front (or mTLS)
BROWSER_RUNTIME=docker                             # docker | systemd-scope
BROWSER_IMAGE=localhost/jobwatch-browser:1
BROWSER_NETWORK=jobwatch-browsers          # internal Docker network of the browsers (compose.yml creates the network under this name)
BROWSER_SECCOMP=                           # absolute path of the Chrome seccomp profile in the router container; unset = Docker default
BROWSER_PROFILE_VOLUME_PREFIX=jw-profile-         # browser profiles are named Docker volumes jw-profile-<platform> (no host paths: works on Linux and macOS)
AUTH=front                                # front | none (none only for local development, loopback only; see compose.dev.yml)
DATA_DIR=/srv/jobwatch/data                # router SQLite, adapters.json (enabled adapters)
DB_PATH=                                   # optional: SQLite file; default <DATA_DIR>/jobwatch.sqlite
JOB_RETENTION_DAYS=30                      # days a stored job posting is kept after it was last seen (1-3650)
UTILITIES=                                 # optional comma list of utilities, e.g. linkedin-geo,ats-discovery; overrides the utilities list of adapters.json when set
ADAPTERS=                                  # optional comma list, e.g. linkedin,apec; overrides adapters.json when set; default: none enabled
BROWSER_IDLE_TTL_S=120  BROWSER_MAX_LIFETIME_S=1800  BROWSER_QUEUE_TIMEOUT_S=60
BROWSER_MEM_HIGH_MB=1200 BROWSER_MEM_MAX_MB=1500        # defaults, measured in S5 (see 06); per-tool budgets override
LOG_LEVEL=info
METRICS_ENABLED=false                      # true => Prometheus /metrics on METRICS_PORT
METRICS_PORT=9464
```

## Health and ops endpoints
- `GET /healthz` (unauthenticated, returns only `{"ok":true}`) for the Docker/compose healthcheck and Nginx upstream checks.
- Prometheus metrics, **optional, off by default**: when `METRICS_ENABLED=true` the router serves `GET /metrics` (Prometheus text format, `prom-client`) on a **separate listener** (`METRICS_PORT`, default 9464), never on the MCP port, so it cannot be reached through the OAuth front or Nginx. Metrics: `jw_tool_calls_total{tool,platform,result}`, `jw_tool_duration_seconds{tool}`, `jw_runtime_state{platform,state}`, `jw_runtime_cold_starts_total{platform}`, `jw_runtime_peak_rss_bytes{platform}`, `jw_rate_limit_tokens{platform}`, `jw_breaker_open{platform,reason}`, `jw_queue_wait_seconds`. Labels are low-cardinality only: no args, no URLs, no ids.
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
