# CLAUDE.md — jobwatch MCP orchestrator

## Overview
Self-hosted **MCP orchestrator** ("jobwatch-mcp") running on Matthieu's home Ubuntu machine (limited RAM). It exposes a small set of **read-only, task-level MCP tools** (LinkedIn search/job details, APEC, WTTJ, public ATS job boards…) to Claude over a **public HTTPS endpoint protected by OAuth**. Browser-based tools run in an **on-demand, memory-capped, headful Chrome container** (one shared image, one persistent profile per platform), spawned on the first call and stopped after an idle grace period. First consumer: the daily job-search routine in `/Users/mnogueron/Documents/Private/ClaudeTasks/JobSearch` (`00-orchestrator.md` … `06-mail-template.md`, `linkedin-extract.js`).

**Status:** design is complete, no code yet. Next step is Phase 0 (spikes) in `12-roadmap.md`.

## Architecture and stack
Request path: Claude → **existing Nginx reverse proxy** (TLS, `https://mcp.noguetith.fr`; no tunnel) → one published host port → **OAuth front** (babs/mcp-auth-proxy + Redis, Google sign-in limited to Matthieu) → **router** (private Docker network) → adapters → Chrome containers (spawned via the **rootless Docker** socket) or plain HTTP fetch. Diagrams: `16-architecture-diagrams.md`.
- **Language/tooling:** TypeScript (strict), ESM, **Node 26**, **npm** (committed `package-lock.json`, `npm ci`).
- **Libraries:** `@modelcontextprotocol/sdk` (stateless Streamable HTTP) on Express, `zod`, `playwright-core` (`connectOverCDP` only, behind `BrowserSession`), `better-sqlite3`, `pino`, `prom-client` (optional metrics), `vitest`, `eslint` + `prettier`.
- **Platforms:** production is the Ubuntu NUC (x86_64, rootless Docker). The images are multi-arch (amd64 + arm64) so they also run on a Mac (Docker Desktop, arm64) for development; the arm64 browser image uses Chromium (Google ships no Linux arm64 Chrome) and is **not** for the LinkedIn session. Never hard-code Linux-only paths: profiles are named Docker volumes, the Docker socket path comes from `JW_DOCKER_SOCKET`.
- **Runtime:** rootless Docker for a dedicated `mcpuser` user; always-on services (OAuth front, router, Watchtower) in `deploy/compose.yml`; browser containers are spawned by the router, never declared in compose.
- **Monorepo (Nx + npm workspaces):** `packages/sdk` (the adapter contract), `packages/core` (engine), `packages/adapters` (installed adapter map), `packages/adapter-<platform>` (one package per platform, depends on `sdk` only), `apps/mcp` (server), `apps/cli` (`jobwatch`). Tool definitions live in code; each adapter package has a **generated** `catalog/` snapshot. Adapters are enabled/disabled with `jobwatch adapters enable|disable <id>` (`adapters.json`); nothing is enabled by default.
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
- Every phase ends with its exit criteria met and documented.

## Secrets and sensitive files
- Never commit, stage or push: `deploy/.env`, anything under `secrets/`, `profiles/` or `data/`, cookies, browser profiles, tokens, registry credentials, HAR files, or saved HTML of logged-in pages. Only `deploy/.env.example` (placeholders only) may be committed.
- These are excluded via `.gitignore`. Do not remove or weaken those rules.
- Whenever a file containing environment variables, credentials or captured page data is read, edited or analysed, double-check: (1) is it gitignored, and (2) would it expose a real key/secret/session if committed. If unsure, treat it as unsafe and flag it before staging.
- CI secrets (`REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`) live only in GitHub secrets; the host's registry login lives only in the `mcpuser` user's `~/.docker/config.json`.

## Commands
Scripts are planned and do not exist until `package.json` is created in Phase 1; keep this list in sync when they do.
```
npm ci                      # install from lockfile
npm run build               # tsc + copy non-TS assets (adapters/**/extract.js)
npm run lint                # eslint + prettier check
npm run typecheck           # tsc --noEmit (strict)
npm test                    # vitest: unit + contract
npm run test:integration    # needs the browser runtime (rootless Docker)
npm run catalog:gen         # regenerate every adapter's catalog/ snapshot (jobwatch catalog gen); commit the result
npx nx g @jobwatch/tools:adapter <id>   # scaffold a new adapter package
npx jobwatch adapters list|enable|disable ...   # which installed adapters the router plugs in
docker build -t jobwatch-router:dev .
docker compose -f deploy/compose.yml --env-file deploy/.env up -d      # as mcpuser
```
Node version is pinned in `.nvmrc` and `engines`. After changing any tool definition, run `catalog:gen` (a contract test fails on drift).

## Sources of truth and paths
- **Docs vs code:** until code exists, the numbered docs are the spec. Once code exists, code wins for behaviour; any change to behaviour or to a decision must update the affected doc (and the diagram in `16-…` if it shows it) in the same commit. A `VERIFY:` tag marks an assumption that is **not** a fact: verify it (Phase 0 or when implementing) and record the outcome in `14-risks-and-open-questions.md` and the affected file.
- **Generated, never hand-edited:** `packages/adapter-*/catalog/*.json`.
- **Layout:** see `03-router-spec.md` ("Repo layout: Nx monorepo"). Module-boundary rules are lint errors: adapters import only `@jobwatch/sdk`; only `packages/core/src/browser/session.ts` imports `playwright-core`.
- **Seed code:** copy the proven `linkedin-extract.js` from the routine folder into `packages/adapter-linkedin/src/extract.js` as the starting point for the LinkedIn adapter.

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
