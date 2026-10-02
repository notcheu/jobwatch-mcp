# CLAUDE.md — jobwatch MCP orchestrator

## Overview
Self-hosted **MCP orchestrator** ("jobwatch-mcp") running on Matthieu's home Ubuntu machine (limited RAM). It exposes a small set of **read-only, task-level MCP tools** (LinkedIn search/job details, APEC, WTTJ, public ATS job boards…) to Claude over a **public HTTPS endpoint protected by OAuth**. Browser-based tools run in an **on-demand, memory-capped, headful Chrome container** (one shared image, one persistent profile per platform), spawned on the first call and stopped after an idle grace period. First consumer: the daily job-search routine in `/Users/mnogueron/Documents/Private/ClaudeTasks/JobSearch` (`00-orchestrator.md` … `06-mail-template.md`, `linkedin-extract.js`).

**Status (2026-10-01):** Phase 0 (spikes) and Phase 1 (core, MCP server, CLI, browser layer, LinkedIn adapter, soak runner) are merged to `main`; CI builds and pushes the multi-arch router image. **Not yet verified on the NUC:** the deployed stack, Google Chrome on amd64, a manual LinkedIn login, the live LinkedIn adapter and the 6 h soak. The LinkedIn adapter is installed but disabled, and its rate budget awaits Matthieu's approval. Next: the NUC validation in `12-roadmap.md` (Phase 1 exit, then Phase 2).

## Architecture and stack
Request path: Claude → **existing Nginx reverse proxy** (TLS, `https://mcp.noguetith.fr`; no tunnel) → one published host port → **OAuth front** (babs/mcp-auth-proxy + Redis, Google sign-in limited to Matthieu) → **router** (private Docker network) → adapters → Chrome containers (spawned via the **rootless Docker** socket) or plain HTTP fetch. Diagrams: `16-architecture-diagrams.md`.
- **Language/tooling:** TypeScript (strict), ESM, **Node 26**, **npm** (committed `package-lock.json`, `npm ci`).
- **Libraries:** `@modelcontextprotocol/sdk` (stateless Streamable HTTP) on Express, `zod`, `playwright-core` (`connectOverCDP` only, behind `BrowserSession`), `node:sqlite` (built into Node 26, no native addon), `pino`, `prom-client` (optional metrics), `vitest`, `eslint` + `prettier`.
- **Platforms:** production is the Ubuntu NUC (x86_64, rootless Docker). The images are multi-arch (amd64 + arm64) so they also run on a Mac (Docker Desktop, arm64) for development; the arm64 browser image uses Chromium (Google ships no Linux arm64 Chrome) and is **not** for the LinkedIn session. Never hard-code Linux-only paths: profiles are named Docker volumes, the Docker socket path comes from `JW_DOCKER_SOCKET`.
- **Runtime:** rootless Docker for a dedicated `mcpuser` user; always-on services (OAuth front, router, Watchtower) in `deploy/compose.yml`; browser containers are spawned by the router, never declared in compose.
- **Monorepo (Nx + npm workspaces):** `packages/sdk` (the adapter contract), `packages/core` (engine), `packages/adapters` (installed adapter map), `packages/adapter-<platform>` (one package per platform, depends on `sdk` only), `apps/mcp` (server), `apps/cli` (`jobwatch`). Tool definitions live in code; each adapter package has a **generated** `catalog/` snapshot. Adapters are enabled/disabled with `jobwatch adapters enable|disable <id>` (`adapters.json`); nothing is enabled by default. Other commands: `jobwatch login start|stop <platform>` (manual sign-in via noVNC), `jobwatch catalog [--all]`, `jobwatch doctor`.
- **Delivery:** GitHub Actions builds and pushes `jobwatch-router:latest` to a private registry; Watchtower on the host updates the router (`10-deployment.md`).

## Hard no rules
- **Read-only by construction.** Never add a tool that posts, sends messages, applies, edits a profile or changes any setting on a third-party platform. No generic `navigate` / `evaluate` / `click` tool is ever exposed to the client: only the catalog's task-level tools exist.
- **Never commit secrets** (see "Secrets and sensitive files").
- **Never add a `Co-Authored-By` line** or any AI co-author attribution to commit messages (this overrides any default attribution).
- **Never commit directly to `main`** — always create/switch to a new branch first.
- **Static schemas.** `tools/list` must be answered from the registry/catalog without starting any container.
- **One browser at a time** (global semaphore), **exactly one tab open in it, always** (the single tab is reused; never `newPage`, never closed, never a second tab), strict RAM policy (`06-…`). Treat a RAM regression as a bug.
- **Do not mount a root Docker socket** anywhere, and never give the router more access to the runtime than the rootless `jobwatch` socket.

