# 17 — Dashboard (plan)

> **Related docs:** Load to build or review the operator dashboard. Also load: `03` (config, ops tools, store), `04` (tool outputs), `06` (memory benchmark, which the dashboard must not move), `09` (threat model), `10` (compose, ports), `12` (roadmap). Follow a link only if the task needs it.

**Status: plan, nothing built (2026-10-03).** Decisions are tagged **DECIDED** (agreed with the owner) or **PROPOSED** (recommended, confirm before the step that needs it).

## 1. Purpose and scope

The router answers Claude. Nobody can see, without asking Claude, what it did, what it stored or where each budget stands. The dashboard is a **web UI for the operator** that shows:

1. **Run history**: every tool call since the router started (kept in memory), with outcome, duration, cost in rate-limit units and the size of what was returned to Claude.
2. **Stored jobs**: the jobs in the database, searchable, with a detail view on the right.
3. **Searches**: the history of search keywords and what each brought in (`stored_searches`, `docs/plans/03` "History of searches").
4. **Tool state**: per adapter and tool, the current rate usage (platform and company boards), breaker state, session state, and **enable / disable**.
5. **Analytics** on tool usage, with the **estimated tokens returned to Claude**.

Not in scope: anything that touches a third-party site (the dashboard never calls an adapter, never starts a browser, never spends a platform budget); a multi-user product; public exposure; Claude-side token accounting (the router cannot see Claude's own usage, only what it sends).

### Decisions

| # | Decision | Status |
|---|---|---|
| D1 | **On demand, not always running** (owner, 2026-10-03). The dashboard listener is off by default and started by `jobwatch dashboard start`; it stops after an idle timeout or `jobwatch dashboard stop`. | DECIDED |
| D2 | Stack: **React + shadcn/ui + TanStack Table**, built with Vite; TanStack Query for data; shadcn charts (Recharts) for graphs. | DECIDED |
| D3 | Layout: a **sidebar** to switch sections (analytics, runs, stored jobs, searches, tools and status) and **tabs** to switch between tools within a section. Stored jobs in a TanStack Table, a **detail panel on the right** on row click. | DECIDED |
| D4 | The calls are **kept in memory** (a ring buffer in the router process). | DECIDED |
| D5 | The server part runs **inside the router process** (it owns the memory buffer, the limiter and the registry), on its own listener, never on the MCP port and never behind the OAuth front. | PROPOSED |
| D6 | Token counts are **estimates** computed from the size of the text sent to Claude, labelled as such everywhere. | PROPOSED |
| D7 | Enable / disable writes `adapters.json` and tells the operator a router restart is needed (no hot reload in v1). | PROPOSED |

## 2. On-demand lifecycle (D1)

The router is long-lived; the dashboard is a **listener that exists only while someone looks**.

```
operator host                         router container
─────────────                         ────────────────
jobwatch dashboard start ──(control socket in /data, 0600)──▶ opens the dashboard listener on 0.0.0.0:8090
        ◀── prints http://127.0.0.1:18933/#token=…  (one-time token, TTL)     (only published on host loopback)
browser ──SSH tunnel if remote──▶ 127.0.0.1:18933 ──▶ static app + /api/*
idle 30 min, or `jobwatch dashboard stop` ──▶ listener closed, token revoked
```

- **Control channel.** The CLI runs in a second process (`docker compose exec router jobwatch …`), so it cannot flip a switch in the router's memory directly. The router opens a **Unix socket** `/data/control.sock` (mode 0600, the data directory is already private) accepting `dashboard.start`, `dashboard.stop`, `dashboard.status`. No network control port is added.
- **Port.** `compose.yml` publishes `127.0.0.1:${JW_DASHBOARD_PORT:-18933}:8090` permanently (like the metrics port today); **nothing listens behind it** until `start`. The bind address is loopback unless `JW_DASHBOARD_BIND` says otherwise; a non-loopback bind is refused unless an explicit `JW_DASHBOARD_ALLOW_REMOTE=true` is set.
- **Idle timeout.** Every authenticated request renews a timer (`JW_DASHBOARD_IDLE_S`, default 1800). When it fires the listener closes. In-memory call history is **not** lost: it belongs to the router, not to the listener.
- **Cost when stopped.** One Unix socket and the ring buffer. No listener, no timers, no static files loaded (they are read from disk per request when running). This keeps the router's RSS where `docs/plans/06` measured it; the step that adds the buffer re-measures it (§10).
- **CLI**: `jobwatch dashboard start [--ttl <minutes>] [--open]`, `stop`, `status` (running or not, URL host, expiry, requests served).

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

1. **Call ring buffer** (`packages/core/src/dashboard/callLog.ts`, D4): the last `JW_DASHBOARD_CALL_BUFFER` calls (default 2000, bounded, about 1 MB), filled from the existing `CallRecorder` hook in `callTool`. Each entry: `id`, `requestId`, `startedAt`, `tool`, `adapter`, `platform`, `code`, `durationMs`, `argsHash`, **`unitsReserved`**, **`unitsSpent`**, **`responseBytes`**, **`estimatedTokens`**, `warnings` count, and for search tools the recorded **keywords**. Nothing else from the arguments. `ToolOutcome` gains the new fields; `callTool` already measures the result text for the output ceiling, so the size is free.
2. **In-flight calls**: the same buffer marks a call `running` between admission and settle, which gives "active calls" without polling.
3. **Daily aggregates** (PROPOSED): a small table `tool_usage_daily (day, tool, platform, calls, errors, bytes, tokens, units, duration_ms_sum)` updated on each call and kept 400 days. It gives the analytics a **Lifetime** and **Historical** view that survives a restart, which the memory buffer cannot. Without it the analytics reset with the router; with it the cost is one UPSERT per call. Decision for the owner before step 7 (§12, question 3).
4. **Token estimation** (D6). The router sends Claude the `content[0].text` of each result (the JSON body plus warnings). It cannot run Claude's tokenizer, and the Anthropic count-tokens API needs a key and a network call per result, which is out. The estimate is `ceil(characters / 3.5)` on that text (a conservative figure for compact JSON in English and French), configurable (`JW_TOKEN_CHARS_PER_TOKEN`), shown with a "~" and explained in the UI. Because the number is the same function for every call, **comparisons between tools, between `detail` levels and over time are reliable even if the absolute value is off by 10 to 20 %**. A calibration note in the doc records one real comparison against Claude's reported usage when available.
5. **Text kept back** (PROPOSED): for tools that return jobs, the difference between the description length the database holds (`description_chars`) and the text returned (`summary` or `description`) is the volume the `detail` setting kept out of Claude's context. Computed from the job fields the tools already return, in the same hook; shown as "kept back by summaries". This is the dashboard's counterpart of "tokens saved" and the evidence for the `detail: summary` default.

## 5. API (dashboard listener, JSON, versioned `/api/v1`)

All `GET` unless noted. Responses use the types of `packages/dashboard-api`.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/overview` | status cards: calls (completed, failed, rate-limited, active), runtime state, uptime, tokens returned, router version |
| `GET /api/v1/calls?since&tool&platform&code&limit&cursor` | page of the ring buffer, newest first |
| `GET /api/v1/calls/:id` | one call (expandable row): units, bytes, tokens, warnings count, keywords |
| `GET /api/v1/usage?bucket=hour\|day&since&until&tool&platform` | time series and per-tool breakdown for the analytics page (§7.1) |
| `GET /api/v1/jobs?q&source&board&found_by&from&to&dateField&sort&dir&page&pageSize` | page of jobs **without description**, total count; server-side sort, filter and paging for TanStack Table |
| `GET /api/v1/jobs/:source/:id` | one job with description, summary, outline sections, hints, dates, `found_by`, url |
| `GET /api/v1/searches?since&until&source` | keyword statistics (same data as `stored_searches`) |
| `GET /api/v1/tools` | per adapter: id, kind, enabled, tools with parameters (from the catalog), rate usage (hour, day, limit), per-board usage, breaker, session state |
| `PUT /api/v1/adapters/:id` `{ "enabled": bool }` | writes `adapters.json`; answers `{ restartRequired: true }` (D7) |
| `POST /api/v1/router/restart` | PROPOSED, behind a confirm: exits the process so `restart: unless-stopped` brings it back; refused while a call is running unless `force` |
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

**Runs (history).** TanStack Table over `/calls`: time, tool, platform, outcome badge, duration, units spent / reserved, size, estimated tokens, keywords. Row expands to the call detail (warnings count, argument hash, request id, a link to the jobs it listed when it was a search). Filters: tool (also the tab), outcome, time range, a "only slow" and "only failed" toggle. Live badge for running calls. Banner: "kept in memory, cleared when the router restarts".

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

**Tools & status.** One card per installed adapter (grouped by enabled and disabled): kind (HTTP, browser), session state with the time it was checked, breaker (open, reason, until), the tools with their parameters, the rate usage bars for the hour and the day, and for an ATS the per-board usage list (busiest first). A **switch enables or disables** the adapter (D7): writes `adapters.json`, shows "restart required" with the *Restart router* action. Adapters forced by `JW_ADAPTERS` show the switch disabled with the reason. LinkedIn's switch warns that its budget needs the owner's approval (`docs/plans/09`).

**Analytics.** §7.

**Settings.** Idle timeout of this dashboard session, theme, the characters-per-token ratio, and a read-only block of the effective limits (browser memory caps, tab limit, retention).

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

The dashboard exposes job-search data and can change which adapters are on, so it is treated as an admin surface, with the same care as the noVNC login viewer (`docs/plans/05`).

- **Never public.** Not behind Nginx, not behind the OAuth front. Loopback bind by default (§2); remote access is an SSH tunnel, as for the login viewer. A non-loopback bind needs an explicit flag and is logged at start.
- **Auth.** `dashboard start` creates a random token (32 bytes) shown once in the printed URL fragment (the fragment never reaches a server log or a `Referer`). The first load exchanges it for an `HttpOnly`, `SameSite=Strict` cookie; the token is single use and expires with the session. Constant-time comparison; failed attempts are rate limited.
- **DNS rebinding.** The listener rejects any request whose `Host` is not the configured loopback name and port. `Origin` is checked on every non-GET request.
- **CSRF.** State-changing endpoints (`PUT /adapters`, `POST /router/restart`) require a custom header the app sets plus a matching `Origin`, and the `SameSite=Strict` cookie.
- **Headers.** Strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, no CORS.
- **Untrusted text.** Job text, company names and keywords come from third-party sites or from Claude: rendered as text by React (no `dangerouslySetInnerHTML`; a lint rule forbids it), links only `https:` and opened with `rel="noopener noreferrer"`.
- **Writes.** Two, both inside the router's own data (`adapters.json`) or process (restart). Neither touches a third-party platform, so the read-only rule of the project is untouched; both appear in the log with the action and no secret.
- **No new secrets.** The dashboard reads no `.env` value and returns none.
- **Dependencies.** A UI adds hundreds of packages. `allowScripts` stays denied, the lockfile is committed, a CI job runs `npm audit --omit=dev --audit-level=high` for the dashboard workspace, and the production image contains only the built static files, not `node_modules` of the front end.

## 9. Testing

- **API**: vitest against the real handlers with an in-memory `Store`; every endpoint's response is parsed by its `packages/dashboard-api` schema (contract test), and a **leak test** serialises each response and fails on any forbidden key (`cookie`, `token`, `secret`, `password`, `authorization`, `argsHash` outside the call detail, container ids, the control socket path).
- **Ring buffer**: capacity, eviction order, running → settled transitions, concurrent calls, no raw arguments retained.
- **Lifecycle**: start / stop / idle timeout (fake clock), a second `start` while running returns the same URL, a stopped listener refuses connections, the token works once, wrong Host and wrong Origin are refused.
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
| 0 | `docs/dashboard-plan` | this document, the roadmap entry, the diagram | owner reviews and answers §12 |
| 1 | `feat/dashboard-call-log` | `ToolOutcome` gets sizes, units and estimated tokens; the call ring buffer; the token estimator; `memory_report` unchanged | unit tests; RSS recorded |
| 2 | `feat/dashboard-api` | `packages/dashboard-api` types; the dashboard listener, auth, headers; read endpoints (`overview`, `calls`, `jobs`, `searches`, `tools`, `usage`); `Store.listJobs` gains `q`, sort and offset; leak and contract tests | endpoints tested; leak test green |
| 3 | `feat/dashboard-lifecycle` | control socket; `jobwatch dashboard start|stop|status`; idle timeout; compose port; config keys; docs `03`, `10`, README | start / stop proven in a real container |
| 4 | `feat/dashboard-ui-shell` | `apps/dashboard`: Vite, Tailwind, shadcn, router, sidebar, tool tabs, Overview and Runs; served by the listener; image build copies `dist` | opens from `dashboard start`; Runs shows live calls |
| 5 | `feat/dashboard-jobs` | Jobs table (TanStack Table, server-side) and the right-hand detail; Searches | click a row, read the full description |
| 6 | `feat/dashboard-tools` | Tools & status; `PUT /adapters/:id`; restart-required banner; (optional) restart action | enable / disable round-trips `adapters.json` |
| 7 | `feat/dashboard-analytics` | Analytics page; daily aggregates table (if question 3 of §12 is yes); Session / Lifetime / Historical | all panels of §7 populated from real calls |
| 8 | `docs/dashboard-hardening` | security checklist run (§8), `npm audit` CI job, smoke script, measurements, docs `09` | checklist ticked |

Each step ends with `npm run ci` green and the docs updated in the same PR.

## 12. Questions for the owner (before the step named)

1. **Restart from the UI (step 6).** Add a *Restart router* button (the process exits and Docker restarts it; any running call is cut), or only print "run `docker compose restart router`"? Recommendation: the button, with a confirm and a refusal while a call is running.
2. **Hot enable / disable (step 6).** v1 needs a restart because `tools/list` is static and Claude must reconnect anyway. Accept?
3. **Persisted aggregates (step 7).** Keep a daily usage table so Lifetime and Historical survive restarts (one UPSERT per call, 400 days), or keep the analytics memory-only as the call history is? Recommendation: persist the aggregates, keep the per-call history in memory.
4. **Token ratio (step 1).** Start from 3.5 characters per token and calibrate once against a real Claude usage figure; acceptable as an estimate?
5. **Search keywords in the call history.** The history of searches already stores them in the database; showing them on the Runs rows is consistent. Confirm.
6. **Where the code lives.** `apps/dashboard` (front) and a `packages/dashboard-api` (types shared with the router). OK to add these two workspaces and the front-end dependencies (React, shadcn/Radix, Tailwind, TanStack, Recharts) to the repository?
7. **Remote access.** SSH tunnel only (like the login viewer), or do you want a later option to serve it behind the OAuth front with the same Google sign-in? The second is a bigger security decision and is not planned.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The dashboard widens the attack surface of a router that holds a Docker socket | high | loopback only, single-use token, Host / Origin checks, CSP, listener off by default, no write beyond `adapters.json` and restart |
| Estimated tokens mistaken for exact billing numbers | medium | "~" and tooltips everywhere, documented method, comparisons are the point |
| Front-end dependency weight and supply chain | medium | scripts denied, lockfile, audit job, only built assets in the image |
| In-memory history lost on restart surprises the operator | low | banner, persisted aggregates for the analytics |
| Server-side table queries get slow on a large database | low | indexes on `first_seen`, `last_seen`; paging; the retention bounds the size |
| UI drift from the API | medium | one schema package used by both sides, contract tests |
