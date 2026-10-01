# 12 — Roadmap (phases, tasks, exit criteria)

> **Related docs:** Load for planning. Also load: `14` (VERIFY items per spike), then only the spec of the area being worked on (`02`, `05`, `06`, `10`, `11`, `13`). Follow a link only if the task needs it.

Work in order. Do not skip Phase 0: several design choices hinge on it. Keep a running log of results in `14-risks-and-open-questions.md` and `docs/measurements.md`.

## Phase 0 — Spikes (validate assumptions; no production code)
| # | Spike | Question answered | Output |
|---|---|---|---|
| S1 | **Done 2026-10-01 for chat** (echo MCP server behind Nginx + babs/mcp-auth-proxy + Google sign-in, added as a custom connector, calls work); **scheduled-routine / long-refresh test consciously deferred to Phase 5** (Matthieu). Original: Echo MCP server behind the Nginx reverse proxy + candidate OAuth front, added as a custom connector; call it from chat AND from a scheduled routine; let the access token expire | Do custom OAuth connectors work unattended from scheduled tasks? How are refreshes handled? | Yes/no + notes; if no → static-header plan B or another approach |
| S2 | Compare OAuth fronts (R0Wi/mcp-gateway, babs/mcp-auth-proxy) against the checklist in `02-…` | Which one, and how to allow only Matthieu | Decision D7 (**paper comparison done 2026-10-01: recommend babs/mcp-auth-proxy + Google testing-mode IdP; runtime proof in S1**) |
| S3 | Measure RAM/CPU/cold start of headful Chrome + Xvfb in a container on the real machine | Budgets, TTL, is one browser at ~1 GB OK? | `docs/measurements.md`, updated `06-…` |
| S4 | Fingerprint self-check + login persistence (manual login via noVNC, stop/start ×3) | Does the session survive restarts? Do automation signals show? | Go/no-go on G3/G4 choices (session restore, Patchright) |
| S5 | Capture LinkedIn search and **job details** DOMs while logged in (search split view with `currentJobId`, vs `/jobs/view/<id>`) | Which navigation/selectors | Updated `07-…` |
| S6 | Router-container → browser-container DevTools connectivity (IP vs DNS, `Host` header, `socat`, `--remote-allow-origins`) | G2 settled | Working snippet in `05-…` |
| S7 | Rootless Docker capabilities: `--memory`/`--memory-swap`/`--memory-reservation` enforced under cgroup v2 delegation, `--init`, seccomp/sandbox for Chrome, `docker stats` latency, user-socket mount into a container | Final `docker run` flags; sandbox decision | Updated `06-…`, `09-…` |
| S8 | Nginx server block for the chosen hostname + Anthropic range allowlist + `/.well-known` routing + streaming settings | D10 | Nginx snippet in `10-…` validated |
| S9 | Inspect WTTJ/APEC network calls for public JSON APIs; probe watch-list companies' careers pages for ATS providers | Which adapters can be plain HTTP | Updated `08-…`, `companies.yaml` draft |
**Exit**: all VERIFY items in `14-…` are resolved or consciously accepted; decisions D7, D8 closed (D10 decided: Nginx); measurements recorded.

## Phase 1 — Router core + LinkedIn adapter (local, no OAuth)
Workspace layout and rules: `03-router-spec.md` ("Repo layout: Nx monorepo"). Build order, one commit per step, repo green after each (decided 2026-10-01):
1. Nx workspace, tooling, module-boundary lint rules, first test.
2. `packages/sdk`: types, `defineAdapter`/`defineHttpTool`/`defineBrowserTool`, errors, host allowlist, `validateAdapter`, catalog builder, testkit. **Done** (84 tests).
3. `packages/core`: config and logging, enabled-adapters file, registry (`loadAdapters`, `listTools`), proven with fake adapters that `tools/list` works with no container; `packages/adapters` (installed map) and the adapter generator (`npm run new:adapter`). **Done** (core 60 tests, generator verified end to end by generating an http and a browser adapter, running the full CI on them, then removing them).
4. `apps/mcp`: stateless Streamable HTTP, `/healthz`, `/metrics` listener, auth guards, the `callTool` pipeline in core, tests with a real MCP client; `apps/cli` with `adapters list|enable|disable`; the router `Dockerfile` built and run for real. **Done** (mcp 31 tests, cli 26, core 90). The step 4 PR also turns the publish job on.
5. Split into two PRs. **5a: SQLite store (`node:sqlite`), rate limiter, circuit breaker, call log. Done** (core 155 tests, mcp 45). **5b: `RuntimeBackend` + `DockerCliBackend`, runtime manager (state machine, semaphore, preemption, reaper, watchdog), tested against a fake backend first.**
6. `core`: browser layer (CDP wrapper with exactly one tab and host allowlist, fingerprint self-check) and `images/browser/` (promoted from `spikes/`).
7. `packages/adapter-linkedin` (layout A first, then B), ops tools `session_status` and `memory_report`.
8. `apps/cli`: `login`, `catalog`, `doctor`; Docker integration tests.
9. Soak test.
**Exit**: from a local MCP client on the host, the LinkedIn tools return correct data within budgets; lifecycle invariants pass (cold/warm/reap/preempt/OOM); soak test 6 h green.

## Phase 2 — Public endpoint, OAuth, Claude integration
Tasks: choose/configure the OAuth front; compose stack; router Docker image (`Dockerfile`) + GitHub Actions publish to the private registry + Watchtower on the host (`10-…` "CI/CD"); Nginx server block + hostname; connector added in Claude; acceptance checklist `02-…`; per-tool annotations verified in Claude UI; routine smoke test (S1 follow-up) with a minimal routine calling `session_status` and one search; secrets/runbooks documented.
**Exit**: a scheduled routine successfully calls `session_status` and `linkedin_search` unattended on 3 consecutive days; second-account sign-in rejected.

## Phase 3 — More adapters
Tasks (in value order): `ats_jobs` + `companies.yaml` discovery; `apec_search` (HTTP) + `apec_job` (browser, full description); `wttj_matches`; (optional) `free_work_search`. Each with fixtures, contract tests, budgets.
**Exit**: each adapter passes its tests and a live smoke; global semaphore/preemption verified with mixed calls.

## Phase 4 — Hardening and state
Tasks: egress allowlist proxy/nftables for browser containers; seccomp/sandbox final; download blocking; metrics endpoint; `seen_filter`/`seen_mark` (if Matthieu wants server-side memory); alerting; dependency pinning/audit job; backup/restore docs for config (not profiles).
**Exit**: security checklist in `09-…` fully ticked; pen-test-style checks (try reaching LAN/metadata from a browser container; try calling non-catalog tools; try a second account).

## Phase 5 — Cutover of the job-watch routine
Tasks: update the routine docs per `13-…`; run old and new paths in parallel for 3 days and compare results (new offers found, errors, tokens used); switch; keep the Chrome-extension path as documented fallback; test the Indeed connector again.
**Exit**: 5 consecutive unattended daily runs meeting the global acceptance list in `11-…`.

## Backlog / ideas
Smart caching of job details (by id, 24 h) to cut page views; `keep_warm_s` hint; Playwright→raw CDP swap if detection signals matter; a web status page; email the routine's "needs login" alert directly from the router; add Indeed/other platforms as adapters.

## Definition of done (every task)
Code + tests + docs updated (the relevant numbered file) + measurements noted if RAM/time related + no secrets committed + `eslint`/`tsc`/tests green.
