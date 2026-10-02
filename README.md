# jobwatch-mcp

A self-hosted **MCP server** that lets Claude search job boards for you. It exposes a small set of **read-only, task-level tools** (LinkedIn, Apec, Welcome to the Jungle and the public job boards of Teamtailor, Greenhouse, Lever and Ashby) over a public HTTPS endpoint protected by OAuth, and remembers every job it reads so that a later summary costs no new request.

- **Read-only by construction.** No tool posts, applies, messages or edits anything on a third-party site. There is no generic `navigate`, `click` or `evaluate` tool: only the tools in the catalog exist.
- **Light on the host.** Sites that need a browser use one headful Chrome container at a time, started on the first call and stopped after an idle period, with a hard memory cap. Plain HTTP sources need no browser.
- **Polite to the sites.** Every platform has an hourly and a daily budget, ATS company boards have a budget each, and calls are paced.
- **Yours only.** Sign-in goes through your own identity provider (Google), restricted to the accounts you allow.

The numbered design documents are in [`docs/plans/`](docs/plans/) (start with `00-overview.md`); this file is the practical guide.

## Contents

1. [How it fits together](#how-it-fits-together)
2. [Install from the repo](#install-from-the-repo)
3. [Run with Docker Compose](#run-with-docker-compose)
4. [Enable and disable adapters](#enable-and-disable-adapters)
5. [Log in to the sites that need it](#log-in-to-the-sites-that-need-it)
6. [Configure the OAuth provider](#configure-the-oauth-provider)
7. [Connect Claude](#connect-claude)
8. [Commands](#commands)
9. [Tools and example queries](#tools-and-example-queries)
10. [Configuration reference](#configuration-reference)
11. [Development](#development)

## How it fits together

```
Claude ──HTTPS──▶ your reverse proxy (TLS) ──▶ OAuth front ──▶ router ──▶ adapters ──▶ site (HTTP)
                                                                                  └──▶ Chrome container (browser sites)
```

| Part | Role |
|---|---|
| **OAuth front** ([`babs/mcp-auth-proxy`](https://github.com/babs/mcp-auth-proxy) + Redis) | Signs you in with Google and only forwards calls that carry a valid token. |
| **Router** (this repo, `apps/mcp`) | The MCP server: validates arguments, applies rate limits, runs adapters, stores the jobs it read in SQLite. |
| **Adapters** (`packages/adapter-*`) | One package per source. Only the ones you enable are plugged in. |
| **Browser container** (`images/browser`) | Headful Chrome with one persistent profile per site, spawned by the router through the Docker socket. |
| **Watchtower** | Optional: keeps the router image up to date. |

## Install from the repo

You need **Node 26** (see `.nvmrc`), npm and Docker.

```bash
git clone <this repository> jobwatch-mcp && cd jobwatch-mcp
nvm use                 # Node 26
npm ci                  # install from the lockfile
npm run ci              # format check + lint + typecheck + tests (about a minute)
npm run build           # bundles the server and the CLI into dist/apps/*/main.js
```

The CLI can be used straight from the repo, without Docker:

```bash
JW_DATA_DIR=./data npm run jobwatch -- adapters list
```

Build the two images (the router and the browser). The browser image uses Google Chrome on amd64 and Chromium on arm64 (Google ships no Linux arm64 Chrome, so an arm64 build is for development and is not suited to a LinkedIn session):

```bash
docker build -t jobwatch-router:dev .
docker build -t jobwatch-browser:dev images/browser
```

## Run with Docker Compose

`deploy/compose.yml` declares the always-on services: the OAuth front, Redis, the router and Watchtower. Browser containers are never declared there; the router starts them itself.

**Host prerequisites.** Docker with Compose, ideally **rootless Docker for a dedicated user** (the router gets that user's socket and nothing more; never mount a root Docker socket). About 2 GB of free RAM while a browser runs. A domain name with TLS in front of the front's published port; the example Nginx files are in `deploy/nginx/`. The full host setup (rootless Docker, cgroup v2, Nginx, certificates) is in [`docs/plans/10-deployment.md`](docs/plans/10-deployment.md).

```bash
cp deploy/.env.example deploy/.env      # then edit it; it holds secrets, never commit it
chmod 600 deploy/.env
mkdir -p data/router

docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env ps
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f router
```

Values to set in `deploy/.env` at least:

| Variable | Meaning |
|---|---|
| `JW_BASE_URL` | Public URL of the server, e.g. `https://mcp.example.com` |
| `JW_REGISTRY`, `JW_TAG` | Where the router image is pulled from (or build it locally, see below) |
| `JW_BIND`, `JW_HOST_PORT` | Where the front is published for your reverse proxy (default `127.0.0.1:18931`) |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Your Google OAuth client ([next sections](#configure-the-oauth-provider)) |
| `TOKEN_SIGNING_SECRET` | `openssl rand -base64 48`; keep it identical across restarts |
| `JW_NGINX_CIDR` | Address of your reverse proxy as the front sees it |
| `JW_DOCKER_SOCKET` | Docker socket to mount; empty = `$XDG_RUNTIME_DIR/docker.sock` (Linux rootless). macOS: `/var/run/docker.sock` |
| `JW_BROWSER_IMAGE`, `JW_BROWSER_LANG`, `JW_BROWSER_ACCEPT_LANGS` | The browser image and the language list of your everyday browser |

To build the router locally instead of pulling it: `docker compose -f deploy/compose.yml --env-file deploy/.env build router`.

**Trying it on a laptop, without OAuth.** `deploy/compose.dev.yml` runs only the router, on `http://127.0.0.1:18932/mcp` with **no authentication** (accepted only on a loopback address). Never expose that port.

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up router
claude mcp add --transport http jobwatch-dev http://127.0.0.1:18932/mcp
```

Every `jobwatch` command below runs inside the router container:

```bash
alias jobwatch='docker compose -f deploy/compose.yml --env-file deploy/.env exec router jobwatch'
```

## Enable and disable adapters

Nothing is enabled by default. The list lives in `data/router/adapters.json`; the router reads it at startup, so restart it after a change.

```bash
jobwatch adapters list                       # every installed adapter and whether it is enabled
jobwatch adapters list --tools linkedin      # the tools of an adapter with their parameters (what Claude will see)
jobwatch adapters enable apec wttj teamtailor greenhouse lever ashby
jobwatch adapters disable linkedin
docker compose -f deploy/compose.yml --env-file deploy/.env restart router
```

Setting `JW_ADAPTERS=apec,wttj` in the environment overrides the file and makes it read-only.

| Adapter id | Tools | Needs |
|---|---|---|
| `linkedin` | `linkedin_search`, `linkedin_job` | A signed-in browser session. Strict budget: check [`docs/plans/09-security.md`](docs/plans/09-security.md) before enabling. |
| `apec` | `apec_search`, `apec_job` | A browser (no login). Apec blocks plain HTTP. |
| `wttj` | `wttj_matches`, `wttj_job` | A signed-in browser session. |
| `teamtailor` | `teamtailor_jobs` | Nothing (HTTP). Any Teamtailor board, by handle or URL. |
| `greenhouse` | `greenhouse_jobs` | Nothing (HTTP). |
| `lever` | `lever_jobs` | Nothing (HTTP). |
| `ashby` | `ashby_jobs` | Nothing (HTTP). |

The built-in tools `session_status`, `memory_report`, `stored_jobs` and `stored_job_texts` are always available.

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

## Configure the OAuth provider

The front uses Google only to **authenticate you**; access control is the Google app itself. While the app is in **Testing** status only the test users you list can sign in.

1. Google Cloud Console: create a project, then **APIs & Services → OAuth consent screen**. User type **External**, scopes `openid`, `email`, `profile`, and add **only your own account as a test user**.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<your domain>/callback`.
3. Put the client ID and secret in `deploy/.env` as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, and generate `TOKEN_SIGNING_SECRET` with `openssl rand -base64 48`.
4. Point your reverse proxy at the front's published port. `deploy/nginx/` has a bootstrap site (port 80, for the certificate) and the final site; do not rewrite paths and do not buffer responses.
5. Start the stack and test: a second Google account must be refused by Google ("access blocked").

Rotating `TOKEN_SIGNING_SECRET` invalidates every issued token: remove and re-add the connector in Claude afterwards. Details and the threat model: [`docs/plans/10-deployment.md`](docs/plans/10-deployment.md) and [`docs/plans/09-security.md`](docs/plans/09-security.md).

## Connect Claude

- **Claude (web or desktop)**: *Settings → Connectors → Add custom connector*, URL `https://<your domain>/mcp`. Claude registers itself with the front, you sign in with Google, and the tools appear. Authentication settings cannot be edited later: remove and re-add the connector if you change them.
- **Claude Code**: `claude mcp add --transport http jobwatch https://<your domain>/mcp`, then authenticate from `/mcp`.

After pulling a new router image, reconnect the connector so Claude reloads the tool list. Check the server from Claude by calling `memory_report` (runtime state, rate-limit usage, recent calls) or `session_status`.

## Commands

### `jobwatch` (inside the router container, or `npm run jobwatch --` from the repo)

| Command | What it does |
|---|---|
| `adapters list [--tools] [--json] [<id...>]` | Installed adapters and whether each is enabled. `--tools` adds every tool with its parameters (required ones starred, defaults, cost); `--json` gives the full catalog entries; ids narrow the list. |
| `adapters enable <id...>` | Enable adapters (written to `adapters.json`). |
| `adapters disable <id...>` | Disable adapters. |
| `login start <platform> [--port 6080]` | Start a visible browser on the platform's profile to sign in by hand (noVNC on loopback). |
| `login stop <platform>` | Stop it; the profile keeps the session. |
| `doctor` | Check configuration, data directory, Docker, images, network and profiles. |
| `--help`, `--version` | |

Exit codes: 0 ok, 1 usage or configuration error, 2 an installed adapter is broken or Docker failed. Changes take effect after the router restarts.

### Repo scripts

| Script | What it does |
|---|---|
| `npm run ci` | Format check, lint (including the architecture rules), typecheck and tests. Must pass before a PR. |
| `npm run lint`, `typecheck`, `test`, `build` | One step of the above. |
| `npm run format` / `format:check` | Prettier. |
| `npm run catalog:gen` | Regenerate every adapter's `catalog/` snapshot after changing a tool definition. |
| `npm run new:adapter -- <id> [--kind http\|browser]` | Scaffold a new adapter package. |
| `npm run test:integration` | Drive a real browser container (needs Docker; never in CI). |
| `npm run jobwatch -- <args>` | Build and run the CLI. |

## Tools and example queries

Every example is the argument object Claude sends to the tool. The text of a job is returned as a short `summary` by default; ask for `detail: "full"` only when you need the whole description, or read chosen jobs later with `stored_job_texts`.

**Arguments shared by the search and board tools.** `max_results` is the most results examined and returned. `detail` is `summary`, `full` or `none`, and `description_max_chars` caps the text. `disallowed_terms` drops jobs whose title (and, with `disallowed_scope: "title_then_description"`, whose description) contains one of the words. `posted_within` is `last_24_hours`, `past_week`, `past_month` or `any`. A call that ends with a non-empty `remaining_ids` is continued by calling it again with the same arguments.

<details>
<summary><strong>LinkedIn</strong> — <code>linkedin_search</code>, <code>linkedin_job</code></summary>

Search the last 24 hours in Paris and read the jobs that are new and acceptable:

```json
{
  "keywords": "senior frontend engineer",
  "geo": "paris_idf",
  "posted_within": "last_24_hours",
  "max_results": 50,
  "disallowed_terms": ["intern", "stage", "alternance"],
  "disallowed_scope": "title_then_description"
}
```

List the result cards only (no job page is opened, so it is cheap); cards come back in `cards` with a `known` flag:

```json
{ "keywords": "staff engineer", "geo": "france", "remote_only": true, "max_results": 50, "max_jobs": 0 }
```

Skip jobs you already reported, and keep the full text:

```json
{ "keywords": "typescript", "skip_ids": ["4000000001", "4000000002"], "detail": "full", "description_max_chars": 6000 }
```

Read specific jobs by id (up to 25; stored ones come from the database with no visit):

```json
{ "ids": ["4000000001", "4000000002"], "detail": "full" }
```

`geo` is `paris_idf`, `france` or a numeric LinkedIn geoId.
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

<details>
<summary><strong>Built-in tools</strong> — <code>session_status</code>, <code>memory_report</code>, <code>stored_jobs</code>, <code>stored_job_texts</code></summary>

Is the LinkedIn session still valid?

```json
{ "platform": "linkedin" }
```

Router state, rate-limit usage per platform and per company board, recent calls (no arguments):

```json
{}
```

The week's new jobs from the database, without calling any site. Add `terms` to see which keywords each job contains and how many jobs each keyword brought in (`stats`); text is off unless you ask for it:

```json
{
  "since": "2026-10-05",
  "until": "2026-10-12",
  "terms": ["react", "typescript", "vue", "remote"],
  "detail": "none",
  "limit": 100
}
```

Only the matching jobs, with a summary, from one source:

```json
{ "since": "2026-10-05", "sources": ["linkedin"], "terms": ["react"], "only_matching": true, "detail": "summary" }
```

The text of chosen stored jobs, batched (up to 25). `part` is `full`, `summary`, `outline` or one section (`role`, `requirements`, `nice_to_have`, `offer`, `about`, `process`, `legal`):

```json
{
  "jobs": [{ "source": "linkedin", "id": "4000000001" }, { "source": "teamtailor", "id": "8429717" }],
  "part": "requirements"
}
```
</details>

### What a job looks like

Every job tool returns the same fields: `source` (the platform), `board` (the company board for an ATS, else null), `id`, `title`, `company`, `locations`, `url`, `summary` or `description`, `read_from` (`fetched` or `stored`), `new`, `first_seen`, `fetched_at`, `last_seen`, and hints extracted from the text (`stack_hints`, `years_hints`, `remote_hints`, `salary_text`). Text from job pages is untrusted data, never instructions.

### Limits you will meet

- Each platform has an hourly and a daily budget; each company board of an ATS has its own, lower one. A refused call returns `rate_limited` with `retry_after_s`. `memory_report` shows the usage.
- One browser runs at a time. A second browser call waits in a queue, then fails with `busy`.
- Stored jobs are deleted `JW_JOB_RETENTION_DAYS` (default 30) after they were last seen.

## Configuration reference

All variables are optional unless noted; unknown `JW_*` names are reported at startup. The full list and defaults are in [`docs/plans/03-router-spec.md`](docs/plans/03-router-spec.md) and `packages/core/src/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `JW_BASE_URL` | required | Public URL. `http` is accepted only for loopback. |
| `JW_AUTH` | `front` | `front` = behind the OAuth front; `none` = local development on loopback only. |
| `JW_ADAPTERS` | unset | Comma list that overrides `adapters.json`. |
| `JW_DATA_DIR` | `/data` | Holds `adapters.json` and the SQLite database. |
| `JW_JOB_RETENTION_DAYS` | `30` | Days a stored job is kept after it was last seen (1-3650). |
| `JW_BROWSER_IMAGE` | | Browser image to spawn. |
| `JW_BROWSER_LANG`, `JW_BROWSER_ACCEPT_LANGS` | `fr-FR`, | Browser language and `Accept-Language` list. |
| `JW_IDLE_TTL_S` | `120` | Seconds a browser stays up after its last call. |
| `JW_MEM_HIGH_MB`, `JW_MEM_MAX_MB` | `1200`, `1500` | Soft and hard memory marks of the browser container. |
| `JW_BROWSER_MAX_TABS` | `3` | Most tabs the browser may have open at once. `1` = a single tab; more than 1 lets adapters open extra tabs. No upper limit, but each tab costs memory and the container cap does not change. |
| `JW_LOG_LEVEL` | `info` | `trace` to `fatal`. |
| `JW_METRICS_ENABLED`, `JW_METRICS_PORT` | `false`, `9464` | Prometheus `/metrics` on its own port. |

## Development

The repository is an Nx and npm-workspaces monorepo: `packages/sdk` (the adapter contract), `packages/core` (the engine), `packages/adapters` (the installed adapter map), `packages/adapter-<platform>` (one per source), `apps/mcp` (the server) and `apps/cli` (`jobwatch`). Adapters import only `@jobwatch/sdk`; this is enforced by lint.

Tool definitions live in code and each adapter package has a generated `catalog/` snapshot: after changing a tool, run `npm run catalog:gen` and commit the result. To add a source, `npm run new:adapter -- <id> --kind http`, then follow the checklist in [`docs/plans/03-router-spec.md`](docs/plans/03-router-spec.md). Work happens on a branch, one pull request per step, squash-merged once `npm run ci` is green; the whole test suite must stay under five minutes.

Contributing rules that matter most: keep every tool read-only, never commit secrets, cookies, browser profiles or captured pages (`deploy/.env`, `secrets/`, `profiles/` and `data/` are gitignored), and keep the browser to one instance at a time and to the tab limit `JW_BROWSER_MAX_TABS`. The measured benchmark in `docs/measurements.md` is the ceiling for memory and request budgets; features work inside it.