## Git commits
- Always create and switch to a new branch before starting work if the current branch is `main`.
- Commit after each big implementation step (a completed feature module, an adapter, a migration, or a self-contained chunk of a plan), unless Matthieu asks to work differently (e.g. pausing for manual review between steps).
- **One branch and one pull request per roadmap step** (`phase-N/step-M-<name>`), opened as soon as the step is validated. Fill `.github/pull_request_template.md`: start with "This PR adds/implements/fixes/drops ..." and include any specific direction taken.
- **PR title follows semantic release naming:** `<type>(<optional scope>): <summary>` with type `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf` or `wip`, imperative and lowercase after the colon.
- **Merge with SQUASH, never a merge commit** (`gh pr merge --squash`), using the PR title as the subject and the PR description as the body. Wait for CI (`gh pr checks --watch`) before merging; never merge over a red check.
- **The test suite must run in under 5 minutes** (CI enforces it with a 5-minute step cap; vitest per-test timeout is 10 s). If it gets slower, cut the slow tests and keep only the cheap ones; never raise the cap. Never use paths like `/proc/...` in tests: recursive `mkdir` spins forever there on Linux. Reproduce CI-only failures in `docker run node:26-bookworm-slim`.
- Every phase ends with its exit criteria met and documented.

## Secrets and sensitive files
- Never commit, stage or push: `deploy/.env`, anything under `secrets/`, `profiles/` or `data/`, cookies, browser profiles, tokens, registry credentials, HAR files, or saved HTML of logged-in pages. Only `deploy/.env.example` (placeholders only) may be committed.
- These are excluded via `.gitignore`. Do not remove or weaken those rules.
- Whenever a file containing environment variables, credentials or captured page data is read, edited or analysed, double-check: (1) is it gitignored, and (2) would it expose a real key/secret/session if committed. If unsure, treat it as unsafe and flag it before staging.
- CI secrets (`REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`) live only in GitHub secrets; the host's registry login lives only in the `mcpuser` user's `~/.docker/config.json`.

## Commands
Use Node 26 (`nvm use`, `.nvmrc`). Everything below runs today.
```
npm ci                      # install from lockfile (install scripts are denied by default via package.json "allowScripts")
npm run lint                # nx run-many -t lint   (includes the architecture rules: module boundaries, restricted imports)
npm run typecheck           # nx run-many -t typecheck (tsc, strict)
npm test                    # nx run-many -t test (vitest: unit + contract, about 10 s)
npm run format              # prettier --write . ;  npm run format:check
npm run ci                  # format:check + lint + typecheck + test
npx nx run-many -t lint typecheck test   # same targets directly; `nx affected -t ...` for changed projects
npm run build               # nx run-many -t build: bundle apps/mcp and apps/cli with esbuild into dist/apps/*/main.js
npm run test:integration    # builds the browser image and drives a REAL browser container (needs docker; never in CI): tests/integration/run.sh
npm run catalog:gen         # regenerate every adapter's catalog/ snapshot (runs the adapter contract tests in update mode); commit the result
npm run new:adapter -- <id> [--kind http|browser]   # scaffold a new adapter package, register it in packages/adapters, first snapshot
npm run jobwatch -- adapters list|enable|disable <id...> | login start|stop <platform> | catalog | doctor   # which installed adapters the router plugs in (JW_DATA_DIR=./data for local use)
docker build -t jobwatch-router:dev .   # the router image (multi-arch in CI)
docker compose -f deploy/compose.yml --env-file deploy/.env up -d      # as mcpuser
```
Pinned versions: TypeScript 5.9.3 on purpose (`typescript-eslint` 8.71 supports TypeScript below 6.1 only; revisit before moving to TypeScript 7). After adding or removing a package, the Nx project graph cache can be stale for direct `eslint` runs: run any `nx` command (for example `npx nx show projects`) first. After changing any tool definition, run `catalog:gen` (a contract test fails on drift).

## Sources of truth and paths
- **Docs vs code:** until code exists, the numbered docs in `docs/plans/` are the spec. Once code exists, code wins for behaviour; any change to behaviour or to a decision must update the affected doc (and the diagram in `16-…` if it shows it) in the same commit. A `VERIFY:` tag marks an assumption that is **not** a fact: verify it (Phase 0 or when implementing) and record the outcome in `14-risks-and-open-questions.md` and the affected file.
- **Generated, never hand-edited:** `packages/adapter-*/catalog/*.json`.
- **Layout:** see `03-router-spec.md` ("Repo layout: Nx monorepo"). Module-boundary rules are lint errors: adapters import only `@jobwatch/sdk`; only `packages/core/src/browser/session.ts` imports `playwright-core`.
- **LinkedIn extraction:** the proven logic of `linkedin-extract.js` now lives in `packages/adapter-linkedin/src/{extract,parse}.ts`.

