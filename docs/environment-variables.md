# Environment variables

Where to set them:

- **Docker Compose:** in the `.env` file next to `compose.yml` (template: [`deploy/.env.example`](../deploy/.env.example)). The OAuth front and the router each get the whole file as their environment, so every variable below works there without touching `compose.yml`. Compose also expands `${VAR}` inside the file (`LISTEN_ADDR=0.0.0.0:${PORT}`).
- **`npm run dev` / `npm run start`:** in `.env.local` (committed defaults, no secrets) and `.env` (yours, `start` only); a variable set in the shell wins. See [`/.env.local`](../.env.local).

All variables are optional unless noted. An empty value counts as "not set". They are validated at startup by one zod schema, `packages/core/src/env.ts`, which is the source of truth: a bad value stops the server with the list of problems (never the values). The variables used to start with `JW_` (`JW_PORT`); that prefix was dropped, and a variable that still has it is reported and not read. The design is in [`plans/03-router-spec.md`](plans/03-router-spec.md).

- [General](#general)
- [Modules](#modules)
- [Budgets](#budgets)
- [OAuth](#oauth)
- [Browser](#browser)
- [Operator dashboard](#operator-dashboard)
- [Metrics](#metrics)
- [Docker Compose](#docker-compose)

## General

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:18931` in `compose.yml`, required elsewhere | Public URL of the server. `http` is accepted only for loopback. |
| `AUTH` | `front` | `front`: requests come through the OAuth front. `none`: no authentication, accepted only when `BASE_URL` is a loopback address (local development). |
| `LISTEN_HOST` | `0.0.0.0` | Address the MCP server listens on. |
| `PORT` | `8080`; `18931` in the example files | Port of the MCP server (1024-65535). In Docker Compose it is also the port the OAuth front listens on and the one `compose.yml` publishes on the host. |
| `DATA_DIR` | `/data`; `./.data` for `npm run dev` and `start` | Holds the SQLite database, `adapters.json` and, with `BROWSER_LOCAL_CHROME`, the browser profiles. In Compose it is `./data` next to the compose file, mounted at `/data`. |
| `DB_PATH` | `<DATA_DIR>/jobwatch.sqlite` | The SQLite file. The schema is migrated at every boot. |
| `JOB_RETENTION_DAYS` | `30` | Days a stored job is kept after it was last seen (1-3650). |
| `CALL_LOG_RETENTION_DAYS` | `30` | The log rotation: days a call is kept in the call log before it is deleted, **with its parameters** (the arguments Claude sent, capped at 16 KB a call; never credentials). The call log is what the Runs page, the Overview and the Analytics show: the most recent `DASHBOARD_CALL_BUFFER` calls of it are loaded when the router starts. Lowering it deletes the older calls at the next start or hourly prune (1-3650). |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. |
| `BROWSER_RUNTIME` | `docker` | Container runtime for the browser. Only `docker` is implemented. |
| `TOKEN_CHARS_PER_TOKEN` | `3.5` | Characters per token, for the estimate of what a result costs Claude (1-10). |

## Modules

See [Modules](../README.md#modules) in the README for what a module is.

| Variable | Default | Meaning |
|---|---|---|
| `ADAPTERS` | unset | Comma list of adapters (`apec,wttj`). Pins the list: it overrides `adapters.json` and the CLI can no longer change it. Unset = what `jobwatch adapters enable` wrote; nothing is enabled by default. |
| `UTILITIES` | unset | The same for utilities (`linkedin-geo,ats-discovery`). |
| `LINKEDIN_DEFAULT_LOCATION` | unset | Where LinkedIn searches look when a call gives no `geo`: a place name (`Berlin, Germany`) or a LinkedIn geoId. No place is built in. |
| `LINKEDIN_GEO_ALIASES` | unset | Names for LinkedIn geoIds you use often (`home=104246759,europe=91000000`). |

## Budgets

How many requests a module may make, in any one hour and in any 24 hours (a call reserves its cost first and settles to what it really spent; a call that would go over is refused with `rate_limited`). Each module has an hourly and a daily number. Three layers set them, and **each window is resolved on its own**:

1. **The environment**, `<MODULE ID>_BUDGET_HOURLY` and `<MODULE ID>_BUDGET_DAILY`: the id in capitals, `-` as `_`. They win. The dashboard shows their value and cannot change it.
2. **What you save** from the dashboard (Tools & status, the settings menu of a module, Budget), kept in `<DATA_DIR>/budgets.json`. It applies to the next call, with no restart.
3. **The defaults**, in [`packages/mcp-modules/src/budgets.json`](../packages/mcp-modules/src/budgets.json): one entry per installed module, `{ "hourly": n, "daily": n }`. Edit the file to change a default (a test pins the LinkedIn one, and checks that every tool still fits in its module's budget). A module with no entry keeps the budget it declares itself, or the engine default of its kind (browser 120 per hour and 300 per day, HTTP 600 and 3000).

| Variable | Default | Meaning |
|---|---|---|
| `LINKEDIN_BUDGET_HOURLY`, `LINKEDIN_BUDGET_DAILY` | unset | The budget of `linkedin`. The same pattern exists for every installed module: `APEC_BUDGET_*`, `WTTJ_BUDGET_*`, `ASHBY_BUDGET_*`, `GREENHOUSE_BUDGET_*`, `LEVER_BUDGET_*`, `TEAMTAILOR_BUDGET_*`, `ATS_DISCOVERY_BUDGET_*`, `LINKEDIN_GEO_BUDGET_*`. |

A value that is not a whole number from 0 to 1000000 stops the server at startup and names the variable. Company boards (`greenhouse`, `lever`, `ashby`, `teamtailor`) also have a budget per board, set by the module (20 per hour and 100 per day); these variables set the budget of the platform as a whole. `budgets.json` is read at startup: edit it by hand only while the router is stopped.

## OAuth

Needed only for the public deployment behind the OAuth front. The front's own `PROXY_BASE_URL` (= `BASE_URL`), `UPSTREAM_MCP_URL` (`http://router:${PORT}/mcp`), `LISTEN_ADDR` (`0.0.0.0:${PORT}`) and `METRICS_ADDR` (`127.0.0.1:9090`, never published) are set in `compose.yml`, not here. Step by step: [`oauth.md`](oauth.md).

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_CLIENT_ID` | | Client ID of your Google OAuth client. The router reads it too, as the dashboard's default client. |
| `OIDC_CLIENT_SECRET` | | Its secret. Never commit it. |
| `TOKEN_SIGNING_SECRET` | | `openssl rand -base64 48`. Keep it identical across restarts; changing it invalidates every issued token. |
| `OIDC_ISSUER_URL` | | `https://accounts.google.com`. Required by the front. The dashboard uses it too unless `DASHBOARD_OIDC_ISSUER` is set. |
| `TRUSTED_PROXY_CIDRS` | | Address of your reverse proxy as the front sees it (the Docker gateway `172.17.0.1/32` if the proxy runs on the host, else its LAN IP followed by `/32`). |
| `FRONT_SHARED_SECRET` | unset | At least 16 characters. When set with `AUTH=front`, the router requires it as a shared secret from the front. |
| `DASHBOARD_OIDC_CLIENT_ID`, `DASHBOARD_OIDC_CLIENT_SECRET` | the connector's client | A Google OAuth client of its own for the dashboard sign-in. |
| `DASHBOARD_OIDC_ISSUER` | `OIDC_ISSUER_URL`, else `https://accounts.google.com` | OIDC issuer of the dashboard sign-in. |

## Browser

Used by the browser modules (`linkedin`, `apec`, `wttj`). HTTP-only modules never start a browser. Three sources of Chrome, in this order of precedence: `BROWSER_CDP_URL`, `BROWSER_LOCAL_CHROME`, then a container (default).

### Which Chrome

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_LOCAL_CHROME` | `false` (`true` in `.env.local`) | Start a visible Chrome on this machine, with a profile per platform in `<DATA_DIR>/browser-profiles/`. |
| `BROWSER_LOCAL_CHROME_PATH` | auto | Chrome executable for `BROWSER_LOCAL_CHROME`, when it is not found in the usual places. |
| `BROWSER_CDP_URL` | unset | Attach to a Chrome that is already running: a loopback DevTools URL such as `http://127.0.0.1:9222` (start Chrome with `--remote-debugging-port` and its own `--user-data-dir`). Wins over `BROWSER_LOCAL_CHROME`. The server only opens and closes tabs of its own. |

### Container (the default)

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_IMAGE` | `localhost/jobwatch-browser:1` (`notcheu/jobwatch-browser:0.1.0` in `.env.example`) | Browser image the router spawns. Published for amd64 and arm64 with its own version (`docs/releasing.md`); docker pulls it on the first browser call, so `docker pull` it beforehand to avoid a slow cold start. |
| `BROWSER_NETWORK` | `jobwatch-browsers` | Internal Docker network of the browsers. `compose.yml` creates it under this name (`BROWSER_NETWORK` in `.env`), and the router attaches the browsers to it. |
| `BROWSER_SECCOMP` | unset | Absolute path of the Chrome seccomp profile as the docker CLI sees it; unset = Docker's default profile. |
| `BROWSER_PROFILE_VOLUME_PREFIX` | `jw-profile-` | Browser profiles are Docker volumes named `<prefix><platform>`. |
| `BROWSER_FINGERPRINT` | `enforce` | Startup check that the container's Chrome looks like a normal one: `enforce` refuses a browser that fails, `warn` logs, `off` skips. |
| `BROWSER_MEM_HIGH_MB`, `BROWSER_MEM_MAX_MB` | `1200`, `1500` | Soft and hard memory marks of the container (256-16384; high must be lower than max). Per-tool budgets override them. |
| `BROWSER_IDLE_TTL_S` | `120` | Seconds the browser stays up after its last call (10-3600). |
| `BROWSER_MAX_LIFETIME_S` | `1800` | A browser older than this is recycled at the next call (60-86400). |
| `BROWSER_QUEUE_TIMEOUT_S` | `60` | How long a call waits for the single browser before failing with `busy` (1-600). |

### For every source

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_LANG` | `fr-FR` | UI language of the browser. |
| `BROWSER_ACCEPT_LANGS` | unset | `Accept-Language` list, copied from `navigator.languages` of your everyday browser (`fr-FR,en-GB,en-US`). |
| `BROWSER_MAX_TABS` | `3` | Most tabs open at once. `1` = a single tab; more lets adapters open extra tabs. Each tab costs memory and the cap does not change. |

`BROWSER_LANG` and `BROWSER_ACCEPT_LANGS` are handed to the browser container; with `BROWSER_LOCAL_CHROME` or `BROWSER_CDP_URL` the Chrome keeps its own language.

## Operator dashboard

Closed until `jobwatch dashboard start`. Sign-in variables are under [OAuth](#oauth).

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_PORT` | `8090`; `18933` in the example files | Port the dashboard listens on while it is open. In Docker Compose `compose.yml` publishes it on the host. |
| `DASHBOARD_URL` | `<BASE_URL origin>/dashboard/` | Where the operator opens it. |
| `DASHBOARD_STATIC_DIR` | unset | The built interface; without it a plain page says only the API is up. |
| `DASHBOARD_IDLE_S` | `1800` | Seconds without a request before it closes itself (60-86400). |
| `DASHBOARD_SESSION_MAX_S` | `28800` | A session never lasts longer than this (300-604800). |
| `DASHBOARD_WRITE_WINDOW_S` | `600` | A change is accepted without signing in again for this long after a sign-in; `0` = every change signs in again (0-86400). |
| `DASHBOARD_CALL_BUFFER` | `2000` | Calls kept in memory for the dashboard, with their parameters (100-20000). |

## Metrics

| Variable | Default | Meaning |
|---|---|---|
| `METRICS_ENABLED` | `false` | `true`: Prometheus `/metrics` on its own port, never on the MCP port. |
| `METRICS_PORT` | `9464` | Its port; must differ from `PORT`. In Docker Compose `compose.yml` publishes it on the host. |

## Docker Compose

`compose.yml` has no defaults of its own: `PORT`, `BASE_URL`, `BROWSER_NETWORK`, `DASHBOARD_PORT` and `METRICS_PORT` are required in `.env` (Compose stops and names the missing one), and `deploy/.env.example` sets all of them. What only concerns the stack, not the server, is set in `compose.yml` itself and is not an environment variable: edit the file.

- **Images:** `notcheu/jobwatch-mcp:latest`, `redis:7-alpine` and the OAuth front `ghcr.io/babs/mcp-auth-proxy:1.4.1`.
- **Published addresses:** the front's `PORT`, `DASHBOARD_PORT` and `METRICS_PORT` are published on `127.0.0.1`. Replace it by the host's LAN IP if the reverse proxy or Prometheus is on another machine or in a container.
- **Docker socket:** `/var/run/docker.sock` (Docker Desktop and a default install). For the rootless Docker socket of a dedicated user, add `compose.rootless.yml` ([`rootless-docker.md`](rootless-docker.md)); for any other, edit the mount in `compose.yml`.
- **The front's own settings:** `PROXY_BASE_URL`, `UPSTREAM_MCP_URL`, `LISTEN_ADDR`, `METRICS_ADDR`.
