# 01 — Decisions (ADR log)

> **Related docs:** Load when choosing, changing or questioning a decision. Also load: `02` (D7 OAuth front), `05` (D8 browser/runtime), `10` (D8-D10 deployment, stack), `03` (D9 layout), `15` (sources). Skip for pure implementation work. Follow a link only if the task needs it.

Status tags: **DECIDED** (agreed with Matthieu), **PROPOSED** (recommended, confirm in Phase 0), **OPEN** (needs a decision or a spike).

## D1 — Write our own router rather than deploy a general MCP gateway — DECIDED
Off-the-shelf gateways checked (see `15-sources.md`): R0Wi/mcp-gateway (OAuth 2.1 + DCR + aggregation, but does not spawn servers, no tool filtering), Docker MCP Gateway (spawns containers on demand, tool filtering, but no documented remote-client auth and uncertain stop policy), MetaMCP (pre-allocates idle sessions, 2–4 GB RAM), IBM ContextForge (Postgres/Redis, no documented on-demand spawn). None gives aggregation + Claude-compatible OAuth + scale-to-zero. Our surface is small (a handful of tailored tools) so a thin router is less work than bending a gateway.
Consequence: we own spawn/reap, catalog, rate limiting; we may still put an existing **OAuth front** in front (D7).

## D2 — Static tool schemas; spawn only on `tools/call` — DECIDED
Catalog JSON files define name, description, input schema, annotations (`readOnlyHint: true`), timeouts, memory budget, adapter id. `tools/list` is answered from memory. Contract tests keep adapters and schemas in sync.

## D3 — Adapters live in the router, not in the browser image — PROPOSED
The browser container is a **stock browser** (Chrome + virtual display + profile). The router connects over the DevTools protocol (internal network only) and runs the adapter's JS in the page. Benefits: one image to maintain, adapters versioned with the router, no code in the image to rebuild per platform.
Alternative kept open: adapter runner inside the image (only if the DevTools endpoint cannot be reached from outside the container reliably — see `05-browser-runtime.md` gotcha G2).

## D4 — One shared browser image for all platforms — DECIDED
Different platforms = same image, different profile volume and environment. Disk cost is paid once (a Chrome image is large, ~1 GB order of magnitude; VERIFY by measuring). RAM, not disk, is the scarce resource, handled by on-demand spawn.

## D5 — Headful Chrome (Google Chrome stable) under a virtual display, not headless-shell, not Lightpanda — PROPOSED
Reasons: closest to a normal browser (fewer automation signals), can be used for manual login through a viewer, same profile for login and daily runs. Lightpanda (beta, incomplete Web APIs, no rendering) is unsuitable for LinkedIn; `chromedp/headless-shell` cannot show a window for manual login. Chrome `.deb` inside a Debian/Ubuntu-based image (Ubuntu's apt `chromium` is a snap: do not use it).
Fallback: Chromium from Debian/Playwright build if Chrome stable is unavailable for the host architecture (VERIFY `uname -m`).

## D6 — One persistent profile volume per platform — DECIDED
`profiles/linkedin`, `profiles/apec`, `profiles/wttj`… mounted only into that platform's runtime. LinkedIn cookies are never visible to other adapters.

## D7 — OAuth front-end: pick in Phase 0 between (a) R0Wi/mcp-gateway and (b) babs/mcp-auth-proxy — OPEN
- (a) R0Wi/mcp-gateway: OAuth 2.1 authorization server facing clients with DCR (Claude connects without pre-shared credentials), single YAML + encrypted SQLite, runs in compose; proxies to our router as its only backend. Unknowns: how to restrict login to one user; maturity (small project).
- (b) babs/mcp-auth-proxy: OAuth 2.1 + OIDC bridge with DCR, stateless, needs an OIDC IdP (Google/Keycloak…) and Redis, reverse-proxies to one upstream.
- (c) Fallback: implement the resource-server side in the router and use a hosted/self-hosted IdP with DCR (more work).
Evaluation criteria are in `02-claude-connector-requirements.md` (checklist) and Phase 0 spike S2.

## D8 — Container runtime: rootless Docker; the router gets the rootless socket, never a root socket — DECIDED
Matthieu already uses Docker, so the stack uses **rootless Docker** under a dedicated `jobwatch` user. A root-level Docker socket is root-equivalent and a socket proxy only filters by API endpoint (not image); with rootless Docker a compromised router is an unprivileged user. Runtime access is behind a `RuntimeBackend` interface with implementations: `DockerCliBackend` (shell out to `docker run/stop/rm/inspect/stats`), later optional `SystemdScopeBackend` (Chrome under `systemd-run --user --scope -p MemoryMax=…`, no container, no network isolation). Podman could be added as another backend later; nothing in the design depends on it.
The always-on services (OAuth front + router) are declared in `docker compose`; browser containers are spawned by the router (not declared in compose).

## D9 — Implementation language/stack — PROPOSED
TypeScript (strict) on Node.js 26 (pinned via `engines` in `package.json` and `.nvmrc`; VERIFY that `better-sqlite3` ships or builds a binary for Node 26 and that Node 26 is LTS-eligible by deploy time), **npm** for deps (committed `package-lock.json`, `npm ci` in CI/deploy), ESM. `@modelcontextprotocol/sdk` (official TypeScript SDK, `McpServer` + `StreamableHTTPServerTransport` in **stateless** mode, i.e. `sessionIdGenerator: undefined`, one transport per request) on Express (or Hono), `zod` for schemas (catalog JSON is converted/validated with zod and exposed as JSON Schema), built-in `fetch` (undici) for plain fetch adapters, `playwright-core` used only via `chromium.connectOverCDP` and `page.evaluate` (keep the surface minimal so it can be swapped for Patchright or raw CDP), `better-sqlite3` for the store, `pino` for logs, `vitest` for tests, `eslint` + `prettier`, `tsc --noEmit` for type checks, `tsx` for dev. VERIFY exact SDK options for stateless HTTP at implementation time.

## D10 — Public exposure: existing Nginx reverse proxy + one published port — DECIDED
Matthieu's network already sits behind an Nginx reverse proxy that terminates TLS for his own domain. No tunnel (Cloudflare or other) is used. The compose stack publishes **exactly one host port**, owned by the OAuth front (default `127.0.0.1:8080`, configurable through `JW_BIND`/`JW_PORT`); Nginx proxies the public hostname to it. The router never publishes a port. Requirements: stable public HTTPS hostname, all of `/.well-known/*`, `/register`, `/authorize`, `/token`, `/mcp` proxied to the front, streaming-friendly proxy settings (no buffering, long read timeout), and Anthropic's egress range `160.79.104.0/21` must reach the discovery and OAuth endpoints (a WAF or allowlist in front of the authorization server can break discovery). Nginx settings and the compose wiring are in `10-deployment.md`.

## D11 — State kept by the router — PROPOSED
SQLite (WAL) in `data/`: rate-limit counters, circuit breaker state, `seen_ids` per platform (Phase 4), call log (tool, duration, peak RSS, cold start). No job data is stored beyond what `seen_ids` needs.

## D12 — Tool granularity: task-level tools, compact outputs — DECIDED
No generic browser tools. Outputs are structured (JSON) plus an optional compact Markdown view; descriptions truncated by default (`description_max_chars`). The client decides triage; the server does normalization (strip noise, dedupe, post-filter remote, flag promoted).

## D13 — Usage budget and pacing are enforced server-side — DECIDED
Per-platform token buckets, jittered delays, daily caps, circuit breaker on checkpoint. The client cannot bypass them.
