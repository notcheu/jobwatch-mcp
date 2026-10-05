# Environment variables

Where to set them:

- **Docker Compose:** in the `.env` file next to `compose.yml` (template: [`deploy/.env.example`](../deploy/.env.example)). The OAuth front and the router each get the whole file as their environment, so every variable below works there without touching `compose.yml`. Compose also expands `${VAR}` inside the file (`LISTEN_ADDR=0.0.0.0:${PORT}`).
- **`npm run dev` / `npm run start`:** in `.env.local` (committed defaults, no secrets) and `.env` (yours, `start` only); a variable set in the shell wins. See [`/.env.local`](../.env.local).

All variables are optional unless noted. An empty value counts as "not set". They are validated at startup by one zod schema, `packages/core/src/env.ts`, which is the source of truth: a bad value stops the server with the list of problems (never the values). The variables used to start with `JW_` (`JW_PORT`); that prefix was dropped, and a variable that still has it is reported and not read. The design is in [`plans/03-router-spec.md`](plans/03-router-spec.md).

- [General](#general)
- [Modules](#modules)
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
| `PORT` | `8080`; `18931` in the example files | Port of the MCP server (1024-65535). In Docker Compose it is also the port the OAuth front listens on and the one published on the host (`BIND:PORT`). |
| `DATA_DIR` | `/data`; `./.data` for `npm run dev` and `start` | Holds the SQLite database, `adapters.json` and, with `LOCAL_CHROME`, the browser profiles. In Compose it is `./data` next to the compose file, mounted at `/data`. |
| `DB_PATH` | `<DATA_DIR>/jobwatch.sqlite` | The SQLite file. The schema is migrated at every boot. |
| `JOB_RETENTION_DAYS` | `30` | Days a stored job is kept after it was last seen (1-3650). |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. |
| `RUNTIME` | `docker` | Container runtime for the browser. Only `docker` is implemented. |
| `TOKEN_CHARS_PER_TOKEN` | `3.5` | Characters per token, for the estimate of what a result costs Claude (1-10). |

## Modules

See [Modules](../README.md#modules) in the README for what a module is.

| Variable | Default | Meaning |
|---|---|---|
| `ADAPTERS` | unset | Comma list of adapters (`apec,wttj`). Pins the list: it overrides `adapters.json` and the CLI can no longer change it. Unset = what `jobwatch adapters enable` wrote; nothing is enabled by default. |
| `UTILITIES` | unset | The same for utilities (`linkedin-geo,ats-discovery`). |
| `DEFAULT_LOCATION` | unset | Where LinkedIn searches look when a call gives no `geo`: a place name (`Berlin, Germany`) or a LinkedIn geoId. No place is built in. |
| `LINKEDIN_GEO_ALIASES` | unset | Names for LinkedIn geoIds you use often (`home=104246759,europe=91000000`). |

## OAuth

Needed only for the public deployment behind the OAuth front. Step by step: [`oauth.md`](oauth.md).

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_CLIENT_ID` | | Client ID of your Google OAuth client. The router reads it too, as the dashboard's default client. |
| `OIDC_CLIENT_SECRET` | | Its secret. Never commit it. |
| `TOKEN_SIGNING_SECRET` | | `openssl rand -base64 48`. Keep it identical across restarts; changing it invalidates every issued token. |
| `PROXY_BASE_URL` | | The front's public URL: the same as `BASE_URL`. Required by the front. |
| `UPSTREAM_MCP_URL` | | Where the front forwards `/mcp`: `http://router:${PORT}/mcp`. Required by the front. |
| `OIDC_ISSUER_URL` | | `https://accounts.google.com`. Required by the front. The dashboard uses it too unless `DASHBOARD_OIDC_ISSUER` is set. |
| `TRUSTED_PROXY_CIDRS` | | Address of your reverse proxy as the front sees it (the Docker gateway `172.17.0.1/32` if the proxy runs on the host, else its LAN IP followed by `/32`). |
| `LISTEN_ADDR` | front default `:8080` | Where the front listens in its container: `0.0.0.0:${PORT}`. |
| `METRICS_ADDR` | front default `127.0.0.1:9090` | Where the front's own metrics and `/readyz` answer, inside its container (never published). |
| `FRONT_SHARED_SECRET` | unset | At least 16 characters. When set with `AUTH=front`, the router requires it as a shared secret from the front. |
| `DASHBOARD_OIDC_CLIENT_ID`, `DASHBOARD_OIDC_CLIENT_SECRET` | the connector's client | A Google OAuth client of its own for the dashboard sign-in. |
| `DASHBOARD_OIDC_ISSUER` | `OIDC_ISSUER_URL`, else `https://accounts.google.com` | OIDC issuer of the dashboard sign-in. |

## Browser

Used by the browser modules (`linkedin`, `apec`, `wttj`). HTTP-only modules never start a browser. Three sources of Chrome, in this order of precedence: `CDP_URL`, `LOCAL_CHROME`, then a container (default).

### Which Chrome

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_CHROME` | `false` (`true` in `.env.local`) | Start a visible Chrome on this machine, with a profile per platform in `<DATA_DIR>/browser-profiles/`. |
| `LOCAL_CHROME_PATH` | auto | Chrome executable for `LOCAL_CHROME`, when it is not found in the usual places. |
| `CDP_URL` | unset | Attach to a Chrome that is already running: a loopback DevTools URL such as `http://127.0.0.1:9222` (start Chrome with `--remote-debugging-port` and its own `--user-data-dir`). Wins over `LOCAL_CHROME`. The server only opens and closes tabs of its own. |

### Container (the default)

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_IMAGE` | `localhost/jobwatch-browser:1` (`jobwatch-browser:latest` in `compose.yml`) | Browser image the router spawns. |
| `BROWSER_NETWORK` | `jobwatch-browsers` | Internal Docker network of the browsers (Compose names it `<project>_jobwatch-browsers`, set in `compose.yml`). |
| `BROWSER_SECCOMP` | unset | Absolute path of the Chrome seccomp profile as the docker CLI sees it; unset = Docker's default profile. |
| `PROFILE_VOLUME_PREFIX` | `jw-profile-` | Browser profiles are Docker volumes named `<prefix><platform>`. |
| `FINGERPRINT` | `enforce` | Startup check that the container's Chrome looks like a normal one: `enforce` refuses a browser that fails, `warn` logs, `off` skips. |
| `MEM_HIGH_MB`, `MEM_MAX_MB` | `1200`, `1500` | Soft and hard memory marks of the container (256-16384; high must be lower than max). Per-tool budgets override them. |
| `IDLE_TTL_S` | `120` | Seconds the browser stays up after its last call (10-3600). |
| `MAX_LIFETIME_S` | `1800` | A browser older than this is recycled at the next call (60-86400). |
| `QUEUE_TIMEOUT_S` | `60` | How long a call waits for the single browser before failing with `busy` (1-600). |

### For every source

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_LANG` | `fr-FR` | UI language of the browser. |
| `BROWSER_ACCEPT_LANGS` | unset | `Accept-Language` list, copied from `navigator.languages` of your everyday browser (`fr-FR,en-GB,en-US`). |
| `BROWSER_MAX_TABS` | `3` | Most tabs open at once. `1` = a single tab; more lets adapters open extra tabs. Each tab costs memory and the cap does not change. |

`BROWSER_LANG` and `BROWSER_ACCEPT_LANGS` are handed to the browser container; with `LOCAL_CHROME` or `CDP_URL` the Chrome keeps its own language.

## Operator dashboard

Closed until `jobwatch dashboard start`. Sign-in variables are under [OAuth](#oauth).

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_PORT` | `8090`; `18933` in the example files | Port the dashboard listens on while it is open. In Docker Compose it is published on the host as `DASHBOARD_BIND:DASHBOARD_PORT`. |
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
| `METRICS_PORT` | `9464` | Its port; must differ from `PORT`. In Docker Compose it is published on the host as `METRICS_BIND:METRICS_PORT`. |
| `METRICS_BIND` | `127.0.0.1` | Host address the metrics port is published on. Compose only. |

## Docker Compose

Read by `compose.yml` itself, to build the stack. The router image is `jobwatch-router:latest` and Redis is `redis:7-alpine`, both fixed in `compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `FRONT_IMAGE` | `ghcr.io/babs/mcp-auth-proxy:1.4.1` | OAuth front image; pin it by digest. |
| `BIND` | `127.0.0.1` | Host address the front's `PORT` is published on. Use the host's LAN IP if the reverse proxy is on another machine or in a container. |
| `DASHBOARD_BIND` | `127.0.0.1` | Host address `DASHBOARD_PORT` is published on (nothing listens until the dashboard is started). |
| `DOCKER_SOCKET` | `$XDG_RUNTIME_DIR/docker.sock` | Docker socket mounted into the router. Linux rootless Docker: the default. macOS: `/var/run/docker.sock`. Never a root socket. |

The Watchtower variable (`WATCHTOWER_IMAGE`) belongs to the optional service described in [`watchtower.md`](watchtower.md).
