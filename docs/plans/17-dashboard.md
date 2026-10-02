# 17 — Dashboard (plan)

> **Related docs:** Load to build or review the operator dashboard. Also load: `03` (config, ops tools, store), `04` (tool outputs), `06` (memory benchmark, which the dashboard must not move), `09` (threat model), `10` (compose, ports), `12` (roadmap). Follow a link only if the task needs it.

**Status: plan, nothing built (2026-10-03). The owner answered the open questions the same day; their answers are folded in below and listed in section 12.** Decisions are tagged **DECIDED** (agreed with the owner) or **PROPOSED** (recommended, confirm before the step that needs it).

## 1. Purpose and scope

The router answers Claude. Nobody can see, without asking Claude, what it did, what it stored or where each budget stands. The dashboard is a **web UI for the operator** that shows:

1. **Run history**: every tool call since the router started (kept in memory), with outcome, duration, cost in rate-limit units, the size of what was returned to Claude and, in a detail view, the **full parameters of the call**.
2. **Stored jobs**: the jobs in the database, searchable, with a detail view on the right.
3. **Searches**: the history of search keywords and what each brought in (`stored_searches`, `docs/plans/03` "History of searches").
4. **Tool state**: per adapter and tool, the current rate usage (platform and company boards), breaker state, session state, and **enable / disable**.
5. **Analytics** on tool usage, with the **estimated tokens returned to Claude**.