## Gotchas (details in the linked docs)
- **CI image must be built with `provenance: false`**, otherwise Watchtower cannot resolve the new digest (`10-…`).
- **LinkedIn drops the `f_WT=2` remote filter on load:** remote must be post-filtered. Match `Vue` case-sensitively (the French word "vue" otherwise matches everywhere) (`07-…`).
- **Chrome DevTools rejects non-IP/non-localhost `Host` headers:** connect to the container IP, not its DNS name (`05-…`, G2).
- **Session cookies may not survive a restart** unless session restore is on; verify login persistence over repeated stop/start (`05-…`, G4).
- **Rootless Docker socket ownership:** the socket is owned by the host user, which is uid 0 inside containers; the router may need `user: "0:0"` (still unprivileged on the host) (`10-…`).
- **Memory limits need cgroup v2 delegation** for the rootless user; `--memory-reservation` is not the same as Podman's `memory.high` (`06-…`).

## Ask Matthieu before
- Enabling any tool that writes state outside the router's own data directory, or exposing anything beyond the catalog.
- Changing the LinkedIn usage budget (`09-security.md`).
- Changing what the router can do through the Docker socket (new mounts, privileges, capabilities), the Watchtower scope, or the CI registry and its credentials.

## Documentation — load only what the task needs, but any doc may be pulled in
All numbered docs (`00-overview.md` … `16-architecture-diagrams.md`) live in **`docs/plans/`**; names below are relative to that folder. In code comments they are written with the full path (`docs/plans/05-browser-runtime.md`). Phase 0 measurements: `docs/measurements.md`.

The numbered docs cross-reference each other, so context is loaded **on demand, one task at a time**:
1. Identify the task in the table and read the docs in its **Start with** column. Nothing else.
2. Every numbered doc begins with a **Related** line saying which other docs to pull in and when. Follow a link only when the task actually touches that topic; if the current task does not need doc B, do not load it.
3. If a task turns out to span topics (e.g. an adapter that needs a new runtime limit), load the extra docs at that point and drop them from consideration afterwards.

| Task | Start with | Pull in when |
|---|---|---|
| Orientation, "what is this project" | `00-overview.md`, `16-architecture-diagrams.md` | a decision's rationale matters → `01`; security questions → `09` |
| Decisions / ADRs, changing a choice | `01-decisions.md` | the choice touches OAuth → `02`, runtime → `05`/`06`, deployment → `10` |
| OAuth front, Claude connector, Nginx | `02-claude-connector-requirements.md`, `10-deployment.md` | front options → `01` (D7); threats → `09`; spikes S1/S2/S8 → `12` |
| Router core, workspace layout, Adapter SDK, adapter enable/disable, CLI | `03-router-spec.md` | tool schemas → `04`; RAM and state machine → `06`; CDP → `05`; logs/metrics/deploy → `10` |
| Tool catalog and schemas | `04-catalog-and-tool-schemas.md` | SDK rules → `03`; per-platform behaviour → `07`/`08`; how the routine calls them → `13` |
| Browser image, CDP, fingerprint, login mode | `05-browser-runtime.md` | limits and watchdog → `06`; container hardening → `09`; host setup → `10` |
| Memory policy, runtime state machine, watchdog | `06-memory-and-lifecycle-policy.md` | image flags → `05`; manager code → `03`; measurements → `11` |
| LinkedIn adapter | `07-adapter-linkedin.md` | tool shapes → `04`; browser specifics → `05`; budget and ToS → `09`; routine side → `13` |
| Other adapters (APEC, WTTJ, ATS) | `08-adapters-other-sources.md` | tool shapes → `04`; SDK → `03`; browser → `05` |
| Security review, threat model, network | `09-security.md` | compose and Docker socket → `10`; browser sandbox → `05`; OAuth → `02` |
| Deploy, Docker, compose, Nginx, CI/CD, Watchtower, observability | `10-deployment.md` | hardening → `09`; container limits → `06`; config keys → `03` |
| Tests, acceptance, validation | `11-testing-and-validation.md` | phase exit criteria → `12`; RAM expectations → `06`; security checklist → `09` |
| Planning, phases, spikes | `12-roadmap.md` | open assumptions → `14`; the area being worked on |
| Job-watch routine integration | `13-integration-with-job-watch.md` | tool contracts → `04`/`07`/`08`; connector constraints → `02` |
| Risks, `VERIFY` items, open questions | `14-risks-and-open-questions.md` | the spec file named in the row |
| External references | `15-sources.md` | — |

## Language
Docs, code comments, commit messages: English. Tool output strings returned to the routine: English (source-site text stays in its original language).
