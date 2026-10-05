# jobwatch-mcp

A self-hosted **MCP server** that lets AI Agents search job boards for you.

It exposes a small set of **read-only, task-level tools** (LinkedIn, Apec, Welcome to the Jungle and the public job boards of Teamtailor, Greenhouse, Lever and Ashby) over a public HTTPS.

- **Read-only by construction.** No tool posts, applies, messages or edits anything on a third-party site. There is no generic `navigate`, `click` or `evaluate` tool: only the tools in the catalog exist.
- **Light on the host.** Sites that need a browser use one headful Chrome container at a time, started on the first call and stopped after an idle period, with a hard memory cap. Plain HTTP sources need no browser.
- **Polite to the sites.** Every platform has an hourly and a daily budget, ATS company boards have a budget each, and calls are paced.
- **Yours only.** Sign-in goes through your own identity provider (Google), restricted to the accounts you allow.

How the parts fit together: [`docs/architecture.md`](docs/architecture.md).

## Contents

1. [Install](#install)
2. [Configure the OAuth provider](#configure-the-oauth-provider)
3. [Connect Claude](#connect-claude)
4. [Modules](#modules)
5. [Log in to the sites that need it](#log-in-to-the-sites-that-need-it)
6. [Operator dashboard](#operator-dashboard)
7. [Commands](#commands)
8. [Tools and example queries](#tools-and-example-queries)
9. [Configuration reference](#configuration-reference)
10. [Development](#development)

## Install

### From source

You need **Node 26** and npm.

```bash
git clone git@github.com:mnogueron/jobwatch-mcp.git && cd jobwatch-mcp
npm install
npm run build
npm run start
```

The MCP server is started on `http://127.0.0.1:18931/mcp`.

#### Use the CLI

The CLI can be used straight from the repo, without Docker:

```bash
npm run jobwatch -- adapters list
```

### With Docker Compose

`compose.yml` declares the always-on services: the OAuth front, Redis and the router. Browser containers are never declared there; the router starts them itself.

**Host prerequisites.** Docker with Compose, ideally **rootless Docker for a dedicated user** (the router gets that user's socket and nothing more; never mount a root Docker socket). About 2 GB of free RAM while a browser runs. To use it from Claude on the web or desktop you also need a domain name with TLS in front of the front's published port ([reverse proxy](docs/reverse-proxy.md)). The full host setup (rootless Docker, cgroup v2, certificates) is in [`docs/plans/10-deployment.md`](docs/plans/10-deployment.md).

1. Create a folder and copy [`deploy/compose.yml`](deploy/compose.yml) into it.
2. Create a `.env` file next to it (`chmod 600 .env`; it holds secrets once you add OAuth, never commit it):

```bash
JW_REGISTRY=registry.example.com         # where the router image is pulled from
```

3. Start it (Compose reads `.env` by itself):

```bash
mkdir -p data
docker compose up -d
docker compose ps
docker compose logs -f router
```

| Variable | Meaning |
|---|---|
| `JW_BASE_URL` | Public URL of the server, e.g. `https://mcp.example.com` (default `http://127.0.0.1:18931`) |
| `JW_REGISTRY`, `JW_TAG` | Where the router image is pulled from (or build it locally, see above) |
| `JW_BIND`, `JW_HOST_PORT` | Where the front is published for your reverse proxy (default `127.0.0.1:18931`) |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TOKEN_SIGNING_SECRET` | Only with OAuth: see [Configure the OAuth provider](#configure-the-oauth-provider) |
| `JW_PROXY_CIDR` | Address of your reverse proxy as the front sees it (default `172.17.0.1/32`, the Docker gateway) |
| `JW_DOCKER_SOCKET` | Docker socket to mount; empty = `$XDG_RUNTIME_DIR/docker.sock` (Linux rootless). macOS: `/var/run/docker.sock` |
| `JW_BROWSER_IMAGE`, `JW_BROWSER_LANG`, `JW_BROWSER_ACCEPT_LANGS` | The browser image and the language list of your everyday browser |

The router keeps its data (enabled modules, stored jobs) in `./data`. To update: `docker compose pull router && docker compose up -d router` (or run [Watchtower](docs/watchtower.md)).

**Trying it on a laptop, without OAuth.** `deploy/compose.dev.yml` runs only the router (built from this repo), on `http://127.0.0.1:18932/mcp` with **no authentication** (accepted only on a loopback address), so no Google client is needed. Never expose that port.

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up router
claude mcp add --transport http jobwatch-dev http://127.0.0.1:18932/mcp
```

Every `jobwatch` command below runs inside the router container:

```bash
alias jobwatch='docker compose exec router jobwatch'
```

## Configure the OAuth provider

The front uses Google only to **authenticate you**; access control is the Google app itself. While the app is in **Testing** status only the test users you list can sign in.

1. Google Cloud Console: create a project, then **APIs & Services → OAuth consent screen**. User type **External**, scopes `openid`, `email`, `profile`, and add **only your own account as a test user**.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<your domain>/callback`.
3. Add the client ID and secret to `.env` as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, generate `TOKEN_SIGNING_SECRET` with `openssl rand -base64 48` (keep it identical across restarts), and set `JW_BASE_URL` to your public URL.
4. Set up a reverse proxy in front of the front's published port (`127.0.0.1:18931` by default): [`docs/reverse-proxy.md`](docs/reverse-proxy.md).
5. Start the stack (`docker compose up -d`) and test: a second Google account must be refused by Google ("access blocked").

Rotating `TOKEN_SIGNING_SECRET` invalidates every issued token: remove and re-add the connector in Claude afterwards. Details and the threat model: [`docs/plans/10-deployment.md`](docs/plans/10-deployment.md) and [`docs/plans/09-security.md`](docs/plans/09-security.md).

## Connect Claude

- **Claude (web or desktop)**: *Settings → Connectors → Add custom connector*, URL `https://<your domain>/mcp`. Claude registers itself with the front, you sign in with Google, and the tools appear. Authentication settings cannot be edited later: remove and re-add the connector if you change them.
- **Claude Code**: `claude mcp add --transport http jobwatch https://<your domain>/mcp`, then authenticate from `/mcp`.

After pulling a new router image, or enabling or disabling a module, reconnect the connector so Claude reloads the tool list. Check the server from Claude by calling `memory_report` (runtime state, rate-limit usage, recent calls) or `session_status`.

## Modules

The tools come from **modules**. An **adapter** fetches jobs from a platform. A **utility** is a helper module whose tools fetch no jobs; it is HTTP only (no browser, no login). Both have their own host list and request budget. Nothing is enabled by default; enable the modules you want, then **reconnect the Claude connector** so it sees the new tools (the same after disabling one).

```bash
jobwatch adapters list                       # every installed adapter and whether it is enabled
jobwatch adapters list --tools linkedin      # the tools of an adapter with their parameters (what Claude will see)
jobwatch adapters enable apec wttj teamtailor greenhouse lever ashby
jobwatch adapters disable linkedin

jobwatch utilities list [--tools] [--json] [<id...>]
jobwatch utilities enable linkedin-geo ats-discovery
jobwatch utilities disable ats-discovery
```

Setting `JW_ADAPTERS=apec,wttj` (or `JW_UTILITIES=...`) in the environment pins the list and makes it read-only.

| Adapter id | Tools | Needs |
|---|---|---|
| `linkedin` | `linkedin_search`, `linkedin_job` | A signed-in browser session. Strict budget: check [`docs/plans/09-security.md`](docs/plans/09-security.md) before enabling. |
| `apec` | `apec_search`, `apec_job` | A browser (no login). Apec blocks plain HTTP. |
| `wttj` | `wttj_matches`, `wttj_job` | A signed-in browser session. |
| `teamtailor` | `teamtailor_jobs` | Nothing (HTTP). Any Teamtailor board, by handle or URL. |
| `greenhouse` | `greenhouse_jobs` | Nothing (HTTP). |
| `lever` | `lever_jobs` | Nothing (HTTP). |
| `ashby` | `ashby_jobs` | Nothing (HTTP). |

| Utility id | Tools | What it does |
|---|---|---|
| `linkedin-geo` | `linkedin_locations` | Finds the geoId of a place and remembers names for places; enable it next to `linkedin`. |
| `ats-discovery` | `ats_find` | Finds which ATS (Greenhouse, Lever, Ashby, Teamtailor) hosts a company's careers board and the handle to give to the matching `*_jobs` tool. |

The built-in tools (`session_status`, `memory_report`, `stored_jobs`, `stored_searches`, `stored_job_texts`) are always available: see [`docs/built-in-tools.md`](docs/built-in-tools.md).

## Log in to the sites that need it

LinkedIn and Welcome to the Jungle need a session you open by hand once; the browser profile then keeps it. Apec and the ATS boards need no login.

```bash
jobwatch login start linkedin        # starts a visible browser on the site's profile, prints a password
```

1. From your laptop, open the tunnel the command prints: `ssh -L 6080:localhost:6080 <user>@<host>`.
2. Open `http://localhost:6080/vnc.html` and connect with the printed password (the viewer listens on the host's loopback only).
3. Sign in by hand (captcha, phone confirmation), then browse once to a page that needs the session.
4. Stop it so the router can use the profile: `jobwatch login stop linkedin`.
5. Check it from Claude: call `session_status` with `platform: "linkedin"` (`ok`, `needs_login` or `checkpoint`).

If a site shows a security check (`checkpoint`), stop, wait at least 24 hours and lower the budget; the router never tries to get around it. Browser profiles are Docker volumes named `jw-profile-<platform>`: never put them in git or in a plain backup.

### Use your own Chrome instead of the Docker image

By default the browser modules (`linkedin`, `apec`, `wttj`) run in a Chrome container. For development on your own machine you can use a Chrome without Docker, in one of two ways. `npm run dev` and `npm run start` use a local Chrome by default (`JW_LOCAL_CHROME=true` in `.env.local`); the Docker Compose deployment keeps the container:

- **`JW_LOCAL_CHROME=true`**: the server starts a visible Chrome itself, the way Playwright does, and stops it after the idle period. Each platform gets its own profile in `<JW_DATA_DIR>/browser-profiles/`, so a sign-in survives restarts. Chrome is looked for in the usual places; set `JW_LOCAL_CHROME_PATH` to use another executable. Close any Chrome that already uses that profile directory.
- **`JW_CDP_URL=http://127.0.0.1:9222`**: the server attaches to a Chrome that is already running. Start it with its DevTools port open and a profile directory of its own (Chrome ignores the port on its default profile):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.jobwatch-chrome"
```

In both cases you sign in to the sites yourself in that browser (no `jobwatch login`, no noVNC). The server opens a tab of its own for each call and closes it afterwards: **it never closes, navigates or blocks your other tabs**, and it never quits an attached Chrome. Only loopback DevTools URLs are accepted. The memory cap, the fingerprint check and the one-browser-at-a-time rule for containers do not apply to a browser that is not ours.

## Operator dashboard

A web interface for the operator: the history of calls (with their parameters), the stored jobs, the searches, the state of each tool and its rate usage, and the estimated tokens returned to Claude. It is **closed by default**: nothing listens until you start it on the host, and it closes by itself after 30 minutes without use.

```bash
jobwatch dashboard start        # prints the address, e.g. https://<your domain>/dashboard
jobwatch dashboard status
jobwatch dashboard stop
```

Signing in uses Google, with the same OAuth client as the connector by default: add `https://<your domain>/dashboard/auth/callback` to that client's authorized redirect URIs in Google Cloud Console. The Google app decides who can sign in (keep it in Testing status with only your account as a test user); the dashboard has no allowlist of its own. Changes made from the dashboard need a sign-in within the last 10 minutes. When the router runs for local development (`JW_AUTH=none`, see `deploy/compose.dev.yml`) there is no sign-in and it is at `http://127.0.0.1:18933/dashboard/`. Behind a reverse proxy, route `/dashboard` to the dashboard port (`deploy/nginx/mcp.example.com.conf` already maps it for Nginx; see [`docs/reverse-proxy.md`](docs/reverse-proxy.md)). The interface is a React app in `apps/dashboard` (`npm run build` produces it; `npm run dev -w @jobwatch/dashboard` serves it with hot reload and proxies the API to a dashboard started on `127.0.0.1:18933`). The design is in [`docs/plans/17-dashboard.md`](docs/plans/17-dashboard.md).

## Commands

### `jobwatch` (inside the router container, or `npm run jobwatch --` from the repo)

| Command | What it does |
|---|---|
| `adapters list [--tools] [--json] [<id...>]` | Installed adapters and whether each is enabled. `--tools` adds every tool with its parameters (required ones starred, defaults, cost); `--json` gives the full catalog entries; ids narrow the list. |
| `adapters enable <id...>`, `adapters disable <id...>` | Enable or disable adapters. |
| `utilities list\|enable\|disable ...` | The same for utilities. |
| `login start <platform> [--port 6080]` | Start a visible browser on the platform's profile to sign in by hand (noVNC on loopback). |
| `login stop <platform>` | Stop it; the profile keeps the session. |
| `linkedin-geo <text> [--save <name> [--pick <n>]]`, `linkedin-geo --list`, `linkedin-geo --forget <name>` | Find the LinkedIn geoId of a place (the candidates with their ids), remember a name for one, list or forget the remembered names. Needs the `linkedin-geo` utility. |
| `dashboard start [--ttl <minutes>]` | Open the operator dashboard on the running router (closed by default; it closes after 30 minutes without use). |
| `dashboard stop` | Close it and end every session. |
| `dashboard status` | Is it open, where, and when it closes. |
| `doctor` | Check configuration, data directory, Docker, images, network and profiles. |
| `--help`, `--version` | |

Exit codes: 0 ok, 1 usage or configuration error, 2 an installed adapter is broken or Docker failed.

### Repo scripts

| Script | What it does |
|---|---|
| `npm run ci` | Format check, lint (including the architecture rules), typecheck and tests. Must pass before a PR. |
| `npm run lint`, `typecheck`, `test`, `build` | One step of the above. |
| `npm run format` / `format:check` | Prettier. |
| `npm run catalog:gen` | Regenerate every adapter's `catalog/` snapshot after changing a tool definition. |
| `npm run new:adapter -- <id> [--kind http\|browser]` | Scaffold a new adapter package. |
| `npm run new:utility -- <id>` | Scaffold a new utility package (always HTTP). |
| `npm run test:integration` | Drive a real browser container (needs Docker; never in CI). |
| `npm run test:dashboard` | Smoke-test the built router and dashboard (run `npm run build` first; not in CI). |
| `npm run dev` | Run the server from the sources with watch and restart, configured by `.env.local`. |
| `npm run jobwatch -- <args>` | Build and run the CLI. |

## Tools and example queries

Every example is the argument object Claude sends to the tool. The text of a job is returned as a short `summary` by default; ask for `detail: "full"` only when you need the whole description, or read chosen jobs later with `stored_job_texts`.

**Arguments shared by the search and board tools.** `max_results` is the most results examined and returned. `detail` is `summary`, `full` or `none`, and `description_max_chars` caps the text. `disallowed_terms` drops jobs whose title (and, with `disallowed_scope: "title_then_description"`, whose description) contains one of the words. `min_salary` with `salary_currency` (an ISO code) drops jobs whose text states a yearly salary below the floor in that currency; jobs that state none, or in another currency, are kept (`LinkedIn`, `WTTJ` and the company-board tools). `posted_within` is `last_24_hours`, `past_week`, `past_month` or `any`. A call that ends with a non-empty `remaining_ids` is continued by calling it again with the same arguments.

<details>
<summary><strong>LinkedIn</strong> — <code>linkedin_search</code>, <code>linkedin_job</code></summary>

Search the last 24 hours in Paris and read the jobs that are new and acceptable:

```json
{
  "keywords": "senior frontend engineer",
  "geo": "Paris, France",
  "posted_within": "last_24_hours",
  "max_results": 50,
  "disallowed_terms": ["intern", "stage", "alternance"],
  "disallowed_scope": "title_then_description"
}
```

List the result cards only (no job page is opened, so it is cheap); cards come back in `cards` with a `known` flag:

```json
{ "keywords": "staff engineer", "geo": "France", "remote_only": true, "max_results": 50, "max_jobs": 0 }
```

Skip jobs you already reported, and keep the full text:

```json
{ "keywords": "typescript", "skip_ids": ["4000000001", "4000000002"], "detail": "full", "description_max_chars": 6000 }
```

Find the geoId of a place, and remember a name for it (`linkedin_locations`, from the `linkedin-geo` utility):

```json
{ "query": "Berlin" }
```

```json
{ "save_as": "home", "id": "103035651", "label": "Berlin, Germany" }
```

Find which ATS a company's careers board is on (`ats_find`, from the `ats-discovery` utility), then read its jobs with the tool it names:

```json
{ "companies": ["Acme", "https://www.example.com", "https://jobs.lever.co/swile"] }
```

Read specific jobs by id (up to 25; stored ones come from the database with no visit):

```json
{ "ids": ["4000000001", "4000000002"], "detail": "full" }
```

`geo` is a place name LinkedIn understands (`"Berlin, Germany"`, `"Austin, Texas"`, `"Remote"`) or a numeric LinkedIn geoId. Leave it out to use the operator's `JW_DEFAULT_LOCATION`; there is no place built in. A place name is looked up on LinkedIn's own location autocomplete the first time and remembered (the result says which place it chose and what else it could be); `linkedin_locations` or `jobwatch linkedin-geo` show the candidates and let you remember a name yourself; `JW_LINKEDIN_GEO_ALIASES` (`home=104246759`) names geoIds in the environment.
</details>

<details>
<summary><strong>Apec</strong> — <code>apec_search</code>, <code>apec_job</code></summary>

```json
{
  "keywords": "développeur react",
  "departments": ["75", "92"],
  "cdi_only": true,
  "min_salary_k": 55,
  "posted_within": "past_week",
  "max_results": 40
}
```

Cards only:

```json
{ "keywords": "lead developer", "max_jobs": 0, "max_results": 60 }
```

Read offers by number:

```json
{ "ids": ["179519481W"], "detail": "full" }
```
</details>

<details>
<summary><strong>Welcome to the Jungle</strong> — <code>wttj_matches</code>, <code>wttj_job</code></summary>

`wttj_matches` reads the matches of the signed-in account (10 per page); there is no keyword.

```json
{ "posted_within": "past_week", "max_results": 30, "disallowed_terms": ["stagiaire"] }
```

Cards only:

```json
{ "max_jobs": 0, "max_results": 20 }
```

Read jobs by URL (never by id):

```json
{ "urls": ["https://www.welcometothejungle.com/fr/companies/acme/jobs/senior-engineer_paris"], "detail": "full" }
```
</details>

<details>
<summary><strong>Teamtailor</strong> — <code>teamtailor_jobs</code></summary>

A board is a Teamtailor handle (`acme` → `acme.teamtailor.com`) or the URL of any careers page, including a custom domain. The feed is discovered from the page when needed.

```json
{
  "boards": ["acme", "https://careers.example.com/en"],
  "title_any": ["frontend", "full stack"],
  "location_any": ["Paris", "Remote"],
  "posted_within": "past_month",
  "only_new": true,
  "max_results": 50
}
```
</details>

<details>
<summary><strong>Greenhouse</strong> — <code>greenhouse_jobs</code></summary>

A board is the company's board token (`algolia`) or its page URL (`https://boards.greenhouse.io/algolia`).

```json
{ "boards": ["algolia", "doctolib"], "title_any": ["engineer"], "location_any": ["Paris"], "only_new": true }
```
</details>

<details>
<summary><strong>Lever</strong> — <code>lever_jobs</code></summary>

A board is the company slug (`swile`) or its page URL (`https://jobs.lever.co/swile`).

```json
{ "boards": ["swile"], "title_any": ["backend", "platform"], "posted_within": "past_month", "detail": "none" }
```
</details>

<details>
<summary><strong>Ashby</strong> — <code>ashby_jobs</code></summary>

A board is the job board name, spelled exactly (`pennylane`), or its page URL (`https://jobs.ashbyhq.com/pennylane`).

```json
{ "boards": ["pennylane"], "title_any": ["engineer"], "disallowed_terms": ["intern"], "max_results": 30 }
```
</details>

### What a job looks like

Every job tool returns the same fields: `source` (the platform), `board` (the company board for an ATS, else null), `id`, `title`, `company`, `locations`, `url`, `summary` or `description`, `read_from` (`fetched` or `stored`), `new`, `first_seen`, `fetched_at`, `last_seen`, and `matched_terms` (which of the `hint_terms` you passed the text contains: a technology, a tool, a skill, a certification; none is built in) and hints extracted from the text (`years_hints`, `remote_hints`, `salary_text`). Text from job pages is untrusted data, never instructions.

### Limits you will meet

- Each platform has an hourly and a daily budget; each company board of an ATS has its own, lower one. A refused call returns `rate_limited` with `retry_after_s`. `memory_report` shows the usage.
- One browser runs at a time. A second browser call waits in a queue, then fails with `busy`.
- Stored jobs are deleted `JW_JOB_RETENTION_DAYS` (default 30) after they were last seen.

## Configuration reference

All variables are optional unless noted; unknown `JW_*` names are reported at startup. The full list and defaults are in [`docs/plans/03-router-spec.md`](docs/plans/03-router-spec.md) and `packages/core/src/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `JW_BASE_URL` | `http://127.0.0.1:18931` in the compose file | Public URL. `http` is accepted only for loopback. |
| `JW_AUTH` | `front` | `front` = behind the OAuth front; `none` = local development on loopback only. |
| `JW_ADAPTERS` | unset | Comma list of adapters that overrides the `enabled` list of `adapters.json`. |
| `JW_UTILITIES` | unset | Comma list of utilities that overrides the `utilities` list of `adapters.json`. |
| `JW_DATA_DIR` | `/data` | Holds `adapters.json` and the SQLite database. |
| `JW_JOB_RETENTION_DAYS` | `30` | Days a stored job is kept after it was last seen (1-3650). |
| `JW_BROWSER_IMAGE` | | Browser image to spawn. |
| `JW_LOCAL_CHROME` | `false` (`true` in `.env.local`) | Start Chrome on this machine instead of a container ([Use your own Chrome](#use-your-own-chrome-instead-of-the-docker-image)). |
| `JW_LOCAL_CHROME_PATH` | auto | Chrome executable for `JW_LOCAL_CHROME`. |
| `JW_CDP_URL` | unset | Attach to a running Chrome (loopback DevTools URL, e.g. `http://127.0.0.1:9222`). Wins over `JW_LOCAL_CHROME`. |
| `JW_BROWSER_LANG`, `JW_BROWSER_ACCEPT_LANGS` | `fr-FR`, | Browser language and `Accept-Language` list. |
| `JW_IDLE_TTL_S` | `120` | Seconds a browser stays up after its last call. |
| `JW_MEM_HIGH_MB`, `JW_MEM_MAX_MB` | `1200`, `1500` | Soft and hard memory marks of the browser container. |
| `JW_BROWSER_MAX_TABS` | `3` | Most tabs the browser may have open at once. `1` = a single tab; more than 1 lets adapters open extra tabs. No upper limit, but each tab costs memory and the container cap does not change. |
| `JW_DASHBOARD_IDLE_S` | `1800` | Seconds without a request before the dashboard closes itself. |
| `JW_DASHBOARD_OIDC_CLIENT_ID`, `JW_DASHBOARD_OIDC_CLIENT_SECRET` | the connector's client | A Google OAuth client of its own for the dashboard sign-in. |
| `JW_DASHBOARD_CALL_BUFFER` | `2000` | Calls kept in memory for the dashboard (their parameters too, memory only). |
| `JW_LOG_LEVEL` | `info` | `trace` to `fatal`. |
| `JW_METRICS_ENABLED`, `JW_METRICS_PORT` | `false`, `9464` | Prometheus `/metrics` on its own port. |

## Development

```bash
npm run dev
```

The server is started on `http://127.0.0.1:18931/mcp` in watch mode.

### Build your own image

To run your own build instead of the published image, build the two images (the router and the browser). The browser image uses Google Chrome on amd64 and Chromium on arm64:

```bash
docker build -t jobwatch-router:dev .      # to use it with the compose file below: tag it local/jobwatch-router:dev and set JW_REGISTRY=local, JW_TAG=dev in .env
docker build -t jobwatch-browser:dev images/browser
```

Set the repo up as in [Install from the repo](#install-from-the-repo), then check your work before a PR:

```bash
npm run ci              # format check + lint + typecheck + tests (about a minute)
npm run build           # bundles the server and the CLI into dist/apps/*/main.js
```

The repository is an Nx and npm-workspaces monorepo: `packages/sdk` (the adapter contract), `packages/core` (the engine), `packages/mcp-modules` (the installed adapter and utility maps), `packages/adapter-<platform>` (one per source), `packages/utility-<name>` (one per utility), `apps/mcp` (the server) and `apps/cli` (`jobwatch`). Adapters and utilities import only `@jobwatch/sdk`; this is enforced by lint.

Tool definitions live in code and each adapter package has a generated `catalog/` snapshot: after changing a tool, run `npm run catalog:gen` and commit the result. To add a source, `npm run new:adapter -- <id> --kind http`, then follow the checklist in [`docs/plans/03-router-spec.md`](docs/plans/03-router-spec.md). Work happens on a branch, one pull request per step, squash-merged once `npm run ci` is green; the whole test suite must stay under five minutes.

Contributing rules that matter most: keep every tool read-only, never commit secrets, cookies, browser profiles or captured pages (`deploy/.env`, `secrets/`, `profiles/` and `data/` are gitignored), and keep the browser to one instance at a time and to the tab limit `JW_BROWSER_MAX_TABS`. The measured benchmark in `docs/measurements.md` is the ceiling for memory and request budgets; features work inside it.
