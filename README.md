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
2. [OAuth](docs/oauth.md)
3. [Connect Claude](#connect-claude)
4. [Modules](#modules)
5. [Log in to the sites that need it](#log-in-to-the-sites-that-need-it)
6. [Operator dashboard](#operator-dashboard)
7. [Commands](#commands)
8. [Tools and example queries](#tools-and-example-queries)
9. [Configuration reference](#configuration-reference)
10. [Development](#development)
11. [Browser: the Docker image or your own Chrome](#browser-the-docker-image-or-your-own-chrome)

## Install

### From source

You need **Node 26** and npm.

```bash
git clone git@github.com:notcheu/jobwatch-mcp.git && cd jobwatch-mcp
npm install
npm run build
npm run start
```

The MCP server prints its address when it is ready: `MCP server listening on http://127.0.0.1:18931/mcp`.

The browser modules (`linkedin`, `apec`, `wttj`) need a Chrome instance. From source they use **your own Chrome** by default, so there is nothing to pull. To use the Docker browser image instead, see [Browser: the Docker image or your own Chrome](#browser-the-docker-image-or-your-own-chrome).

#### Use the CLI

To run the CLI, use the associated script:

```bash
npm run jobwatch -- adapters list
```

### With Docker Compose

`compose.yml` declares 3 service:
 - **the OAuth front**: handles OAuth authentication and authorization
 - **Redis**: handles data persistence
 - **the router**: handles requests and routes them to adapters

#### Pre-requisites

Docker with Docker Compose, ideally **rootless Docker for a dedicated user** on a server (the router controls the Docker daemon it is given: see [Rootless Docker](docs/rootless-docker.md)). About 2 GB of free RAM while a browser runs.

To use it from Claude on the web or desktop you also need a domain name with TLS in front of the front's published port ([reverse proxy](docs/reverse-proxy.md)).

#### Steps

1. Create a folder and copy [`deploy/compose.yml`](deploy/compose.yml)
2. Copy [`deploy/.env.example`](deploy/.env.example) to `.env` next to `compose.yml` (`chmod 600 .env`: it holds secrets once filled in; never commit it).
   - To use the MCP from Claude on the web or desktop, fill in the OAuth block ([OAuth](docs/oauth.md)).

3. Prepare data folder:
```bash
mkdir -p data
```

4. Pull the browser image. The router spawns it on the first browser call but never pulls it, so without this step `linkedin`, `apec` and `wttj` fail to start their browser. Pull the tag set as `BROWSER_IMAGE` in `.env` (`notcheu/jobwatch-browser:0.1.0` by default):

```bash
docker pull notcheu/jobwatch-browser:0.1.0
```

Not using the Docker image? Point the server at your own Chrome instead: [Browser: the Docker image or your own Chrome](#browser-the-docker-image-or-your-own-chrome).

5. Start it:

```bash
docker compose up -d
docker compose ps
docker compose logs -f router
```

The front and the router each get the whole `.env` as their environment, so any variable of [`docs/environment-variables.md`](docs/environment-variables.md) can be set there. The ones you are most likely to change:

| Variable | Meaning |
|---|---|
| `BASE_URL` | Public URL of the server, e.g. `https://mcp.example.com` (default `http://127.0.0.1:18931`) |
| `PORT` | Port of the MCP endpoint (front and router), published on `127.0.0.1` by `compose.yml` (default `18931`) |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TOKEN_SIGNING_SECRET` | Only with OAuth: see [OAuth](docs/oauth.md) |
| `TRUSTED_PROXY_CIDRS` | Address of your reverse proxy as the front sees it (default `172.17.0.1/32`, the Docker gateway) |
| `BROWSER_LANG`, `BROWSER_ACCEPT_LANGS` | The browser language list of your everyday browser |

The router keeps its data (enabled modules, stored jobs) in `./data`.

### How to update

#### Router image

Via Compose (or let [Watchtower](docs/watchtower.md) do it):

```bash
docker compose pull router && docker compose up -d router
```

#### Browser image

The browser image is spawned by the router, so neither Compose nor Watchtower updates it. Browser releases are versioned on their own, apart from the router ([`docs/releasing.md`](docs/releasing.md)). To update, set `BROWSER_IMAGE` to the new tag in `.env`, pull it, then recreate the router so it spawns the new image:

```bash
docker pull notcheu/jobwatch-browser:<new version>
docker compose up -d router
```

After updating the router image, reconnect the Claude connector so it reloads the tool list.

### Compose locally without OAuth

**Trying it on a laptop, without OAuth.** `deploy/compose.dev.yml` runs only the router (built from this repo), on `http://127.0.0.1:18931/mcp` (`PORT`) with **no authentication** (accepted only on a loopback address), so no Google client is needed. Never expose that port.

```bash
cp deploy/.env.example deploy/.env      # Compose needs the file; the OAuth block can stay as it is
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up router
claude mcp add --transport http jobwatch-dev http://127.0.0.1:18931/mcp
```

Every `jobwatch` command below runs inside the router container:

```bash
alias jobwatch='docker compose exec router jobwatch'
```

## OAuth

To use the server from Claude on the web or desktop, the OAuth front signs you in with Google and only lets calls with a valid token through.

See step by step documentation here: [`docs/oauth.md`](docs/oauth.md) on how to create a Google OAuth client.

Without OAuth, run the server locally with OAuth disabled ([Compose locally without OAuth](#compose-locally-without-oauth)).

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

Setting `ADAPTERS=apec,wttj` (or `UTILITIES=...`) in the environment pins the list and makes it read-only.

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

## Operator dashboard

A web interface for the operator: the history of calls (with their parameters), the stored jobs, the searches, the state of each tool and its rate usage, and the estimated tokens returned to Claude. It is **closed by default**: nothing listens until you start it on the host, and it closes by itself after 30 minutes without use.

```bash
jobwatch dashboard start        # prints the address, e.g. https://<your domain>/dashboard
jobwatch dashboard status
jobwatch dashboard stop
```

The **Docs** page documents every adapter and utility: what each tool does, a parameter table read from its schema, and examples to copy into a Claude session.

Signing in uses Google, with the same OAuth client as the connector by default: add `https://<your domain>/dashboard/auth/callback` to that client's authorized redirect URIs in Google Cloud Console. The Google app decides who can sign in (keep it in Testing status with only your account as a test user); the dashboard has no allowlist of its own. Changes made from the dashboard need a sign-in within the last 10 minutes. When the router runs for local development (`AUTH=none`, see `deploy/compose.dev.yml`) there is no sign-in and it is at `http://127.0.0.1:<DASHBOARD_PORT>/dashboard/` (default port 8090; the command prints the exact address). Behind a reverse proxy, route `/dashboard` to the dashboard port (`deploy/nginx/mcp.example.com.conf` already maps it for Nginx; see [`docs/reverse-proxy.md`](docs/reverse-proxy.md)). The interface is a React app in `apps/dashboard` (`npm run build` produces it). To work on it, start the server with `npm run dev`, then run `npm run dev:dashboard` in a second terminal: it opens the dashboard of that server and serves the interface with hot reload at `http://localhost:5173/dashboard/`. The design is in [`docs/plans/17-dashboard.md`](docs/plans/17-dashboard.md).

## Commands

### `jobwatch` (inside the router container, or `npm run jobwatch --` from the repo)

| Command | What it does |
|---|---|
| `adapters list [--tools] [--json] [<id...>]` | Installed adapters and whether each is enabled. `--tools` adds every tool with its parameters (required ones starred, defaults, cost); `--json` gives the full catalog entries; ids narrow the list. |
| `adapters enable <id...>`, `adapters disable <id...>` | Enable or disable adapters. |
| `adapters clear-data <id> --yes` | Forget the jobs and searches an adapter stored, so its next call starts fresh. Budgets and history are kept. The dashboard has the same button on each adapter. |
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
| `npm run dev:dashboard` | Serve the dashboard interface with hot reload (Vite, `http://localhost:5173/dashboard/`) on top of the server that `npm run dev` runs: it opens the server's dashboard, proxies the API to it and closes it when you stop. |
| `npm run jobwatch -- <args>` | Build and run the CLI with the environment of `npm run dev` (`.env.local`, then `.env`), so it reaches the local server's data folder and control socket (`dashboard start`, `adapters enable`). |

## Tools and example queries

Every tool with its arguments and an example call, for LinkedIn, Apec, Welcome to the Jungle and the company-board modules: [`docs/tools-and-example-queries.md`](docs/tools-and-example-queries.md). The built-in tools are in [`docs/built-in-tools.md`](docs/built-in-tools.md).

## Configuration reference

Every environment variable, grouped by category (general, modules, OAuth, browser, dashboard, metrics, Docker Compose), is in [`docs/environment-variables.md`](docs/environment-variables.md). A bad value stops the server with the list of problems; they are validated by one zod schema, `packages/core/src/env.ts`.

## Development

```bash
npm run dev
```

The server restarts on every change and prints its address when it is ready (`MCP server listening on http://127.0.0.1:18931/mcp`). To open the dashboard of that local server, run `npm run jobwatch -- dashboard start` in another terminal.

### Build your own image

To run your own build instead of the published image, build the two images (the router and the browser). The browser image uses Google Chrome on amd64 and Chromium on arm64:

```bash
docker build -t notcheu/jobwatch-mcp:latest .      # the name compose.yml runs
docker build -t jobwatch-browser:latest images/browser   # then set BROWSER_IMAGE=jobwatch-browser:latest in .env
```

Set the repo up as in [Install from the repo](#install-from-the-repo), then check your work before a PR:

```bash
npm run ci              # format check + lint + typecheck + tests
npm run build           # bundles the server and the CLI into dist/apps/*/main.js
```

The repository is an Nx and npm-workspaces monorepo: `packages/sdk` (the adapter contract), `packages/core` (the engine), `packages/mcp-modules` (the installed adapter and utility maps), `packages/adapter-<platform>` (one per source), `packages/utility-<name>` (one per utility), `apps/mcp` (the server) and `apps/cli` (`jobwatch`). Adapters and utilities import only `@jobwatch/sdk`; this is enforced by lint.

Tool definitions live in code and each adapter package has a generated `catalog/` snapshot: after changing a tool, run `npm run catalog:gen` and commit the result. To add a source, `npm run new:adapter -- <id> --kind http`, then follow the checklist in [`docs/plans/03-router-spec.md`](docs/plans/03-router-spec.md). Work happens on a branch, one pull request per step, squash-merged once `npm run ci` is green; the whole test suite must stay under five minutes.

Contributing rules that matter most: keep every tool read-only, never commit secrets, cookies, browser profiles or captured pages (`deploy/.env`, `secrets/`, `profiles/` and `data/` are gitignored), and keep the browser to one instance at a time and to the tab limit `BROWSER_MAX_TABS`. The measured benchmark in `docs/measurements.md` is the ceiling for memory and request budgets; features work inside it.

## Browser: the Docker image or your own Chrome

The browser modules (`linkedin`, `apec`, `wttj`) get their Chrome from one of three sources, in this order of precedence:

1. **Attach to your own running Chrome** (`BROWSER_CDP_URL`): development.
2. **Let the server open its own Chrome** (`BROWSER_LOCAL_CHROME=true`): development. `npm run dev` and `npm run start` do this by default (`.env.local`).
3. **The Docker browser image** (`BROWSER_IMAGE`, default `notcheu/jobwatch-browser:0.1.0` in `.env.example`): the default of the Docker Compose deployment, and the only one for a server. Pull it first: `docker pull notcheu/jobwatch-browser:0.1.0`.

For development on your own machine you can skip Docker for the browser, in one of two ways:

- **`BROWSER_LOCAL_CHROME=true`**: the server starts a visible Chrome itself, the way Playwright does, and stops it after the idle period. Each platform gets its own profile in `<DATA_DIR>/browser-profiles/`, so a sign-in survives restarts. Chrome is looked for in the usual places; set `BROWSER_LOCAL_CHROME_PATH` to use another executable. Close any Chrome that already uses that profile directory.
- **`BROWSER_CDP_URL=http://127.0.0.1:9222`**: the server attaches to a Chrome that is already running. Start it with its DevTools port open and a profile directory of its own (Chrome ignores the port on its default profile):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.jobwatch-chrome"
```

In both cases you sign in to the sites yourself in that browser (no `jobwatch login`, no noVNC). The server opens a tab of its own for each call and closes it afterwards: **it never closes, navigates or blocks your other tabs**, and it never quits an attached Chrome. Only loopback DevTools URLs are accepted. The memory cap, the fingerprint check and the one-browser-at-a-time rule for containers do not apply to a browser that is not ours.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You can use, modify and redistribute the project, commercially or not, as long as everything you distribute or run as a network service on top of it is released under the same licence with its source. Releases and versioning: [`docs/releasing.md`](docs/releasing.md). Versions before 1.0.0 are not production ready and may change without notice.
