# 17 — Dashboard (plan)

> **Related docs:** Load to build or review the operator dashboard. Also load: `03` (config, ops tools, store), `04` (tool outputs), `06` (memory benchmark, which the dashboard must not move), `09` (threat model), `10` (compose, ports), `12` (roadmap). Follow a link only if the task needs it.

**Status: plan, nothing built (2026-10-03). The maintainer answered the open questions the same day; their answers are folded in below and listed in section 12.** Decisions are tagged **DECIDED** (agreed with the maintainer) or **PROPOSED** (recommended, confirm before the step that needs it).

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
| D1 | **On demand, not always running** (the maintainer, 2026-10-03). The dashboard listener is off by default and started by `jobwatch dashboard start`; it stops after an idle timeout or `jobwatch dashboard stop`. | DECIDED |
| D2 | Stack: **React + shadcn/ui + TanStack Table**, built with Vite; TanStack Query for data; shadcn charts (Recharts) for graphs. The two new workspaces `apps/dashboard` and `packages/dashboard-api` and the front-end dependencies are accepted (the maintainer, 2026-10-03). | DECIDED |
| D3 | Layout: a **sidebar** to switch sections (analytics, runs, stored jobs, searches, tools and status) and **tabs** to switch between tools within a section. Stored jobs in a TanStack Table, a **detail panel on the right** on row click. | DECIDED |
| D4 | The calls are **kept in a ring buffer in memory** (the most recent `DASHBOARD_CALL_BUFFER`), and every finished call is also **written to the database with its parameters** (`call_log`), so the buffer is filled again when the router restarts. They are deleted after `CALL_LOG_RETENTION_DAYS` (default 30, the log rotation). Each call keeps its **full parameters JSON object** (D9). | DECIDED |
| D5 | The server part runs **inside the router process** (it owns the memory buffer, the limiter and the registry), on its own listener, never on the MCP port. | PROPOSED |
| D6 | Token counts are **estimates** computed from the size of the text sent to Claude, starting at 3.5 characters per token; the ratio is calibrated later against Claude's own usage data (the maintainer, 2026-10-03). | DECIDED |
| D7 | **Hot reload** of adapters (the maintainer, 2026-10-03): enabling or disabling an adapter from the dashboard (or the CLI) takes effect in the running router without a restart (section 6.4). A "Restart router" button also exists (the maintainer, 2026-10-03). | DECIDED |
| D8 | The daily usage aggregates are **persisted**, so Lifetime and Historical survive a restart; the per-call history stays in memory (the maintainer, 2026-10-03). | DECIDED |
| D9 | The parameters of a call are a JSON object, **bounded in size (16 KB), never written to the logs**. They were kept in memory only (the maintainer, 2026-10-03); **on 2026-10-07 the maintainer decided to store them** in the `detail` column of `call_log`, rotated by `CALL_LOG_RETENTION_DAYS` (30 days to begin with), so the call history survives a restart. What they can hold is unchanged: what the tool schema allows (keywords, filters, ids, board names, limits), and no tool takes a credential. | DECIDED |
| D11 | **Sign-in decisions (the maintainer, 2026-10-03).** The dashboard has its own login screen with a **Sign in with Google** button and reuses the Google OAuth setup of the connector (same project; the client is configurable and defaults to the connector's, `DASHBOARD_OIDC_CLIENT_ID`). **No email allowlist**: who may sign in is decided by the Google OAuth app itself (its test users or its audience). **No extra Nginx layer.** **No sign-in at all when the router runs for local development** (`AUTH=none` on a loopback address): the dashboard opens directly. Timers: the dashboard stops after **30 minutes without a request**; a session lasts until then, with an **8 hour** cap; **writes need a sign-in within the last 10 minutes**. | DECIDED |
| D10 | The dashboard is reached at **`https://<domain>/dashboard`** on the same public domain as the MCP endpoint (the maintainer, 2026-10-03), not through an SSH tunnel. This makes it a public admin surface: it needs its own sign-in and the controls of section 8. | DECIDED, security design PROPOSED |

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
- **Port and public path (D10).** `compose.yml` publishes `127.0.0.1:${DASHBOARD_PORT:-18933}:${DASHBOARD_PORT:-18933}` permanently, next to the front's port; **nothing listens behind it** until `start`. Nginx maps `location /dashboard` to that port (same host, same certificate as the MCP endpoint; `deploy/nginx/` gets the block and a custom 503 page "The dashboard is off. Run `jobwatch dashboard start`."). The listener is mounted under the `/dashboard` prefix, so the app's base path, its API (`/dashboard/api/v1`) and its cookies are all scoped to it. The MCP routes (`/mcp`, `/.well-known`, `/register`, `/authorize`, `/token`, `/callback`) keep going to the OAuth front and are untouched.
- **Starting stays local.** Only someone with shell access to the host can turn the dashboard on (`jobwatch dashboard start`). There is deliberately **no MCP tool and no web endpoint that starts it**: an admin surface that Claude or an HTTP request could open is not acceptable.
- **Idle timeout.** Every authenticated request renews a timer (`DASHBOARD_IDLE_S`, default 1800). When it fires the listener closes. In-memory call history is **not** lost: it belongs to the router, not to the listener.
- **Cost when stopped.** One Unix socket and the ring buffer. No listener, no timers, no static files loaded (they are read from disk per request when running). This keeps the router's RSS where `docs/plans/06` measured it; the step that adds the buffer re-measures it (§10).
- **CLI**: `jobwatch dashboard start [--ttl <minutes>] [--open]`, `stop`, `status` (running or not, URL, expiry, sessions open, requests served).

## 3. Entity boundaries (private vs public)

The dashboard API is a **public surface** for one authenticated operator, but it is still separate from the database. Rules (also `CLAUDE.md` global rule):

- Every endpoint has an explicit **response type** defined once in a new package `packages/dashboard-api` (zod schemas + inferred types) and used by both the server and the UI. A database row (`StoredJobRow`, `UsageEvent`, `CallRecord`) is never serialised as is.
- The list of jobs omits `description`; only the detail endpoint returns it (the same `detail` idea as the MCP tools, so a table of 200 rows is a few kilobytes, not megabytes).
- Never returned: cookies, tokens, the OAuth secrets, `.env` values, the control socket path, container ids, the Docker socket, raw tool arguments (only the argument hash and, for searches, the recorded keywords), browser profile data.
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

1. **Call ring buffer** (`packages/core/src/dashboard/callLog.ts`, D4): the last `DASHBOARD_CALL_BUFFER` calls (default 2000, bounded, about 1 MB), filled from the existing `CallRecorder` hook in `callTool`. Each entry: `id`, `requestId`, `startedAt`, `tool`, `adapter`, `platform`, `code`, `durationMs`, `argsHash`, **`unitsReserved`**, **`unitsSpent`**, **`responseBytes`**, **`estimatedTokens`**, `warnings` count, the recorded **keywords** for search tools, and **`params`**: the validated arguments of the call as a JSON object (D9). `ToolOutcome` gains the new fields; `callTool` already measures the result text for the output ceiling, so the size is free.
   - `params` is the zod-parsed argument object, so it holds only what the tool schema allows (keywords, filters, ids, URLs of boards, limits); no tool takes a credential. It is stored with the call in the `detail` column of `call_log` (migration 12), **not in the logs, not in `memory_report`, not in any MCP result**; `argsHash` stays as before. Each object is capped at 16 KB (a longer value is cut and the entry marked `paramsTruncated`). The row is deleted after `CALL_LOG_RETENTION_DAYS` (the log rotation, 30 days to begin with). The buffer holds the last `DASHBOARD_CALL_BUFFER` calls and is filled from the database when the router starts, so a restart no longer empties it; its memory bound on parameters (4 MiB, the oldest lose theirs first) still applies, and the database keeps them.
   - The detail view shows the object as formatted JSON with a copy button, and a *Run again in Claude* hint is **not** offered (the dashboard never calls a tool).
2. **In-flight calls**: the same buffer marks a call `running` between admission and settle, which gives "active calls" without polling.
3. **Daily aggregates** (D8): a small table `tool_usage_daily (day, tool, platform, calls, errors, bytes, tokens, units, duration_ms_sum)` updated on each call and kept 400 days. It gives the analytics a **Lifetime** and **Historical** view that survives a restart, which the memory buffer cannot. The cost is one UPSERT per call. It holds counts, bytes and durations only, never parameters.
4. **Token estimation** (D6). The router sends Claude the `content[0].text` of each result (the JSON body plus warnings). It cannot run Claude's tokenizer, and the Anthropic count-tokens API needs a key and a network call per result, which is out. The estimate is `ceil(characters / 3.5)` on that text (a first figure for compact JSON in English and French), configurable (`TOKEN_CHARS_PER_TOKEN`), shown with a "~" and explained in the UI. The maintainer will calibrate it later with Claude's own usage data (D6); until then it is an estimate. Because the number is the same function for every call, **comparisons between tools, between `detail` levels and over time are reliable even if the absolute value is off by 10 to 20 %**. A calibration note in the doc records one real comparison against Claude's reported usage when available.
5. **Text kept back** (PROPOSED): for tools that return jobs, the difference between the description length the database holds (`description_chars`) and the text returned (`summary` or `description`) is the volume the `detail` setting kept out of Claude's context. Computed from the job fields the tools already return, in the same hook; shown as "kept back by summaries". This is the dashboard's counterpart of "tokens saved" and the evidence for the `detail: summary` default.

## 5. API (dashboard listener, JSON, versioned `/api/v1`)

All paths are under the `/dashboard` prefix (`/dashboard/api/v1/...`). All `GET` unless noted. Responses use the types of `packages/dashboard-api`.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/overview` | status cards: calls (completed, failed, rate-limited, active), runtime state, uptime, tokens returned, router version |
| `GET /api/v1/calls?since&tool&platform&code&limit&cursor` | page of the ring buffer, newest first |
| `GET /api/v1/calls/:id` | one call (detail view): units, bytes, tokens, warnings count, keywords and **`params`** (the JSON object of D9) |
| `GET /api/v1/usage?bucket=hour\|day&since&until&tool&platform` | time series and per-tool breakdown for the analytics page (§7.1) |
| `GET /api/v1/jobs?q&source&board&found_by&disallowed&from&to&dateField&sort&dir&page&pageSize` | page of jobs **without description**, total count; server-side sort, filter and paging for TanStack Table |
| `GET /api/v1/jobs/:source/:id` | one job with description, summary, outline sections, hints, dates, url, and `foundBy`: the searches that listed it, each with its counts, health and what it did with this job |
| `GET /api/v1/searches?since&until&source` | one row per search: keywords and disallowed terms (lists), runs, jobs found / returned / excluded / new, health (same data as `stored_searches`) |
| `GET /api/v1/searches/:source?keywords=a&keywords=b&disallowed=x&since&until` | one search with its health and its jobs (up to 200, returned first, then discarded); 404 when it did not run in the window |
| `GET /api/v1/docs` | per installed module, enabled or not: description, role, kind, enabled, allowed hosts, and per tool: description, annotations, cost, parameters (from the input JSON Schema), smallest input, examples. No database content |
| `GET /api/v1/tools` | per adapter: id, kind, enabled, tools with parameters (from the catalog), rate usage (hour, day, limit), per-board usage, breaker, session state |
| `PUT /api/v1/adapters/:id` `{ "enabled": bool }` | writes `adapters.json` and **hot-reloads** the registry (D7); answers `{ applied: true, tools: [...added or removed], reconnectNeeded: true }` |
| `PUT /api/v1/adapters/:id/budget` `{ "hourly"?: n, "daily"?: n }` | saves the request budget of an adapter or utility (whole numbers, 0 to 1000000, at least one window) in `<DATA_DIR>/budgets.json`; applies to the next call, no restart. A window an environment variable sets (`<ID>_BUDGET_HOURLY`, `<ID>_BUDGET_DAILY`) is not saved, and when every window asked for is set that way the answer is 409 `env_locked`. Answers `{ id, budget }`; `GET /tools` carries the same `budget` (value, source `env`/`config`/`default`, default, variable name) for every module, enabled or not |
| `DELETE /api/v1/adapters/:id/data` | behind a confirm button: forgets the jobs and searches the adapter stored (`jobs`, `search_runs`, `search_hits` of its platform), so its next call starts fresh; answers `{ id, jobs, searches }` (rows removed). Usage, budgets, the breaker, the call log and the daily analytics are kept: clearing never resets a request budget. Adapters only: a utility stores no jobs |
| `POST /api/v1/router/restart` | behind a confirm dialog: exits the process so `restart: unless-stopped` brings it back; refused while a call is running unless `force` |
| `GET /api/v1/ats-lookups?page&pageSize` | the log of the company lookups (`ats_find`), newest first: company, handles tried, boards found (ATS, handle, jobs, board page) and, per board, `mapped` (the company already has a board on that ATS) |
| `GET /api/v1/company-boards?q&ats&page&pageSize` | the companies mapped to a board, A to Z; `q` matches the company or the board handle |
| `POST /api/v1/company-boards` `{ company, ats, handle }` | maps a company to its board on an ATS (`greenhouse`, `lever`, `ashby`, `teamtailor`; the handle is checked for its shape only); 409 when the company already has a board on that ATS |
| `DELETE /api/v1/company-boards/:id` | forgets a mapping |
| `GET /api/v1/place-lookups?page&pageSize` | the log of LinkedIn place lookups, newest first, each candidate with `saved` (`none`, `same`, `other`) |
| `GET /api/v1/places?q&page&pageSize` | the names remembered for a LinkedIn geoId, A to Z |
| `POST /api/v1/places` `{ alias, id, label? }` | remembers a name for a geoId (replaces an older meaning of the name) |
| `DELETE /api/v1/places/:alias` | forgets a name |
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

- **Sidebar** (shadcn `Sidebar`, collapsible to icons): Overview, Analytics, Runs, Jobs, Searches, Tools & status, Docs, Settings (idle timeout, theme, token ratio, buffer size, read-only display of limits).
- **Tabs** (shadcn `Tabs`) under the header: *All* plus one tab per **enabled** adapter. The selected tab filters the current section by platform and is kept in the URL (`?tool=linkedin`), so a view is a link.
- **Detail panel**: shadcn `Sheet` (side right) or a resizable `ResizablePanel` pair on wide screens, so the table stays visible beside it. Closes with Escape; the selected row is in the URL (`/jobs/linkedin/4000000001`).

### 6.3 Sections

**Overview.** Request health card (completed, failed, rate-limited, cached or stored), live activity card (active calls, queued browser calls, runtime state), then the headline numbers (tokens returned, calls, estimated tokens kept back) and the budget gauges (§7.2). The landing page for "is everything fine".

**Runs (history).** TanStack Table over `/calls`: time, tool, platform, outcome badge, duration, units spent / reserved, size, estimated tokens, keywords. The keywords of a search show on the row (the maintainer, 2026-10-03). A click opens the **detail view** on the right (same panel as a job): all the **parameters of the call as formatted JSON** with a copy button, the units reserved and spent, the size and estimated tokens returned, the warnings count, the argument hash and request id, and for a search a link to the jobs it listed. Filters: tool (also the tab), outcome, time range, a "only slow" and "only failed" toggle. Live badge for running calls. Banner: "kept in memory, cleared when the router restarts".

**Jobs (stored offers).** TanStack Table with server-side data:

| Column | Notes |
|---|---|
| Title, Company, Location | text, sortable |
| Source | badge; the company name of an ATS job is its company (the feed's name, else the board handle capitalised) |
| First seen, Last seen | relative time with an absolute tooltip, sortable |
| Found by (off by default, turn it on in the Columns menu) | one line per list of keywords that found the job, each keyword as its own badge (from `found_by`), cut with an ellipsis so it never grows out of the column; searches that differ only by their disallowed terms share a line, with the terms in its tooltip |
| Size | description characters |
| Link | opens the posting in a new tab (`rel=noopener noreferrer`) |

Column visibility menu, a search box (`q`), filters for source / board / keyword (`found_by`) / date range and `dateField` (first seen, last seen, fetched), page size, keyboard navigation (arrow keys, Enter to open the detail). **Click or Enter on a row opens the detail on the right**: header (title, company, source, board, dates, link), the summary and the outline sections as collapsible blocks, the full description in a scroll area with a copy button, the hints (stack, years, remote, salary) as badges, `found_by`, and the history of the searches that listed it. Description text is untrusted: rendered as plain text, never as HTML.

**Searches.** One row per search. **A search is its platform, its board, its list of keywords (any of which matches) and its disallowed terms**: the same keywords with other terms keep other jobs, so they are another row. For a tool that takes company boards (the ATS adapters and the custom ones) there is **one search per board** and a **Board** column next to the source: `react` on `pennylane` and `react` on `doctolib` are two rows, each with its own counts, health and jobs; a source that is one big board (LinkedIn, Apec, WTTJ) shows a dash. The detail is `/searches/<source>?b=<board>&k=...`, `GET /searches/:source` takes `board`, and the link to the jobs of a search carries the board as the `board` filter of the Jobs page (a chip clears it). Searches recorded before migration 16 mixed the boards of a call and show no board; they age out with `JOB_RETENTION_DAYS`. A row shows the keywords as one badge each, the disallowed terms as badges of their own colour, its **health**, runs, jobs found, discarded, returned, new and last run. Every row is clickable, the ones without keywords too. A click opens a **detail drawer** (`/searches/<source>?k=<keyword>&k=...&d=<term>&d=...`) with the health (found, matched, discarded, returned, new, and a bar of matched against discarded), a link to the list of the jobs it found (the Jobs table with `found_by` once per keyword and `disallowed` once per term, or `no_keywords=1` and `no_disallowed=1` for an empty list), and the jobs themselves, each marked returned, discarded or listed. A discarded job says **which term dropped it and where**, and keeps its **title** (a job dropped by its title is never stored, so the title is recorded with the hit; it shows as plain text with no link, and "Job no longer stored" is only for a job removed by the retention period) ("“manager” in the title", or its stated salary for the salary floor), kept with the search when it ran. **Health** is bad when the search ran at least twice and found nothing (`no_results`), or when at least 5 jobs were found and 80 % or more were dropped by the disallowed terms or the salary floor (`mostly_discarded`); the constants are in `packages/core/src/dashboard/searchHealth.ts`. The Overview has a card with the searches in bad health of the last 7 days. A job's detail has a **Found by N searches** section, closed until it is asked for, that opens a short table of those searches: keywords, disallowed terms, what each did with this job (returned, dropped by which term, or not returned) and a link to the search; the health of a search is not shown there.

**Tools & status.** One card per installed adapter (grouped by enabled and disabled) and one per utility (their own section, with the same switch and budget bars): kind (HTTP, browser), session state with the time it was checked, breaker (open, reason, until), the tools with their parameters, the rate usage bars for the hour and the day, and for an ATS the per-board usage list (busiest first). A **switch enables or disables** the adapter (D7): it writes `adapters.json` and reloads the registry at once; the card shows "applied, reconnect the Claude connector to see the new tool list". A separate *Restart router* action (confirm dialog) stays for the rare case it is needed. When `ADAPTERS` (or `UTILITIES`) is set, the switches of that group are disabled and one warning box at the top of the page says which variable to unset. Each card has one settings icon button, at the right of its header, that opens a menu: **Enable** or **Disable** (greyed out when `ADAPTERS` or `UTILITIES` sets the list), **Budget…** and, for adapters, **Clear stored data…** (a confirmation dialog first).

**Budget.** The Budget dialog edits the hourly and the daily request budget of the module (whole numbers from 0 to 1000000), prefilled with what applies now and showing the default of each. Three layers set a window, the first that has a value winning: the environment (`<ID>_BUDGET_HOURLY`, `<ID>_BUDGET_DAILY`, for example `LINKEDIN_BUDGET_HOURLY`), what was saved here (`<DATA_DIR>/budgets.json`), and the defaults file `packages/mcp-modules/src/budgets.json`, edited by hand. Each window is resolved on its own: when the environment sets one, a warning box in the dialog names the variable and its value, that field is disabled and shows the environment value, and the other field can still be saved; when it sets both, nothing can be saved. A change applies to the next call, with no restart. *Use the defaults* only fills the fields; nothing is saved until *Save*. The numbers are in `docs/environment-variables.md`, "Budgets".

**Docs.** What each tool does, read-only. Two tabs, Adapters and Utilities (`?kind=utilities`); one card per installed module with its description, kind and whether it is enabled (the page shows it, it cannot change it: use Tools & status or the CLI). A card is a TanStack table of its tools; a row opens to the description, the hints (read-only, idempotent, open-world, browser), the allowed hosts, the cost, a **parameter table** (name, type, required, default, allowed values, min, max, description) read from the tool's input JSON Schema by `describeParams` in the SDK, the tool's **examples** and the smallest accepted input (`sampleInput`), each with a copy button. An example is `{ title, prompt, input }`: the `prompt` is a sentence to paste in a Claude session, the `input` the arguments that call sends. Authors write them in the tool definition (`examples`, at most 5, never sent in `tools/list`); the registry check parses every `input` with the tool's own schema, so an example cannot drift. In a generic module the values the reader must replace are `<angle brackets>` (a place, a job title): generic code assumes no market or job family.

**Analytics.** §7.

**Settings.** Idle timeout of this dashboard session, theme, the characters-per-token ratio, and a read-only block of the effective limits (browser memory caps, tab limit, retention).

**ATS discovery.** Two tabs kept in `?view=`. **Log**: what each company lookup (`ats_find`) found, newest first: company, the boards found (ATS badge, handle linked to the public board page, jobs listed) and the handles tried; each board whose company has no board on that ATS yet has an **Assign** button, which maps the company to it (a board that is already mapped says *Mapped*). **Company mapping**: every mapped company (table `company_boards`, migration 13), a search over the company name and the board handle, an ATS filter, **Add mapping** (company, ATS, handle, for a board the lookup did not find) and a remove button. Every ATS tool reads this map first: a company given by name in `boards` is read from its mapped board, which the tool then checks as usual (`ats_find` answers a mapped company from the mapping with no request, unless `refresh` is set); the tool schemas do not change. A company is matched by the slug of its name (`Société Générale` = `societe-generale`); one board per company and ATS. The lookups log (table `ats_lookups`) is cleared with the call log, after `CALL_LOG_RETENTION_DAYS`. The pages of the utilities sit under the **Tools** item of the menu. Runs and Analytics have one **Utility** tab (`?tool=utility`, shown when a utility is enabled) that groups the calls and the usage of every utility together (`role=utility` on `GET /calls` and `GET /usage`); the job searches are left out of it. Utilities (`ats-discovery`, `linkedin-geo`) never get a platform tab on Jobs, Searches or Runs: they fetch no jobs.

**LinkedIn places.** Under the Tools heading, two tabs kept in `?view=`. **Log**: each place lookup (a `linkedin_locations` query, or a LinkedIn search that looked a place name up by itself, with no difference made between them; table `place_lookups`, migration 14, cleared with the call log) with what LinkedIn suggested; a candidate has an **Assign** button (**Use instead** when the name is remembered as another place; *Saved* when it is already this one), which remembers the name looked up for that geoId. **Saved places**: the names remembered for a geoId (the `linkedin.geo:` entries of `platform_memory`, by you or by a search), a search over name, label and geoId, **Add place** (name, geoId, optional label) and a forget button. A saved name is what a LinkedIn search uses as `geo`. Endpoints: `GET /place-lookups`, `GET /places`, `POST /places` (saves, replacing what the name meant), `DELETE /places/:alias`. A page whose utility is not enabled says so.

**Custom adapters.** Under the Tools item. A table of the adapters an operator wrote (name, tool, context, host, last change, a switch, edit and delete), a **Create adapter** button, and a modal with the name, the handle (fixed once created), the context (**HTTP** or **Browser**, which decides the globals the script gets), the URL target (the one https host it may reach) and the script in a small built-in editor (syntax colours, Tab indents, Enter keeps the indentation; no dependency). A new adapter starts from the `read(board, filters)` function alone, documented with JSDoc (`@param`, `@returns`; the editor sets the `@tags` apart) and with its body left to write. The rest of the documentation is a **reference** between the *Script* title and the editor, collapsed until the book icon next to the title is pressed: one table for each object or type a script uses (**Globals**, **Http**, **Response**, **Filters**, **Posting**, **Result**, and **Session** for the browser context), with a row for each attribute (name, short type, required or optional) that opens into a description list (name, description, type in full), as the API reference of Base UI does. The reference comes from the router (`scriptDocs` in `packages/core/src/custom/docs.ts`, in the answer of `GET /custom-adapters/sample/:kind`), next to the code it describes, and a test checks that its `Posting` fields are the ones the router validates. An adapter can be changed later (the new script applies to the next call) and its history (who, what, the hash of the script) is in the modal. Everything is refused, with the reason on the page, unless `CUSTOM_ADAPTERS=on`. Endpoints: `GET /custom-adapters`, `GET /custom-adapters/:handle`, `GET /custom-adapters/sample/:kind`, `POST /custom-adapters`, `PUT /custom-adapters/:handle`, `PUT /custom-adapters/:handle/enabled`, `DELETE /custom-adapters/:handle`; the writes need a recent sign-in.

### 6.4 Hot reload of adapters (D7)

Today the registry is built once at startup (`loadModules` in `apps/mcp/src/server.ts`) and handed to the MCP server, the guard and the context provider. Hot reload makes it a **replaceable holder**:

- `RegistryHolder.current()` returns the live registry; `reload(ids)` builds a new one with `loadModules`, validates it fully **before** swapping (a failing adapter leaves the old registry in place and returns the problems), then swaps atomically. The MCP server, `callTool`, the rate-limit policy (`policyFor`) and `memory_report` read through the holder on every request instead of capturing the registry.
- **A call in flight keeps the registry it started with**; the next request sees the new one. A disabled browser adapter's running lease finishes normally; its runtime then idles out as usual.
- The server is **stateless** (no sessions, no server-to-client channel), so the router cannot push `notifications/tools/list_changed`. Claude sees the new tool list when its connector refreshes or reconnects; the response of the switch says so (`reconnectNeeded`). This is a property of the stateless design, not of hot reload.
- The same `reload` is called by the CLI (`jobwatch adapters enable|disable`) through the control socket when the router is running, so the two paths agree; without a router the CLI keeps writing the file as today. `ADAPTERS` still pins the list: reload is refused with the reason.
- The `tools/list` snapshot test and the static-schema rule are unchanged: `tools/list` is still answered from the current registry without starting a container.

### 6.5 As built (step 5)

`apps/dashboard` (Vite, React 19, Tailwind 4, shadcn-style components written into `src/components/ui`, TanStack Table 8, TanStack Query 5, React Router 8, Radix tabs/dialog/switch; `lucide-react` icons). TanStack Table is pinned to **8.21**: the current major (9) has a different API and is not used. It builds to `dist/apps/dashboard` with base `/dashboard/`; the router image copies that folder to `/app/dashboard` and sets `DASHBOARD_STATIC_DIR`. The shell has the sidebar (Overview, Analytics, Runs, Jobs, Searches, a **Tools** menu item, open at first, that folds and unfolds the pages of the utilities under it (ATS discovery, LinkedIn places), Docs, Settings; Settings has two tabs, Settings and Tools & status, kept in `?view=`, and `/tools` leads to the second), a header (idle-stop time, connection badge, theme toggle, sign-out) and tabs for the enabled platforms kept in `?tool=`. Overview and Runs are complete (the table, the right-hand detail with the call parameters as formatted JSON and a copy button, Enter to open and Escape to close, the outcome filter); the other sections show a "not built yet" page. **Jobs** is a server-side TanStack Table (manual sorting, paging and filtering; the filters, sort and page live in the URL): title, company, salary (a fixed value or a range, sortable, jobs without one last), place, source, first and last seen, the keywords that found each job and the text size, a column menu, a search box that waits for the typist, filters for date range (on first seen) and for the search a link of the Searches page names, 10 to 100 rows per page, arrow keys and Enter on rows, and a link to the posting that is only offered for `https` addresses (opened with `rel="noopener noreferrer"`). A click opens the detail on the right: dates, the keywords that found it, hints, the summary, the sections and the whole description as text with a copy button. **Searches** lists each keyword with its runs, jobs found, returned and new, a bar for the share that was new, and a click opens the Jobs table filtered on that keyword. **Tools & status** shows the browser state and one card per installed adapter, enabled first: kind, session state as `session_status` last found it (the dashboard never runs a check, so it can say "not checked"), an open breaker, the rate usage of the hour and the day, the company boards of an ATS with their own usage, the tools with their parameters and the hosts. Each card has a switch that calls `PUT /adapters/:id`: the file is written and the registry hot-reloaded at once, and the page says which tools appeared and that the Claude connector must reconnect. A refusal (list pinned by `ADAPTERS`, adapter not loadable, in which case the file is put back) is shown on the card; "sign in again" sends the browser through Google with `reauth=1`. *Restart router* asks first, is refused while a call is running (with a *Restart anyway*), and the page reconnects by itself. **Analytics** follows section 7: a Session | Lifetime | Historical switch (Historical takes a date range), request health and live activity, three headline cards (tokens returned, calls with the error rate, job text kept back by summaries), duration, throughput and time per tool, token usage, what each tool returned, tokens over time (a chart with a table alternative), a per-tool table, the rate budgets with the company boards closest to their limit, and the keywords that brought the most new jobs and those that found nothing new (a click opens the jobs of a keyword). Session reads the calls in memory (by the hour, with percentiles); Lifetime and Historical read `tool_usage_daily` (by the day; durations are averages and a maximum, so no percentiles). Every token figure is marked as an estimate. The ESLint config forbids `dangerouslySetInnerHTML`, `innerHTML` writes and any import but `@jobwatch/dashboard-api` in this app, and a test renders a hostile string as text. The login page is served by the router (no script), not by this app.

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

The dashboard exposes job-search data, the parameters of every call and a switch that changes which adapters are on. Reached at `https://<domain>/dashboard` (D10) it is a **public admin surface** on a host whose router holds the rootless Docker socket. The design below is the minimum; section 12 lists what still needs the maintainer's agreement.

- **Off unless started, started only from the host.** The listener does not exist until `jobwatch dashboard start`, and nothing remote can start it (section 2). When it is off, `/dashboard` answers a static 503 from Nginx.
- **Its own sign-in with Google, and an allowlist.** The OAuth front cannot be reused for the dashboard, but the **Google OAuth setup can** (verified 2026-10-03, section 8.1). The dashboard therefore does an OpenID Connect login itself, with its own login screen, using a Google OAuth client and one added redirect URI `https://<domain>/dashboard/auth/callback`: authorization code flow with PKCE, `state` and `nonce`, ID token checked (issuer, audience, signature, expiry), **`email_verified` true**. There is **no email allowlist** (D11): the Google OAuth app decides who can sign in, so keep it in Testing status with only your account as a test user, or the dashboard is open to every Google account the app admits.
- **Session.** After the callback the dashboard sets a random session id in a `Secure`, `HttpOnly`, `SameSite=Strict` cookie scoped to path `/dashboard`, kept server-side in memory (so a restart signs everyone out). There is no separate session idle timer (D11): the session lasts until the dashboard stops (30 minutes without a request) with an absolute cap of 8 hours, and `dashboard stop` revokes all of them. No token is ever placed in a URL.
- **Writes need a recent sign-in** (D11). `PUT /adapters/:id`, `PUT /adapters/:id/budget`, `DELETE /adapters/:id/data` and `POST /router/restart` are refused unless the session authenticated within the last 10 minutes (OIDC `max_age`); otherwise the UI sends the user through Google again. A stolen idle session cannot change the router.
- **CSRF and origin.** Every non-GET request needs a custom header the app sets, an `Origin` equal to the configured public origin, and the `SameSite=Strict` cookie. `Host` must equal the configured public host (no DNS rebinding, no open Host).
- **Brute force.** Per-IP rate limiting on the login routes (the real client address comes from the `X-Forwarded-For` that Nginx overwrites, trusted only from `TRUSTED_PROXY_CIDRS`), constant-time checks, a generic error for a refused email.
- **Headers.** Strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses, HSTS inherited from the site, no CORS.
- **Nginx.** The `/dashboard` block adds its own request-rate limit, `client_max_body_size 64k`, and does not buffer the optional SSE stream; the WAF/allowlist rules of `docs/plans/10` are unchanged for the MCP paths.
- **What the API never returns** (section 3), and in particular: the call `params` come only from the in-memory buffer (D9), only on the detail endpoint, never in a list response, never persisted.
- **Untrusted text.** Job text, company names, keywords and call parameters come from third-party sites or from Claude: rendered as text by React (no `dangerouslySetInnerHTML`; a lint rule forbids it), links only `https:` with `rel="noopener noreferrer"`.
- **Writes.** Four, all inside the router's own data (`adapters.json`, `budgets.json`, the job store) or process (reload, restart). None touches a third-party platform, so the read-only rule of the project is untouched; each is logged with the actor's email and the action, no secret.
- **No Docker surface.** The dashboard process has no endpoint that reaches the Docker API, and the runtime manager is not callable from it except through the existing read-only `status()`.
- **One new secret.** The sign-in needs a Google client secret in the router's environment, where today only the OAuth front holds one. Preferably a **separate Google OAuth client for the dashboard** (its own secret and redirect URI), so a leak of one does not affect the connector (§12.3). Adding it to the router is a change to what the router holds, so it needs the maintainer's agreement (`docs/plans/09`).
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

### 8.2 Checklist run (2026-10-03)

| Control | Result | Evidence |
|---|---|---|
| Off unless started, started only from the host | pass | `manager.test.ts`, `reload.test.ts` (closed at startup, opens on `dashboard.start`, closes on stop, idle and shutdown); no MCP tool and no route starts it; `tests/dashboard/smoke.mjs` |
| Own Google sign-in: code flow, PKCE S256, `state` bound to the browser, `nonce`, ID token verified, `email_verified` | pass | `dashboard.test.ts` against a fake Google: forged state, forged nonce, other audience, unverified or missing `email_verified`, expired token, forged code, replayed state are all refused with no session |
| No email allowlist: the Google app decides | by decision (D11) | keep the Google app in Testing status with only the operator as a test user |
| Session cookie `HttpOnly`, `Secure`, `SameSite=Strict`, path `/dashboard`, in memory, 8 hours, revoked by stop | pass | `dashboard.test.ts`, `manager.test.ts` |
| Writes: CSRF header, exact Origin, sign-in within 10 minutes | pass | `dashboard.test.ts` (header, Origin, window), `reload.test.ts` (live), the smoke script |
| Host must be the public host (no DNS rebinding) | pass | `dashboard.test.ts`, smoke script (421) |
| Headers: CSP `default-src 'self'` and `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `no-store`, no `X-Powered-By` | pass | `dashboard.test.ts`, smoke script |
| Responses cannot leak a field: every one is parsed by a strict schema; lists carry no job text and no parameters; settings carry no secret | pass | `packages/dashboard-api` tests, `dashboard.test.ts` leak tests |
| Parameters of a call: memory only, 16 KB per call, 4 MiB in total, never in the database, a log line, `memory_report` or an MCP result | pass | `call.test.ts`, `callLog.test.ts`, `server.test.ts`; `tool_usage_daily` has no parameter column (`store.test.ts`) |
| Untrusted text rendered as text, never HTML | pass | ESLint forbids `dangerouslySetInnerHTML` and `innerHTML` in `apps/dashboard`; tests render hostile call parameters and job descriptions |
| Links to postings only `https`, opened with `rel="noopener noreferrer"` | pass | `Jobs.test.tsx` |
| The front end imports only `@jobwatch/dashboard-api` | pass | ESLint `no-restricted-imports` and the Nx module boundaries (`type:ui`) |
| No Docker endpoint; writes limited to `adapters.json`, the reload and a restart | pass | `writes.ts` is the only writer; nothing in the dashboard imports the runtime beyond its read-only `status()` |
| Client secret not logged | pass | `config.test.ts` (`describeConfig` redacts it); the config is the only place it is read |
| Dependencies: scripts denied, lockfile, audit | pass | `allowScripts` unchanged; CI runs `npm audit --omit=dev --audit-level=high` (0 vulnerabilities today) and `npm run build` |
| Nginx: own rate limit, small body, off-page while closed | pass | `nginx -t` on `deploy/nginx/mcp.example.com.conf` with throwaway certificates |
| Real Google sign-in behind Nginx on the host | **not done** | needs the deployed domain and the redirect URI added in Google Cloud Console |
| Penetration-style tests from outside (scan, brute force) | **not done** | for the operator's Phase 4 security checklist |

## 9. Testing

- **API**: vitest against the real handlers with an in-memory `Store`; every endpoint's response is parsed by its `packages/dashboard-api` schema (contract test), and a **leak test** serialises each response and fails on any forbidden key (`cookie`, `token`, `secret`, `password`, `authorization`, `argsHash` outside the call detail, container ids, the control socket path).
- **Ring buffer**: capacity, eviction order, running → settled transitions, concurrent calls, `params` kept as the parsed object, cut at 16 KB with `paramsTruncated`, and **never** present in `call_log`, the logs, `memory_report` or any list response.
- **Lifecycle and auth**: start / stop / idle timeout (fake clock), a second `start` while running returns the same URL, a stopped listener refuses connections; with a fake OIDC provider: wrong `state`, wrong `nonce`, bad signature, expired token, unverified email and an email outside the allowlist are all refused, an allowed email gets the cookie, a write with a stale sign-in is refused, wrong Host and wrong Origin are refused, `dashboard start` with an empty allowlist fails.
- **Hot reload**: a failing adapter leaves the old registry; a call in flight keeps its registry; `tools/list` reflects the new one on the next request; `ADAPTERS` refuses the reload; the guard's policy follows the swap.
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
| 0 | `docs/dashboard-plan` (merged), `docs/dashboard-plan-decisions` | this document, then the maintainer's answers folded in | maintainer agrees with the security design of section 8 |
| 1 | `feat/dashboard-call-log` | `ToolOutcome` gets sizes, units, estimated tokens and `params`; the call ring buffer; the token estimator; `memory_report` unchanged | unit tests; RSS recorded; leak tests for `params` |
| 2 | `feat/hot-reload-adapters` (**built**) | `RegistryHolder`; the MCP server, `callTool`, guard policy and `memory_report` read through it; control socket (reused by step 4); CLI `adapters enable\|disable` reloads a running router | reload tests of section 9; a live reload on a real router |
| 3 | `feat/dashboard-api` (**built; not mounted yet, step 4 starts it**) | `packages/dashboard-api` types; the listener under `/dashboard`; OIDC sign-in, sessions, headers, CSRF, allowlist; read endpoints (`overview`, `calls`, `jobs`, `searches`, `tools`, `usage`); `Store.listJobs` gains `q`, sort and offset; leak and contract tests; the **VERIFY** on the front | auth tests green; leak test green |
| 4 | `feat/dashboard-lifecycle` (**built**) | `jobwatch dashboard start\|stop\|status`; idle timeout; compose port; Nginx `/dashboard` block and 503 page; config keys; docs `03`, `09`, `10`, README | start / stop proven in a real container behind Nginx |
| 5 | `feat/dashboard-ui-shell` (**built**: shell, Overview, Runs; the other pages say they are not built yet) | `apps/dashboard`: Vite, Tailwind, shadcn, router, sidebar, tool tabs, Overview and Runs with the parameters detail view; served by the listener; image build copies `dist` | opens from `dashboard start`; Runs shows live calls and their parameters |
| 6 | `feat/dashboard-jobs` (**built**) | Jobs table (TanStack Table, server-side) and the right-hand detail; Searches | click a row, read the full description |
| 7 | `feat/dashboard-tools` (**built**) | Tools & status; `PUT /adapters/:id` with hot reload; the *Restart router* action | enable / disable takes effect without a restart |
| 8 | `feat/dashboard-analytics` (**built**) | Analytics page; daily aggregates table; Session / Lifetime / Historical | all panels of section 7 populated from real calls |
| 9 | `feat/dashboard-hardening` (**built**) | security checklist run (section 8), `npm audit` CI job, smoke script, measurements, docs `09` | checklist ticked |

Each step ends with `npm run ci` green and the docs updated in the same PR.

## 12. Maintainer's answers (2026-10-03) and what is still open

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
2. **Allowlisted email(s)** for `DASHBOARD_ALLOWED_EMAILS`: the same Google account as the connector, or others?
3. **Google client secret in the router's environment.** The sign-in needs it in the router, which today only the OAuth front holds. A separate Google OAuth client for the dashboard (own secret, own redirect URI, so a leak does not affect the connector) is the cleaner choice. Do you want a second client?
4. **Public admin surface.** With D10 the dashboard is reachable from the internet whenever it is on. The plan keeps it off by default, started from the host only, behind its own Google sign-in and an allowlist. If you would rather add a second layer (an Nginx IP allowlist for your own addresses, or HTTP basic auth in front), say so; it costs a few lines in the Nginx block.
5. **Timers** (see the explanation below): the plan has three; the recommendation is to reduce them to two.

**Recent sign-in, explained.** Being signed in to the dashboard lets you read. Four actions change the router: enabling or disabling an adapter, changing its budget, clearing its stored data and restarting it. "Recent sign-in" means those actions are only accepted if you authenticated with Google within the last N minutes; if you signed in earlier, the dashboard sends you through Google again (one click when you already have a Google session) and then performs the action. The point is that a session left open on a shared screen, or a stolen cookie, can read but cannot change anything. With 10 minutes you sign in once, browse, and the first change after a long browse asks you to confirm. Off means any open session can write.

**The timers, explained.** They are independent:
1. **Listener idle stop (30 min).** If nobody calls the dashboard for 30 minutes the whole dashboard shuts down: `/dashboard` goes back to the 503 page and `jobwatch dashboard start` is needed again. Every request resets the countdown.
2. **Session idle timeout (30 min).** Your browser cookie for the dashboard (not the Google or the Claude connector sign-in). After 30 minutes without a request it is no longer valid and you sign in again.
3. **Session absolute lifetime (8 h).** Even if you keep using it, the cookie ends 8 hours after sign-in.
They are unrelated to the Claude connector's OAuth tokens (1 h access, 7 d refresh), which belong to the OAuth front and are not touched. Because timer 1 already turns the dashboard off when idle, timers 2 and 3 mostly overlap with it. Recommendation: keep timer 1 at 30 minutes (adjustable with `dashboard start --ttl`), make the session last until the dashboard stops with a cap of 8 hours, and drop the separate session idle timer. That leaves two numbers to think about.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The dashboard is a public admin surface on a router that holds a Docker socket | high | off by default and started only from the host; own Google sign-in without an email allowlist (the Google app decides); recent-sign-in rule for writes; Host / Origin / CSRF checks; CSP; no Docker endpoint; writes limited to `adapters.json`, reload and restart; optional Nginx IP allowlist (§12.4) |
| Call parameters in the call log could contain something sensitive | medium | schema-validated arguments only (no tool takes a credential), 16 KB cap, never in the logs, deleted after `CALL_LOG_RETENTION_DAYS`, detail endpoint only; accepted by the maintainer, 2026-10-07 |
| Hot reload swaps the registry under load | medium | validate before swap, in-flight calls keep their registry, atomic swap, tests of section 9 |
| Estimated tokens mistaken for exact billing numbers | medium | "~" and tooltips everywhere, documented method, comparisons are the point |
| Front-end dependency weight and supply chain | medium | scripts denied, lockfile, audit job, only built assets in the image |
| In-memory history lost on restart surprises the operator | low | banner, persisted aggregates for the analytics |
| Server-side table queries get slow on a large database | low | indexes on `first_seen`, `last_seen`; paging; the retention bounds the size |
| UI drift from the API | medium | one schema package used by both sides, contract tests |
