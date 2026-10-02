# 01 — Decisions (ADR log)

> **Related docs:** Load when choosing, changing or questioning a decision. Also load: `02` (D7 OAuth front), `05` (D8 browser/runtime), `10` (D8-D10 deployment, stack), `03` (D9 layout), `15` (sources). Skip for pure implementation work. Follow a link only if the task needs it.

Status tags: **DECIDED** (agreed with the owner), **PROPOSED** (recommended, confirm in Phase 0), **OPEN** (needs a decision or a spike).

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

## D7 — OAuth front-end: babs/mcp-auth-proxy with Google as the identity provider — DECIDED (the owner, 2026-10-01)
Spike S2 compared the candidates on paper (READMEs, specs, configuration docs, repository metadata read on 2026-10-01; nothing was run yet, runtime behaviour is verified in S1). Criteria come from `02-claude-connector-requirements.md`.

| Criterion | (a) R0Wi/mcp-gateway | (b) babs/mcp-auth-proxy | (c) OAuth server in our router (MCP TS SDK) |
|---|---|---|---|
| Licence | **none** (open issue "Open license", no LICENSE file): no right to use or redistribute | Apache-2.0 | ours |
| Maturity | created 2026-08-23, 2 stars, no releases, 7 open issues | created 2026-04-02, 13 stars, releases v1.2.0 to v1.4.1 (latest 2026-09-17), threat model, e2e tests, SECURITY.md | SDK provides the building blocks, we write the rest |
| Language / footprint | Python (FastAPI + FastMCP + SQLite + Svelte UI) | Go static binary, Prometheus metrics built in | none extra (runs inside the router) |
| Extra services | none | **Redis** (required by default for replay protection) and an **OIDC IdP** | none |
| Claude requirements | DCR + CIMD, PKCE S256, RFC 9728/8414, 401 with `resource_metadata`, `https://claude.ai/api/mcp/auth_callback`, loopback port-agnostic | DCR, PKCE S256, RFC 9728/8414/8707, 401 with `resource_metadata`, explicit Claude notes in its specs (callback URL, root PRM with trailing slash) | SDK handlers for authorize/token/register/revoke/metadata and `requireBearerAuth` with `resourceMetadataUrl`; Claude quirks to be handled by us |
| Single user | local user list in YAML with bcrypt hash (simple) | **no email allowlist, only `ALLOWED_GROUPS`**: restrict at the IdP (an IdP where only the owner can sign in) | our own password check |
| Refresh tokens | rotating, **30 d default, configurable** | rotating with reuse detection, **7 d TTL (not configurable in the docs read)**; each use renews it | ours |
| Scopes / `offline_access` | advertised scopes | `scopes_supported` is empty (no scope model): Claude will not append `offline_access`, so refresh behaviour must be proven in S1 | ours |
| Tool names | **namespaced per backend** (`<backend>_<tool>`), would change tool names seen by the routine | transparent reverse proxy, names unchanged | unchanged |
| Open risk | licence, immaturity, aggregator semantics | needs Redis + IdP (RAM, more moving parts), 7-day refresh window | we own security-sensitive code (rotation, reuse detection, brute force) |

Decision: **(b)**. (a) is out unless the author adds a licence; its design is the best fit for one user, so re-check if that changes. (c) stays the fallback if (b) fails S1 (for example if refresh does not survive without `offline_access`), because it avoids extra containers on a RAM-constrained host but costs the most security work.
How (b) is deployed (`deploy/compose.yml`, set up in `10-deployment.md`; the public hostname is **`mcp.example.com`**): `front` = `ghcr.io/babs/mcp-auth-proxy` (pinned digest) with `PROXY_BASE_URL=https://mcp.<domain>`, `UPSTREAM_MCP_URL=http://router:8080/mcp`, `TOKEN_SIGNING_SECRET` from a file secret, `REDIS_URL`; a small `redis` service (a few MB) on `jobwatch-core`; `TRUSTED_PROXY_CIDRS` set to the Nginx address; metrics on its own port (`METRICS_ADDR`) for Prometheus. The router then trusts only the front on the private network (shared secret or network isolation, `09-…`).
**IdP choice (open question 3):** because (b) cannot restrict by email, pick an IdP where only the owner can authenticate: (1) **Google** with a Google Cloud OAuth app left in "Testing" mode with the owner as the only test user (no extra container; the app shows an "unverified app" screen, fine for one person), or (2) a tiny self-hosted IdP such as Dex with one static user or Pocket ID (one more small container). Keycloak is too heavy for this host. **Decided: Google in testing mode**, runtime-verified in S1; the one-account restriction is part of the acceptance checklist in `02-…`.
**Known consequence:** with a 7-day refresh TTL, a routine that does not run for more than 7 days needs a manual re-sign-in in Claude. Acceptable for a daily routine; note it in the runbook.