Not in scope: anything that touches a third-party site (the dashboard never calls an adapter, never starts a browser, never spends a platform budget); a multi-user product; public exposure; Claude-side token accounting (the router cannot see Claude's own usage, only what it sends).

### Decisions

| # | Decision | Status |
|---|---|---|
| D1 | **On demand, not always running** (owner, 2026-10-03). The dashboard listener is off by default and started by `jobwatch dashboard start`; it stops after an idle timeout or `jobwatch dashboard stop`. | DECIDED |
| D2 | Stack: **React + shadcn/ui + TanStack Table**, built with Vite; TanStack Query for data; shadcn charts (Recharts) for graphs. The two new workspaces `apps/dashboard` and `packages/dashboard-api` and the front-end dependencies are accepted (owner, 2026-10-03). | DECIDED |
| D3 | Layout: a **sidebar** to switch sections (analytics, runs, stored jobs, searches, tools and status) and **tabs** to switch between tools within a section. Stored jobs in a TanStack Table, a **detail panel on the right** on row click. | DECIDED |
| D4 | The calls are **kept in memory** (a ring buffer in the router process). Each call keeps its **full parameters as a JSON object**, in memory only (D9). | DECIDED |
| D5 | The server part runs **inside the router process** (it owns the memory buffer, the limiter and the registry), on its own listener, never on the MCP port. | PROPOSED |
| D6 | Token counts are **estimates** computed from the size of the text sent to Claude, starting at 3.5 characters per token; the ratio is calibrated later against Claude's own usage data (owner, 2026-10-03). | DECIDED |
| D7 | **Hot reload** of adapters (owner, 2026-10-03): enabling or disabling an adapter from the dashboard (or the CLI) takes effect in the running router without a restart (section 6.4). A "Restart router" button also exists (owner, 2026-10-03). | DECIDED |
| D8 | The daily usage aggregates are **persisted**, so Lifetime and Historical survive a restart; the per-call history stays in memory (owner, 2026-10-03). | DECIDED |
| D9 | The parameters of each call are kept **in memory only** as a JSON object, never written to the database, never logged, bounded in size, cleared on restart (owner, 2026-10-03; section 4.2.1). This is the only place the router keeps tool parameters other than search keywords. | DECIDED |
| D10 | The dashboard is reached at **`https://<domain>/dashboard`** on the same public domain as the MCP endpoint (owner, 2026-10-03), not through an SSH tunnel. This makes it a public admin surface: it needs its own sign-in and the controls of section 8. | DECIDED, security design PROPOSED |

## 2. On-demand lifecycle (D1)

The router is long-lived; the dashboard is a **listener that exists only while someone looks**.

```
operator host                         router container
─────────────                         ────────────────
jobwatch dashboard start ──(control socket in /data, 0600)──▶ opens the dashboard listener on 0.0.0.0:8090
        ◀── prints https://<domain>/dashboard  and the expiry
browser ──▶ https://<domain>/dashboard ──▶ Nginx ──▶ router :8090 ──▶ Google sign-in, then the app + /dashboard/api/*
idle 30 min, or `jobwatch dashboard stop` ──▶ listener closed, every session revoked
```

- **Control channel.** The CLI runs in a second process (`docker compose exec router jobwatch …`), so it cannot flip a switch in the router's memory directly. The router opens a **Unix socket** `/data/control.sock` (mode 0600, the data directory is already private) accepting `dashboard.start`, `dashboard.stop`, `dashboard.status`. No network control port is added.
- **Port and public path (D10).** `compose.yml` publishes `${JW_BIND}:${JW_DASHBOARD_PORT:-18933}:8090` permanently, next to the front's port; **nothing listens behind it** until `start`. Nginx maps `location /dashboard` to that port (same host, same certificate as the MCP endpoint; `deploy/nginx/` gets the block and a custom 503 page "The dashboard is off. Run `jobwatch dashboard start`."). The listener is mounted under the `/dashboard` prefix, so the app's base path, its API (`/dashboard/api/v1`) and its cookies are all scoped to it. The MCP routes (`/mcp`, `/.well-known`, `/register`, `/authorize`, `/token`, `/callback`) keep going to the OAuth front and are untouched.
- **Starting stays local.** Only someone with shell access to the host can turn the dashboard on (`jobwatch dashboard start`). There is deliberately **no MCP tool and no web endpoint that starts it**: an admin surface that Claude or an HTTP request could open is not acceptable.
- **Idle timeout.** Every authenticated request renews a timer (`JW_DASHBOARD_IDLE_S`, default 1800). When it fires the listener closes. In-memory call history is **not** lost: it belongs to the router, not to the listener.
- **Cost when stopped.** One Unix socket and the ring buffer. No listener, no timers, no static files loaded (they are read from disk per request when running). This keeps the router's RSS where `docs/plans/06` measured it; the step that adds the buffer re-measures it (§10).
- **CLI**: `jobwatch dashboard start [--ttl <minutes>] [--open]`, `stop`, `status` (running or not, URL, expiry, sessions open, requests served).

## 3. Entity boundaries (private vs public)

The dashboard API is a **public surface** for one authenticated operator, but it is still separate from the database. Rules (also `CLAUDE.md` global rule):

- Every endpoint has an explicit **response type** defined once in a new package `packages/dashboard-api` (zod schemas + inferred types) and used by both the server and the UI. A database row (`StoredJobRow`, `UsageEvent`, `CallRecord`) is never serialised as is.
- The list of jobs omits `description`; only the detail endpoint returns it (the same `detail` idea as the MCP tools, so a table of 200 rows is a few kilobytes, not megabytes).
- Never returned: cookies, tokens, the OAuth secrets, `deploy/.env` values, the control socket path, container ids, the Docker socket, raw tool arguments (only the argument hash and, for searches, the recorded keywords), browser profile data.
- A test (§9) serialises every endpoint's response and asserts it contains none of a list of forbidden keys and strings.

## 4. Data the dashboard needs

### 4.1 Already there

| Need | Source today |
|---|---|
| Stored jobs, filters, text | `jobs` table, `Store.listJobs`, `getJob` |
| Searches and keywords per job | `search_runs`, `search_hits`, `Store.searchStats`, `foundBy` |
| Rate usage per platform and per board | `RateLimiter.status`, `Store.usageKeys` (as `memory_report`) |
| Breaker state, session state, runtime state | `CircuitBreaker.state`, `session_status` cache, `RuntimeManager.status` |
| Enabled adapters and their tools | registry, `adapters.json`, `describeInstalled`, `buildCatalog` |
| Last 20 calls | `call_log` (SQLite, argument hash only) |

### 4.2 To add

1. **Call ring buffer** (`packages/core/src/dashboard/callLog.ts`, D4): the last `JW_DASHBOARD_CALL_BUFFER` calls (default 2000, bounded, about 1 MB), filled from the existing `CallRecorder` hook in `callTool`. Each entry: `id`, `requestId`, `startedAt`, `tool`, `adapter`, `platform`, `code`, `durationMs`, `argsHash`, **`unitsReserved`**, **`unitsSpent`**, **`responseBytes`**, **`estimatedTokens`**, `warnings` count, the recorded **keywords** for search tools, and **`params`**: the validated arguments of the call as a JSON object (D9). `ToolOutcome` gains the new fields; `callTool` already measures the result text for the output ceiling, so the size is free.
   - `params` is the zod-parsed argument object, so it holds only what the tool schema allows (keywords, filters, ids, URLs of a board, limits); no tool takes a credential. It is **memory only**: not in `call_log`, not in the logs, not in `memory_report`, not in any MCP result; the existing `argsHash` stays the only persisted trace. Each object is capped at 16 KB (a longer value is cut and the entry marked `paramsTruncated`), skip-id lists are kept whole up to that cap, and the buffer's total stays bounded by its entry count. The entry is deleted when it leaves the ring or the router restarts.
   - The detail view shows the object as formatted JSON with a copy button, and a *Run again in Claude* hint is **not** offered (the dashboard never calls a tool).
2. **In-flight calls**: the same buffer marks a call `running` between admission and settle, which gives "active calls" without polling.
3. **Daily aggregates** (D8): a small table `tool_usage_daily (day, tool, platform, calls, errors, bytes, tokens, units, duration_ms_sum)` updated on each call and kept 400 days. It gives the analytics a **Lifetime** and **Historical** view that survives a restart, which the memory buffer cannot. The cost is one UPSERT per call. It holds counts, bytes and durations only, never parameters.
4. **Token estimation** (D6). The router sends Claude the `content[0].text` of each result (the JSON body plus warnings). It cannot run Claude's tokenizer, and the Anthropic count-tokens API needs a key and a network call per result, which is out. The estimate is `ceil(characters / 3.5)` on that text (a first figure for compact JSON in English and French), configurable (`JW_TOKEN_CHARS_PER_TOKEN`), shown with a "~" and explained in the UI. The owner will calibrate it later with Claude's own usage data (D6); until then it is an estimate. Because the number is the same function for every call, **comparisons between tools, between `detail` levels and over time are reliable even if the absolute value is off by 10 to 20 %**. A calibration note in the doc records one real comparison against Claude's reported usage when available.
5. **Text kept back** (PROPOSED): for tools that return jobs, the difference between the description length the database holds (`description_chars`) and the text returned (`summary` or `description`) is the volume the `detail` setting kept out of Claude's context. Computed from the job fields the tools already return, in the same hook; shown as "kept back by summaries". This is the dashboard's counterpart of "tokens saved" and the evidence for the `detail: summary` default.

## 5. API (dashboard listener, JSON, versioned `/api/v1`)

All paths are under the `/dashboard` prefix (`/dashboard/api/v1/...`). All `GET` unless noted. Responses use the types of `packages/dashboard-api`.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/overview` | status cards: calls (completed, failed, rate-limited, active), runtime state, uptime, tokens returned, router version |
| `GET /api/v1/calls?since&tool&platform&code&limit&cursor` | page of the ring buffer, newest first |
| `GET /api/v1/calls/:id` | one call (detail view): units, bytes, tokens, warnings count, keywords and **`params`** (the JSON object of D9) |
| `GET /api/v1/usage?bucket=hour\|day&since&until&tool&platform` | time series and per-tool breakdown for the analytics page (§7.1) |
| `GET /api/v1/jobs?q&source&board&found_by&from&to&dateField&sort&dir&page&pageSize` | page of jobs **without description**, total count; server-side sort, filter and paging for TanStack Table |
| `GET /api/v1/jobs/:source/:id` | one job with description, summary, outline sections, hints, dates, `found_by`, url |
| `GET /api/v1/searches?since&until&source` | keyword statistics (same data as `stored_searches`) |
| `GET /api/v1/tools` | per adapter: id, kind, enabled, tools with parameters (from the catalog), rate usage (hour, day, limit), per-board usage, breaker, session state |
| `PUT /api/v1/adapters/:id` `{ "enabled": bool }` | writes `adapters.json` and **hot-reloads** the registry (D7); answers `{ applied: true, tools: [...added or removed], reconnectNeeded: true }` |
| `POST /api/v1/router/restart` | behind a confirm dialog: exits the process so `restart: unless-stopped` brings it back; refused while a call is running unless `force` |
| `GET /api/v1/events` | optional Server-Sent Events stream of call start / end for a live tab (v2) |

Search and filtering run in SQL (`Store.listJobs` gains `q` over title and company, sort, offset) so a 5000-job window never goes to the browser. The jobs endpoints never trigger a fetch from a site.

## 6. Front end

### 6.1 Stack and layout in the repo

- New Nx project **`apps/dashboard`**: Vite, React 19, TypeScript strict, Tailwind v4, **shadcn/ui** components copied into `apps/dashboard/src/components/ui` (they are source, reviewed like our code), **@tanstack/react-table** v8, **@tanstack/react-query**, **recharts** through the shadcn `chart` component, `react-router` for the sections, `zod` and the `packages/dashboard-api` types.
- The build output (`apps/dashboard/dist`) is copied into the router image next to the bundled server and served by the dashboard listener. No CDN, no remote fonts, no analytics, no external request from the page (enforced by the Content Security Policy, §8).
- Lint: the existing architecture rules extend with `apps/dashboard` may import `packages/dashboard-api` only; nothing from `core`, `sdk` or an adapter. `core` may import `packages/dashboard-api` (to build responses) but never `apps/dashboard`.
- Light and dark theme (shadcn tokens), dark by default. Desktop first (the operator's laptop); usable down to a tablet width; no mobile target.

### 6.2 Shell

```
┌──────────┬─────────────────────────────────────────────────────────────────────────┐
│ jobwatch │  [ Session | Lifetime | Historical ]   status ● healthy   updated 12:14  │
│          ├─────────────────────────────────────────────────────────────────────────┤
│ Overview │  Tabs: All · LinkedIn · Apec · WTTJ · Teamtailor · Greenhouse · Lever …  │
│ Analytics├─────────────────────────────────────────────────────────────────────────┤
│ Runs     │                                                                         │
│ Jobs     │   section content                                          ┌──────────┐ │
│ Searches │                                                            │ detail   │ │
│ Tools    │                                                            │ (right)  │ │
│ Settings │                                                            └──────────┘ │
└──────────┴─────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (shadcn `Sidebar`, collapsible to icons): Overview, Analytics, Runs, Jobs, Searches, Tools & status, Settings (idle timeout, theme, token ratio, buffer size, read-only display of limits).
- **Tabs** (shadcn `Tabs`) under the header: *All* plus one tab per **enabled** adapter. The selected tab filters the current section by platform and is kept in the URL (`?tool=linkedin`), so a view is a link.
- **Detail panel**: shadcn `Sheet` (side right) or a resizable `ResizablePanel` pair on wide screens, so the table stays visible beside it. Closes with Escape; the selected row is in the URL (`/jobs/linkedin/4000000001`).

### 6.3 Sections

**Overview.** Request health card (completed, failed, rate-limited, cached or stored), live activity card (active calls, queued browser calls, runtime state), then the headline numbers (tokens returned, calls, estimated tokens kept back) and the budget gauges (§7.2). The landing page for "is everything fine".

**Runs (history).** TanStack Table over `/calls`: time, tool, platform, outcome badge, duration, units spent / reserved, size, estimated tokens, keywords. The keywords of a search show on the row (owner, 2026-10-03). A click opens the **detail view** on the right (same panel as a job): all the **parameters of the call as formatted JSON** with a copy button, the units reserved and spent, the size and estimated tokens returned, the warnings count, the argument hash and request id, and for a search a link to the jobs it listed. Filters: tool (also the tab), outcome, time range, a "only slow" and "only failed" toggle. Live badge for running calls. Banner: "kept in memory, cleared when the router restarts".

**Jobs (stored offers).** TanStack Table with server-side data:

| Column | Notes |
|---|---|
| Title, Company, Location | text, sortable |
| Source, Board | badges; Board filter for ATS |
| First seen, Last seen | relative time with an absolute tooltip, sortable |
| Found by | the keywords as small badges (from `found_by`) |
| Size | description characters |
| Link | opens the posting in a new tab (`rel=noopener noreferrer`) |

Column visibility menu, a search box (`q`), filters for source / board / keyword (`found_by`) / date range and `dateField` (first seen, last seen, fetched), page size, keyboard navigation (arrow keys, Enter to open the detail). **Click or Enter on a row opens the detail on the right**: header (title, company, source, board, dates, link), the summary and the outline sections as collapsible blocks, the full description in a scroll area with a copy button, the hints (stack, years, remote, salary) as badges, `found_by`, and the history of the searches that listed it. Description text is untrusted: rendered as plain text, never as HTML.

**Searches.** A table of keywords: platform, keywords, runs, jobs found / returned / new, last run, with a small bar showing the new-to-found ratio so a keyword that only brings the same jobs back stands out. Click a row: jobs of that keyword (`found_by` filter on the Jobs table).

**Tools & status.** One card per installed adapter (grouped by enabled and disabled): kind (HTTP, browser), session state with the time it was checked, breaker (open, reason, until), the tools with their parameters, the rate usage bars for the hour and the day, and for an ATS the per-board usage list (busiest first). A **switch enables or disables** the adapter (D7): it writes `adapters.json` and reloads the registry at once; the card shows "applied, reconnect the Claude connector to see the new tool list". A separate *Restart router* action (confirm dialog) stays for the rare case it is needed. Adapters forced by `JW_ADAPTERS` show the switch disabled with the reason. LinkedIn's switch warns that its budget needs the owner's approval (`docs/plans/09`).

**Analytics.** §7.

**Settings.** Idle timeout of this dashboard session, theme, the characters-per-token ratio, and a read-only block of the effective limits (browser memory caps, tab limit, retention).

### 6.4 Hot reload of adapters (D7)

Today the registry is built once at startup (`loadAdapters` in `apps/mcp/src/server.ts`) and handed to the MCP server, the guard and the context provider. Hot reload makes it a **replaceable holder**:

- `RegistryHolder.current()` returns the live registry; `reload(ids)` builds a new one with `loadAdapters`, validates it fully **before** swapping (a failing adapter leaves the old registry in place and returns the problems), then swaps atomically. The MCP server, `callTool`, the rate-limit policy (`policyFor`) and `memory_report` read through the holder on every request instead of capturing the registry.
- **A call in flight keeps the registry it started with**; the next request sees the new one. A disabled browser adapter's running lease finishes normally; its runtime then idles out as usual.
- The server is **stateless** (no sessions, no server-to-client channel), so the router cannot push `notifications/tools/list_changed`. Claude sees the new tool list when its connector refreshes or reconnects; the response of the switch says so (`reconnectNeeded`). This is a property of the stateless design, not of hot reload.
- The same `reload` is called by the CLI (`jobwatch adapters enable|disable`) through the control socket when the router is running, so the two paths agree; without a router the CLI keeps writing the file as today. `JW_ADAPTERS` still pins the list: reload is refused with the reason.
- The `tools/list` snapshot test and the static-schema rule are unchanged: `tools/list` is still answered from the current registry without starting a container.

## 7. Analytics page

A dense, card-based metrics page with a **Session | Lifetime | Historical** segmented control: *Session* = the ring buffer since the router started; *Lifetime* = the persisted daily aggregates (§4.2.3); *Historical* = a date range picker over them. Tool tabs apply on top. The layout, in reading order:

1. **Request health** and **Live activity** cards (two wide cards): completed / failed / rate-limited / stored-answers; active calls / queued browser calls / runtime state / uptime.
2. **Headline cards** (three in a row): **Tokens returned to Claude** (estimated, with the average per call and a delta against the previous period), **Calls** (with error rate), **Kept back by summaries** (estimated tokens not sent because of `detail: summary` / `none`, as a percentage of what the full text would have been).
3. **Performance row** (three panels): duration (p50 / p95 / max, per period), throughput (calls per hour, current 5 minutes), and a **per-tool breakdown** list (tool, average and max duration), like a pipeline breakdown.
4. **Token usage row** (three panels): *Token usage* (full text available, returned, kept back, output total); *What the tools returned* (a horizontal bar per category: job summaries, full descriptions, result cards, metadata and warnings, errors); *Tokens over time* (area chart, hour or day buckets).
5. **Per-tool table** (like a per-model table): tool, calls, errors, average and total estimated tokens, average duration, average units spent, share of tokens; sortable.
6. **Budget panel**: for each platform, the hourly and daily usage against the limit as gauges, with the reset time (the oldest event leaving the window), then the ATS boards nearest to their limit. Same data as `memory_report`.
7. **Search effectiveness**: the top keywords by new jobs and the keywords that listed nothing new in the period (candidates to drop), from `searches`.
8. **Recent calls** (last 25, click a row to expand), the same component as the Runs table.

Rules: every estimated number carries a "~" and a tooltip; empty states say what to do ("No calls yet. Run a search from Claude."); charts are accessible (a data table alternative, no colour-only meaning).

## 8. Security

The dashboard exposes job-search data, the parameters of every call and a switch that changes which adapters are on. Reached at `https://<domain>/dashboard` (D10) it is a **public admin surface** on a host whose router holds the rootless Docker socket. The design below is the minimum; section 12 lists what still needs the owner's agreement.

- **Off unless started, started only from the host.** The listener does not exist until `jobwatch dashboard start`, and nothing remote can start it (section 2). When it is off, `/dashboard` answers a static 503 from Nginx.
- **Its own sign-in with Google, and an allowlist.** The OAuth front cannot be reused for the dashboard, but the **Google OAuth setup can** (verified 2026-10-03, section 8.1). The dashboard therefore does an OpenID Connect login itself, with its own login screen, using a Google OAuth client and one added redirect URI `https://<domain>/dashboard/auth/callback`: authorization code flow with PKCE, `state` and `nonce`, ID token checked (issuer, audience, signature, expiry), **`email_verified` true and the email in `JW_DASHBOARD_ALLOWED_EMAILS`**. The variable is **required**; the dashboard refuses to start with an empty list. The allowlist is the control: it does not rely on the Google app being in Testing mode.
- **Session.** After the callback the dashboard sets a random session id in a `Secure`, `HttpOnly`, `SameSite=Strict` cookie scoped to path `/dashboard`, kept server-side in memory (so a restart signs everyone out), idle timeout 30 minutes, absolute lifetime 8 hours, all revoked by `dashboard stop`. No token is ever placed in a URL.
- **Writes need a recent sign-in** (PROPOSED). `PUT /adapters/:id` and `POST /router/restart` are refused unless the session authenticated within the last 10 minutes (OIDC `max_age`); otherwise the UI sends the user through Google again. A stolen idle session cannot change the router.
- **CSRF and origin.** Every non-GET request needs a custom header the app sets, an `Origin` equal to the configured public origin, and the `SameSite=Strict` cookie. `Host` must equal the configured public host (no DNS rebinding, no open Host).
- **Brute force.** Per-IP rate limiting on the login routes (the real client address comes from the `X-Forwarded-For` that Nginx overwrites, trusted only from `JW_NGINX_CIDR`), constant-time checks, a generic error for a refused email.
- **Headers.** Strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses, HSTS inherited from the site, no CORS.
- **Nginx.** The `/dashboard` block adds its own request-rate limit, `client_max_body_size 64k`, and does not buffer the optional SSE stream; the WAF/allowlist rules of `docs/plans/10` are unchanged for the MCP paths.
- **What the API never returns** (section 3), and in particular: the call `params` come only from the in-memory buffer (D9), only on the detail endpoint, never in a list response, never persisted.
- **Untrusted text.** Job text, company names, keywords and call parameters come from third-party sites or from Claude: rendered as text by React (no `dangerouslySetInnerHTML`; a lint rule forbids it), links only `https:` with `rel="noopener noreferrer"`.
- **Writes.** Two, both inside the router's own data (`adapters.json`) or process (reload, restart). Neither touches a third-party platform, so the read-only rule of the project is untouched; both are logged with the actor's email and the action, no secret.
- **No Docker surface.** The dashboard process has no endpoint that reaches the Docker API, and the runtime manager is not callable from it except through the existing read-only `status()`.
- **One new secret.** The sign-in needs a Google client secret in the router's environment, where today only the OAuth front holds one. Preferably a **separate Google OAuth client for the dashboard** (its own secret and redirect URI), so a leak of one does not affect the connector (§12.3). Adding it to the router is a change to what the router holds, so it needs the owner's agreement (`docs/plans/09`).
- **Dependencies.** A UI adds hundreds of packages. `allowScripts` stays denied, the lockfile is committed, a CI job runs `npm audit --omit=dev --audit-level=high` for the dashboard workspace, and the production image contains only the built static files, not the front end's `node_modules`.

### 8.1 Verified: what of the OAuth setup can be reused (2026-10-03)

Read from the source and docs of `babs/mcp-auth-proxy` (`config/config.go`, `main.go`, `docs/configuration.md`, `proxy/proxy.go`) and from Google's discovery document.

| Question | Finding | Consequence |
|---|---|---|
| Can the front serve `/dashboard`? | **No.** It has **one** `UPSTREAM_MCP_URL` with an explicit path; that path is both the public mount and the forwarded path (`r.Handle(mount)` and `mount/*`), and anything outside the mount is a 404. `PROXY_BASE_URL` must be origin-only (no path). | The dashboard cannot sit behind the front on the same domain. |
| A second front instance for `/dashboard`? | **No.** Its OAuth routes are fixed at the root of the host (`/register`, `/authorize`, `/callback`, `/token`, `/.well-known`) and are reserved, so two fronts on one domain collide. | Not an option on one hostname. |
| Is the front's login a browser login? | **No.** It is an OAuth 2.1 authorization server for MCP clients: dynamic registration, PKCE, consent page, then an **opaque sealed bearer token** (AES-GCM, access 1 h, refresh 7 d). It sets **no session cookie**, and a browser cannot attach a bearer token to a page navigation. | A browser dashboard needs its own login and cookie session. |
| Reuse the front's tokens in the dashboard? | **Not sensibly.** They are opaque, sealed with `TOKEN_SIGNING_SECRET`, and the front has no introspection or JWKS endpoint. Using them would mean copying the signing secret into the router and re-implementing a private format. | Rejected. |
| Does the router already know who calls `/mcp`? | Yes: the front injects `X-User-Sub`, `X-User-Email` and `X-User-Groups` upstream (and strips any the caller sent). | Useful for logging the actor of MCP calls; unrelated to the dashboard login. |
| Reuse the **Google OAuth project and client**? | **Yes.** Google's discovery document confirms what the flow needs: authorization code flow, PKCE `S256`, scopes `openid email profile`, `email` and `email_verified` claims, RS256 id tokens and a public JWKS. A Google web client accepts several authorized redirect URIs. | Reuse the Google project and the "Testing" consent screen; add `https://<domain>/dashboard/auth/callback` to a client. |
| Reuse the **same client secret**? | Possible, but the secret would then also live in the router. | Prefer a **second client in the same Google project** for the dashboard (§12.3): same consent screen and test users, its own secret and redirect URI. |

What was **not** verified, because it needs real Google credentials and a deployed domain: an actual sign-in end to end. Step 3 proves it with a fake OIDC provider in tests and step 4 with a real sign-in behind Nginx.

## 9. Testing

- **API**: vitest against the real handlers with an in-memory `Store`; every endpoint's response is parsed by its `packages/dashboard-api` schema (contract test), and a **leak test** serialises each response and fails on any forbidden key (`cookie`, `token`, `secret`, `password`, `authorization`, `argsHash` outside the call detail, container ids, the control socket path).
- **Ring buffer**: capacity, eviction order, running → settled transitions, concurrent calls, `params` kept as the parsed object, cut at 16 KB with `paramsTruncated`, and **never** present in `call_log`, the logs, `memory_report` or any list response.
- **Lifecycle and auth**: start / stop / idle timeout (fake clock), a second `start` while running returns the same URL, a stopped listener refuses connections; with a fake OIDC provider: wrong `state`, wrong `nonce`, bad signature, expired token, unverified email and an email outside the allowlist are all refused, an allowed email gets the cookie, a write with a stale sign-in is refused, wrong Host and wrong Origin are refused, `dashboard start` with an empty allowlist fails.
- **Hot reload**: a failing adapter leaves the old registry; a call in flight keeps its registry; `tools/list` reflects the new one on the next request; `JW_ADAPTERS` refuses the reload; the guard's policy follows the swap.
- **Token estimation**: pure function tests, plus a test that the same result always gives the same estimate and that `detail: none` < `summary` < `full` on the same job.
- **Front end**: Vitest + Testing Library for the table (sorting, filtering, paging calls the API with the right query, Enter opens the detail, Escape closes it), the detail panel (renders text, not HTML: a `<script>` in a description appears literally), the tool switch, the empty and error states. No visual-regression suite.
- **Smoke**: one scripted check (`tests/dashboard/smoke.ts`, run by hand like the soak test, not in CI) that starts a router with a seeded database, opens the dashboard in a real browser and walks the sections.
- The whole suite stays under the 5 minute cap; front-end tests are jsdom-based and cheap.

## 10. RAM and the benchmark

The measured benchmark remains the ceiling (`docs/plans/06`). The dashboard must not move it:

- The listener, the static files and the React app exist only while running; the app runs in the **operator's** browser, not in the browser container.
- The ring buffer is bounded (2000 entries, about 1 MB). The step that adds it records the router's RSS before and after under the soak runner and writes the numbers in `docs/measurements.md`; a growth above a few MB is a bug to fix before merging.
- No dashboard code path starts a browser container, takes the global browser semaphore or spends a rate-limit unit.

## 11. Delivery plan (one branch and one PR per step)

| Step | Branch | Content | Exit |
|---|---|---|---|
| 0 | `docs/dashboard-plan` (merged), `docs/dashboard-plan-decisions` | this document, then the owner's answers folded in | owner agrees with the security design of section 8 |
| 1 | `feat/dashboard-call-log` | `ToolOutcome` gets sizes, units, estimated tokens and `params`; the call ring buffer; the token estimator; `memory_report` unchanged | unit tests; RSS recorded; leak tests for `params` |
| 2 | `feat/hot-reload-adapters` | `RegistryHolder`; the MCP server, `callTool`, guard policy and `memory_report` read through it; control socket (reused by step 4); CLI `adapters enable\|disable` reloads a running router | reload tests of section 9; a live reload on a real router |
| 3 | `feat/dashboard-api` | `packages/dashboard-api` types; the listener under `/dashboard`; OIDC sign-in, sessions, headers, CSRF, allowlist; read endpoints (`overview`, `calls`, `jobs`, `searches`, `tools`, `usage`); `Store.listJobs` gains `q`, sort and offset; leak and contract tests; the **VERIFY** on the front | auth tests green; leak test green |
| 4 | `feat/dashboard-lifecycle` | `jobwatch dashboard start\|stop\|status`; idle timeout; compose port; Nginx `/dashboard` block and 503 page; config keys; docs `03`, `09`, `10`, README | start / stop proven in a real container behind Nginx |
| 5 | `feat/dashboard-ui-shell` | `apps/dashboard`: Vite, Tailwind, shadcn, router, sidebar, tool tabs, Overview and Runs with the parameters detail view; served by the listener; image build copies `dist` | opens from `dashboard start`; Runs shows live calls and their parameters |
| 6 | `feat/dashboard-jobs` | Jobs table (TanStack Table, server-side) and the right-hand detail; Searches | click a row, read the full description |
| 7 | `feat/dashboard-tools` | Tools & status; `PUT /adapters/:id` with hot reload; the *Restart router* action | enable / disable takes effect without a restart |
| 8 | `feat/dashboard-analytics` | Analytics page; daily aggregates table; Session / Lifetime / Historical | all panels of section 7 populated from real calls |
| 9 | `docs/dashboard-hardening` | security checklist run (section 8), `npm audit` CI job, smoke script, measurements, docs `09` | checklist ticked |

Each step ends with `npm run ci` green and the docs updated in the same PR.

## 12. Owner's answers (2026-10-03) and what is still open

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | Restart button in the UI? | Yes | D7, sections 5 and 6.3 |
| 2 | Hot enable / disable? | Yes, use hot reload | D7, section 6.4, step 2 |
| 3 | Persist daily aggregates? | Yes | D8, section 4.2.3 |
| 4 | 3.5 characters per token to start? | Yes; look at it later with Claude's own data | D6, section 4.2.4 |
| 5 | Keywords on the Runs rows? | Yes, plus a detail view with all parameters kept in memory as a JSON object | D4, D9, sections 4.2.1 and 6.3 |
| 6 | New workspaces and front-end dependencies? | Yes | D2 |
| 7 | Serve it at `<domain>/dashboard`? | Yes | D10, sections 2 and 8 |

**Still open, to settle before step 3 and 4:**

1. **Writes need a recent sign-in** (section 8): see the explanation below; 10 minutes, another value, or off?
2. **Allowlisted email(s)** for `JW_DASHBOARD_ALLOWED_EMAILS`: the same Google account as the connector, or others?
3. **Google client secret in the router's environment.** The sign-in needs it in the router, which today only the OAuth front holds. A separate Google OAuth client for the dashboard (own secret, own redirect URI, so a leak does not affect the connector) is the cleaner choice. Do you want a second client?
4. **Public admin surface.** With D10 the dashboard is reachable from the internet whenever it is on. The plan keeps it off by default, started from the host only, behind its own Google sign-in and an allowlist. If you would rather add a second layer (an Nginx IP allowlist for your own addresses, or HTTP basic auth in front), say so; it costs a few lines in the Nginx block.
5. **Timers** (see the explanation below): the plan has three; the recommendation is to reduce them to two.

**Recent sign-in, explained.** Being signed in to the dashboard lets you read. Two actions change the router: enabling or disabling an adapter and restarting it. "Recent sign-in" means those two actions are only accepted if you authenticated with Google within the last N minutes; if you signed in earlier, the dashboard sends you through Google again (one click when you already have a Google session) and then performs the action. The point is that a session left open on a shared screen, or a stolen cookie, can read but cannot change anything. With 10 minutes you sign in once, browse, and the first change after a long browse asks you to confirm. Off means any open session can write.

**The timers, explained.** They are independent:
1. **Listener idle stop (30 min).** If nobody calls the dashboard for 30 minutes the whole dashboard shuts down: `/dashboard` goes back to the 503 page and `jobwatch dashboard start` is needed again. Every request resets the countdown.
2. **Session idle timeout (30 min).** Your browser cookie for the dashboard (not the Google or the Claude connector sign-in). After 30 minutes without a request it is no longer valid and you sign in again.
3. **Session absolute lifetime (8 h).** Even if you keep using it, the cookie ends 8 hours after sign-in.
They are unrelated to the Claude connector's OAuth tokens (1 h access, 7 d refresh), which belong to the OAuth front and are not touched. Because timer 1 already turns the dashboard off when idle, timers 2 and 3 mostly overlap with it. Recommendation: keep timer 1 at 30 minutes (adjustable with `dashboard start --ttl`), make the session last until the dashboard stops with a cap of 8 hours, and drop the separate session idle timer. That leaves two numbers to think about.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The dashboard is a public admin surface on a router that holds a Docker socket | high | off by default and started only from the host; own Google sign-in with a required email allowlist; recent-sign-in rule for writes; Host / Origin / CSRF checks; CSP; no Docker endpoint; writes limited to `adapters.json`, reload and restart; optional Nginx IP allowlist (§12.4) |
| Call parameters in memory could contain something sensitive | medium | schema-validated arguments only (no tool takes a credential), memory only, 16 KB cap, never logged or persisted, detail endpoint only |
| Hot reload swaps the registry under load | medium | validate before swap, in-flight calls keep their registry, atomic swap, tests of section 9 |
| Estimated tokens mistaken for exact billing numbers | medium | "~" and tooltips everywhere, documented method, comparisons are the point |
| Front-end dependency weight and supply chain | medium | scripts denied, lockfile, audit job, only built assets in the image |
| In-memory history lost on restart surprises the operator | low | banner, persisted aggregates for the analytics |
| Server-side table queries get slow on a large database | low | indexes on `first_seen`, `last_seen`; paging; the retention bounds the size |
| UI drift from the API | medium | one schema package used by both sides, contract tests |