## D8 — Container runtime: rootless Docker; the router gets the rootless socket, never a root socket — DECIDED
The owner already uses Docker, so the stack uses **rootless Docker** under a dedicated `mcpuser` user. A root-level Docker socket is root-equivalent and a socket proxy only filters by API endpoint (not image); with rootless Docker a compromised router is an unprivileged user. Runtime access is behind a `RuntimeBackend` interface with implementations: `DockerCliBackend` (shell out to `docker run/stop/rm/inspect/stats`), later optional `SystemdScopeBackend` (Chrome under `systemd-run --user --scope -p MemoryMax=…`, no container, no network isolation). Podman could be added as another backend later; nothing in the design depends on it.
The always-on services (OAuth front + router) are declared in `docker compose`; browser containers are spawned by the router (not declared in compose).

## D9 — Implementation language/stack — PROPOSED
TypeScript (strict) on Node.js 26 (pinned via `engines` in `package.json` and `.nvmrc`), **npm** for deps (committed `package-lock.json`, `npm ci` in CI/deploy), ESM. `@modelcontextprotocol/sdk` (official TypeScript SDK, `McpServer` + `StreamableHTTPServerTransport` in **stateless** mode, i.e. `sessionIdGenerator: undefined`, one transport per request) on Express (or Hono), `zod` for schemas (catalog JSON is converted/validated with zod and exposed as JSON Schema), built-in `fetch` (undici) for plain fetch adapters, `playwright-core` used only via `chromium.connectOverCDP` and `page.evaluate` (keep the surface minimal so it can be swapped for Patchright or raw CDP), the built-in `node:sqlite` for the store (Node 26, no native addon), `pino` for logs, `vitest` for tests, `eslint` + `prettier`, `tsc --noEmit` for type checks, `tsx` for dev. VERIFY exact SDK options for stateless HTTP at implementation time.

**Update 2026-10-01 (Phase 1, step 5a):** the store uses Node's built-in `node:sqlite` (stable and warning-free on Node 26.10.0, bundled SQLite 3.53, WAL, transactions, named parameters, all probed) instead of `better-sqlite3`. It removes a native addon and its per-architecture prebuilt binary (amd64 and arm64), keeps the esbuild bundle and the Docker image free of anything to compile, and nothing else in the design depended on `better-sqlite3`.

## D10 — Public exposure: existing Nginx reverse proxy + one published port — DECIDED
The owner's network already sits behind an Nginx reverse proxy that terminates TLS for the owner's own domain. No tunnel (Cloudflare or other) is used. The compose stack publishes **exactly one host port**, owned by the OAuth front (default `127.0.0.1:18931`, configurable through `JW_BIND`/`JW_HOST_PORT`); Nginx proxies the public hostname to it. The router never publishes a port. Requirements: stable public HTTPS hostname, all of `/.well-known/*`, `/register`, `/authorize`, `/token`, `/mcp` proxied to the front, streaming-friendly proxy settings (no buffering, long read timeout), and Anthropic's egress range `160.79.104.0/21` must reach the discovery and OAuth endpoints (a WAF or allowlist in front of the authorization server can break discovery). Nginx settings and the compose wiring are in `10-deployment.md`.

## D11 — State kept by the router — PROPOSED
SQLite (WAL) in `data/`: rate-limit counters, circuit breaker state, `seen_ids` per platform (Phase 4), call log (tool, duration, peak RSS, cold start). No job data is stored beyond what `seen_ids` needs.

## D12 — Tool granularity: task-level tools, compact outputs — DECIDED
No generic browser tools. Outputs are structured (JSON) plus an optional compact Markdown view; descriptions truncated by default (`description_max_chars`). The client decides triage; the server does normalization (strip noise, dedupe, post-filter remote, flag promoted).

## D13 — Usage budget and pacing are enforced server-side — DECIDED
Per-platform token buckets, jittered delays, daily caps, circuit breaker on checkpoint. The client cannot bypass them.
