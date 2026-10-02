# 10 — Deployment and operations

> **Related docs:** Load for Docker, compose, Nginx, CI/CD, Watchtower and observability. Also load: `09` (hardening), `05` (browser image), `06` (container limits), `03` (config keys, endpoints), `02` (front and OAuth), `01` (D8-D10). Follow a link only if the task needs it.

## Host prerequisites (Ubuntu LTS)
- **Rootless Docker** for a dedicated user `mcpuser` (no sudo, not in the `docker` group; leave your existing rootful Docker untouched or disabled for this user). One-time setup, as root:
  ```bash
  sudo apt install -y uidmap dbus-user-session docker-ce-cli docker-compose-plugin docker-ce-rootless-extras   # from Docker's apt repo (on the reference host only uidmap and dbus-user-session are missing)
  sudo adduser --disabled-password mcpuser
  echo "jobwatch:100000:65536" | sudo tee -a /etc/subuid /etc/subgid     # only if not already present
  sudo loginctl enable-linger mcpuser
  ```
  **Ubuntu 24.04 only** (`kernel.apparmor_restrict_unprivileged_userns=1`): allow rootlesskit to create user namespaces, otherwise the daemon fails with a permission error. VERIFY the exact profile against Docker's rootless docs for your version:
  ```
  # /etc/apparmor.d/usr.bin.rootlesskit
  abi <abi/4.0>,
  include <tunables/global>
  /usr/bin/rootlesskit flags=(unconfined) {
    userns,
    include if exists <local/usr.bin.rootlesskit>
  }
  ```
  then `sudo systemctl restart apparmor.service`.

  then as `mcpuser` (login with `sudo apt install systemd-container && sudo machinectl shell mcpuser@` so the user systemd session exists):
  ```bash
  dockerd-rootless-setuptool.sh install
  systemctl --user enable --now docker
  export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock     # persist in ~/.bashrc
  docker info | grep -i rootless                              # must list "rootless"
  ```
  The daemon socket is `/run/user/<uid>/docker.sock` (`$XDG_RUNTIME_DIR/docker.sock`). Rootless limits to know: no ports below 1024 (we use 18931/9464 on the host), slower networking (slirp4netns/pasta), and cgroup limits need cgroup v2 delegation (next line).
- cgroup v2 with delegation to user services (VERIFY: `systemctl --user` with `Delegate=yes`; `cat /sys/fs/cgroup/cgroup.controllers`).
- `loginctl enable-linger mcpuser` so user services start at boot.
- zram swap enabled on the host (spike S3/S7 decides size); disk encryption recommended.
- **RAM:** the browser runtime needs about 1.5 GB (`memory.max`) on top of the always-on services (`06-…` "Measured budget"). Plan for at least 2 GB genuinely free when a runtime starts. The reference host (3.8 GB total, 1.0-1.7 GB available, swap nearly full) does not guarantee that. **Decision (the owner, 2026-10-01): no hardware upgrade for now; look into zram** (and, if needed, freeing memory during the routine window). Until that is done, treat RAM as the main operational risk: expect `budget_exceeded`/`oom_killed` errors and slower navigation under pressure.
- Time sync (NTP), automatic security updates, UFW: allow inbound only from the Nginx host to the single published port (or nothing at all if Nginx runs on this host and the port is bound to `127.0.0.1`).
- Record in `docs/measurements.md`: CPU arch, RAM, free RAM idle, disk free, Ubuntu version, runtime versions.

## Directory layout on the host
```
/srv/jobwatch/                 (owner mcpuser:mcpuser, mode 0750)   # or the cloned repo; paths below are relative to deploy/
  deploy/compose.yml, deploy/.env (0600, secrets), deploy/nginx/*.conf
  data/router                  router SQLite, logs (0700)
  (Redis keeps its data in the named volume redis-data)
  data/front                   (reserved)
```
Browser profiles are **not** host directories: they are named Docker volumes `jw-profile-<platform>` in the `mcpuser` rootless daemon's storage (`~/.local/share/docker/volumes`), created by the router. This keeps the compose file and the router identical on Linux and macOS. Never in git, never in plain backups.

## Services declared in compose (always-on)
1. **front** — `ghcr.io/babs/mcp-auth-proxy` (decision D7): OAuth 2.1 authorization server (DCR, PKCE, RFC 9728/8414) that signs users in with **Google** and reverse-proxies `/mcp` to the router. The only service with a published host port (`${JW_BIND}:${JW_HOST_PORT}`, default `127.0.0.1:18931`).
2. **redis** — small (32 MB cap) store the front needs for single-use authorization codes and refresh-token rotation. Not published.
3. **router** — this project; built from the repo-root `Dockerfile`; mounts the rootless runtime socket, `data/router`. No published MCP port (only the optional metrics port).
4. **watchtower** — updates the labelled router image.
Browser containers are **not** declared in compose; the router spawns them with `docker run` (label `jobwatch.managed=true`). Your existing Nginx stays outside this stack.

## Router image (`Dockerfile`)
Multi-stage build from the repo root of the Nx workspace: `deps` (`npm ci`; the whole workspace, including `tools/`, must be copied so it matches the lockfile) → `build` (`nx run-many -t build -p @jobwatch/mcp @jobwatch/cli`, which bundles each app into one file with esbuild; the browser driver `playwright-core` will stay external and is listed in `apps/mcp/external-deps.package.json`, empty until step 6 (SQLite is Node's built-in `node:sqlite`, nothing native); adapter assets such as `extract.js` are inlined or copied) → `prod-deps` (installs only those external packages, pinned) → `runtime` (Node 26 slim, `tini`, a remote-only container CLI, non-root user `node`, `catalog/` baked in, `HEALTHCHECK` on `/healthz`). The filesystem is read-only at run time; state lives in `/data`.
```bash
docker build -t jobwatch-router:dev .                       # run as mcpuser so it uses the rootless daemon
docker compose -f deploy/compose.yml --env-file deploy/.env build router
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
```
**Built and run for real on 2026-10-01** (Docker Desktop, arm64, Node 26 image; the CI builds `linux/amd64` and `linux/arm64`): the image is about 457 MB; with the compose hardening (`--read-only`, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `--user 1000:1000`) it reports `healthy` through its own Docker health check, answers `/healthz` and `tools/list`, runs `jobwatch` inside, and stops on SIGTERM in under a second with exit code 0. Three defects only a real build could show were fixed: `COPY --from` does not expand variables (the Docker CLI is now a named stage), `npm ci` needs the `tools/` workspace copied too, and `/data` must exist in the image owned by the runtime user, otherwise `jobwatch adapters enable` fails with a permission error on a fresh named volume. The `# syntax=docker/dockerfile` directive was dropped on purpose (extra Docker Hub round-trip; the built-in frontend is enough).
**Confirmed on the reference host (2026-10-01, rootless Docker):** a bind mount keeps the host owner, and uid 1000 in the container maps to a different host uid than `mcpuser`, so the router could not open `/data/jobwatch.sqlite` (EACCES). The router therefore runs as `user: "0:0"` in `deploy/compose.yml`: root in the container is `mcpuser` on the host, with `cap_drop: ALL`, `no-new-privileges` and a read-only root filesystem. This also lets it open the rootless Docker socket. `docker compose exec router jobwatch ...` runs as the same user, so `adapters.json` is written correctly. **Still to verify:** the amd64 image start-to-finish (CI builds it), and the browser image (`images/browser/`, built separately, see `05-…`).

## compose.yml
Lives in `deploy/compose.yml`; variables in `deploy/.env` (template `deploy/.env.example`, **the real file holds secrets: chmod 600, never commit**). Only the front publishes the MCP port; the router publishes only the optional metrics port (9464); spawned browsers attach to `jobwatch-browsers` only. If the router cannot attach spawned containers to a compose-created network, create it with `docker network create --internal jobwatch-browsers` and mark it `external: true`.
Front settings that matter (`babs/mcp-auth-proxy`, defaults are production-safe: `PROD_MODE`, PKCE required, consent page, per-IP rate limits): `PROXY_BASE_URL=https://mcp.example.com`, `UPSTREAM_MCP_URL=http://router:8080/mcp`, `OIDC_ISSUER_URL=https://accounts.google.com`, `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` (from Google), `TOKEN_SIGNING_SECRET` (`openssl rand -base64 48`, keep it stable: changing it invalidates all tokens), `REDIS_URL`, `TRUSTED_PROXY_CIDRS` (Nginx address as seen by the container; `172.17.0.1/32` is the usual Docker gateway when Nginx runs on the host, else its LAN IP; with rootless Docker check `docker network inspect jobwatch_jobwatch-core`). Metrics/readyz are on `127.0.0.1:9090` inside the container (not published). **Verified 2026-10-01 (S1 run on the reference host):** the front starts with these variable names, listens on `:8080` inside the container (metrics on `127.0.0.1:9090`), reaches Redis by name, and answers through Nginx at `https://mcp.example.com/mcp` with `401` + `WWW-Authenticate: Bearer … resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`. **Still to verify (S1):** a `*_FILE` variant for the client secret, and that the front forwards the original path `/mcp` to the router.

## Operator dashboard
Closed by default. On the host: `docker compose -f deploy/compose.yml --env-file deploy/.env exec router jobwatch dashboard start`, then open `https://<domain>/dashboard`; it closes after 30 minutes without a request (`JW_DASHBOARD_IDLE_S`, or `--ttl <minutes>`), or with `dashboard stop`. Nothing else can start it.
- **Compose**: the router publishes `${JW_DASHBOARD_BIND:-127.0.0.1}:${JW_DASHBOARD_HOST_PORT:-18933}` (container port 8090); nothing listens behind it until the dashboard is started.
- **Nginx**: `deploy/nginx/mcp.example.com.conf` has `location /dashboard` (before `location /`) that proxies to that port with its own rate limit (`limit_req_zone jw_dashboard`, which belongs in the `http` context) and answers a short "The dashboard is off" page while it is closed. The dashboard does not go through the OAuth front. `nginx -t` passes on the file with throwaway certificates.
- **Google**: it signs in with the connector's OAuth client by default (compose passes `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` to the router as `JW_DASHBOARD_OIDC_CLIENT_ID` and `_SECRET`). **Add `https://<domain>/dashboard/auth/callback` to that client's authorized redirect URIs** in Google Cloud Console. Who may sign in is the Google app's decision (its test users); there is no email allowlist in the dashboard. A client of its own (own secret, so a leak does not touch the connector) is the cleaner option: set `JW_DASHBOARD_OIDC_CLIENT_ID` and `_SECRET` in `deploy/.env`.
- **Local development** (`compose.dev.yml`, `JW_AUTH=none`): no sign-in; `jobwatch dashboard start` and open `http://127.0.0.1:18933/dashboard/`.

## Google sign-in (the identity provider)
Access is limited to the owner by the Google OAuth app itself: while the app is in **Testing** status only listed test users can sign in, and the front has no email allowlist of its own.
1. Google Cloud Console → create a project (e.g. `jobwatch-mcp`) → **APIs & Services → OAuth consent screen**: user type **External**, app name, your support email; scopes `openid`, `email`, `profile` (non-sensitive, no verification needed); **Test users: add only your own Google account**; leave **Publishing status = Testing**. Do not publish the app.
2. **Credentials → Create credentials → OAuth client ID → Web application**; **Authorized redirect URI: `https://mcp.example.com/callback`** (the front's OIDC callback, `{PROXY_BASE_URL}/callback`). Copy the client ID and secret into `deploy/.env` as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
3. Generate `TOKEN_SIGNING_SECRET=$(openssl rand -base64 48)` into `deploy/.env`.
4. Acceptance (also in `02-…`): your account completes the sign-in; a second Google account is refused by Google ("access blocked"); the front never issues a token without the Google step.
Notes: the front only uses Google to authenticate the person; it does not keep Google refresh tokens, so Google's 7-day limit on test-app refresh tokens does not apply. The front's own refresh tokens last 7 days (see D7).

## Nginx for `mcp.example.com` (your existing reverse proxy; not running yet)
Files in `deploy/nginx/`: `mcp.example.com.bootstrap.conf` (port 80 only, for the certificate) and `mcp.example.com.conf` (final site). Both pass `nginx -t` (tested in the `nginx:alpine` image with throwaway certificates; the real certificate and the live proxying are untested). Paths below assume Nginx installed on the Ubuntu host (Debian layout); adapt if it runs in a container.
1. **DNS:** create `mcp.example.com` as an `A` record (and `AAAA` only if your IPv6 forwards to the host) pointing at your home public IP, or a CNAME to the dynamic-DNS name you already use for other hosts. Check: `dig +short mcp.example.com`.
2. **Port redirection on the home router:** forward TCP **80 and 443** to the machine running Nginx (static LAN IP or DHCP reservation). If your other sites already work from the internet, these rules exist and nothing changes. Allow them in UFW (`sudo ufw allow 80,443/tcp`). The MCP host port (18931) is **never** forwarded: it stays on `127.0.0.1`.
3. **Bootstrap site:** `sudo mkdir -p /var/www/certbot && sudo cp deploy/nginx/mcp.example.com.bootstrap.conf /etc/nginx/sites-available/mcp.example.com && sudo ln -s /etc/nginx/sites-available/mcp.example.com /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx`.
4. **Certificate:** `sudo certbot certonly --webroot -w /var/www/certbot -d mcp.example.com` (renewal is handled by certbot's timer; the final site keeps the same ACME location).
5. **Final site:** `sudo cp deploy/nginx/mcp.example.com.conf /etc/nginx/sites-available/mcp.example.com && sudo nginx -t && sudo systemctl reload nginx`. If Nginx runs in a container, change `proxy_pass http://127.0.0.1:18931` to the Docker host address and set `JW_BIND` to an interface that address can reach (never `0.0.0.0` without a firewall rule).
6. **Smoke test** (after `docker compose up -d`): `curl -i https://mcp.example.com/mcp` must return `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`; `curl -s https://mcp.example.com/.well-known/oauth-authorization-server` returns JSON with `registration_endpoint` and `code_challenge_methods_supported: ["S256"]`.
**Expected state before the stack runs: `502 Bad Gateway`** (Nginx resolves and proxies, but nothing listens on 18931 yet). Once the front is up, the same URL returns `401`.
Rules: route every path to the front; do not rewrite paths; no login page, WAF challenge or rate-limit rule in front of the OAuth endpoints; if you allowlist `160.79.104.0/21`, keep `/.well-known/*`, `/register` and `/token` reachable from it (an example `location = /mcp` allowlist is commented in the site file). Set `JW_BASE_URL` to exactly `https://mcp.example.com`.

## Other hosts: macOS (Apple Silicon) and other Linux (decided 2026-10-01)
The images may run on something other than the reference Ubuntu host, typically a Mac. What is portable and what is not:
- **Router image:** multi-arch (`linux/amd64`, `linux/arm64`), built by the CI workflow with QEMU. Pull or build it on the Mac as usual.
- **Browser image:** amd64 uses Google Chrome stable; **arm64 uses Debian Chromium** (Google ships no Linux arm64 Chrome). Build locally with `docker build -t jobwatch-browser:dev images/browser` (the Dockerfile selects the browser from `TARGETARCH`). **Do not use the arm64 image for the LinkedIn session:** Chromium reports a different brand list and other signals, so the logged-in profile and the daily routine stay on the amd64 reference host. Emulating amd64 Chrome on Apple Silicon is slow and crash-prone; not supported.
- **Runtime:** Docker Desktop (or OrbStack/Colima) instead of rootless Docker. Set `JW_DOCKER_SOCKET=/var/run/docker.sock`. Its socket is root-equivalent inside the VM and the router then runs as `user: "0:0"`; acceptable for local development, **not for the production host**.
- **No host paths:** profiles are named volumes and the seccomp profile is passed by file to the Docker CLI, so nothing depends on `/srv/...` or `XDG_RUNTIME_DIR`.
- **Development without OAuth:** `docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up router` runs only the router on `http://127.0.0.1:18932/mcp` with `JW_AUTH=none` (accepted only on loopback). Test with the MCP Inspector or `claude mcp add --transport http jobwatch-dev http://127.0.0.1:18932/mcp`. The full front needs the public hostname and cannot run on a laptop without a tunnel; test it on the reference host.
- **Memory:** Docker Desktop's VM has its own memory limit (Settings → Resources); give it at least 3 GB to run Chromium plus the router. The Linux-only spike scripts (`spikes/host/*.sh`, GNU `date`, `hostname -I`, rootless checks) are reference host tools, not portable.
- **Never** treat a Mac run as evidence for the budgets in `06-…`: those were measured on the amd64 reference host with Google Chrome.

## CI/CD: build, publish, auto-update
Same pattern as the TraderTavern project: GitHub Actions builds the image and pushes it to your **private registry**; **Watchtower** on the Ubuntu host notices the new digest and restarts the router. Workflow: `.github/workflows/docker-publish.yml`.

```
push to main → [test job: lint, typecheck, unit+contract, catalog drift] → build router image (Buildx, linux/amd64 + linux/arm64, provenance: false)
             → push <registry>/jobwatch-router:latest → Watchtower (host, polls) → pulls + recreates router
```
- **GitHub secrets:** `REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` (same names as TraderTavern). **They are not configured on this repository yet** (checked 2026-10-01 with `gh secret list`): until they are, the publish job skips itself with a notice instead of failing, so `main` stays green. Add them in the repository settings (Secrets and variables, Actions) to start publishing.
- **`provenance: false` is required:** a provenance attestation turns the push into an OCI index with an `unknown/unknown` platform entry that Watchtower cannot resolve. Do not remove it.
- **Single tag:** only `latest` is published, and Watchtower follows it. There is no versioned rollback tag; to roll back, revert the commit on `main` and let CI publish again.
- **Host side (`deploy/compose.yml`):** the router uses `image: ${JW_REGISTRY}/jobwatch-router:${JW_TAG:-latest}` and carries the label `com.centurylinklabs.watchtower.enable=true`. A `watchtower` service runs with `WATCHTOWER_LABEL_ENABLE=true`, so **only the router** auto-updates; the OAuth front stays pinned by digest (supply chain, `09-…`). Watchtower mounts the same rootless socket and the `mcpuser` user's `~/.docker/config.json` (read-only) to authenticate to the registry. Log in once on the host: `docker login <registry>` as `mcpuser`.
- **Browser image:** not auto-updated (spawned containers are invisible to Watchtower, and rebuilding Chrome should be deliberate). Build and push it from a separate workflow triggered only by changes under `images/browser/`, and pull the new tag by hand, then bump `JW_BROWSER_IMAGE`.
- **Restart safety:** Watchtower may recreate the router while a call is running. On startup the router must reap orphan containers labelled `jobwatch.managed=true` and reconcile state from SQLite; a failed in-flight call is returned to Claude as an error and the routine retries. Set Watchtower to a quiet schedule (`WATCHTOWER_SCHEDULE`, e.g. after the daily routine) rather than the default poll interval.
- **Caveats to VERIFY:** the original `containrrr/watchtower` is archived, so pick a maintained fork and check it supports the rootless socket and current Docker API version; verify the registry is reachable from the host and uses valid TLS.

## Autostart
Rootless Docker starts at boot through `systemctl --user enable docker` + `loginctl enable-linger mcpuser`. The compose services use `restart: unless-stopped`, so they return with the daemon; alternatively a user unit that runs `docker compose up -d`; `Restart=on-failure`; slice with `MemoryMax` for the always-on services (small) and a separate slice for spawned browsers.

## Build/update procedure
1. Merge to `main`: CI tests, builds and pushes the router image (see "CI/CD" above). Manual path: `git pull`, run tests, `docker build`.
2. Build browser image only when Chrome/entrypoint changes; tag by Chrome major; keep the previous tag.
3. Router: Watchtower pulls `latest` automatically (or `docker compose pull router && docker compose up -d router`); check `/healthz`. Front/browser images: update tags/digests by hand.
4. Run `session_status all` and the smoke test; if red, roll back the tag.

## Runbooks
### First-time setup
1. User `mcpuser`, linger, rootless Docker (Host prerequisites above).
2. DNS record and router port forwarding for `mcp.example.com` (Nginx section, steps 1-2).
3. Google OAuth app in Testing mode, with only your account as test user ("Google sign-in" section).
4. `cp deploy/.env.example deploy/.env && chmod 600 deploy/.env`, fill `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TOKEN_SIGNING_SECRET`, `JW_NGINX_CIDR`, `JW_REGISTRY`, `JW_WATCHTOWER_IMAGE`; `mkdir -p data/router`.
5. Nginx: bootstrap site, certbot, final site (Nginx section, steps 3-5).
6. `docker login <registry>` as `mcpuser`; `docker compose -f deploy/compose.yml --env-file deploy/.env up -d`; run the smoke test (Nginx section, step 6).
7. Add `https://mcp.example.com/mcp` as a custom connector in Claude, sign in with your Google account, then the acceptance checklist in `02-…`.
8. LinkedIn login through noVNC (`05-…`).

### Session expired / `needs_login` or `checkpoint`
The routine notifies the owner. Procedure: `jobwatch login start linkedin` → SSH tunnel to the viewer → log in → `jobwatch login stop linkedin`. After a checkpoint wait 24 h and reduce budgets.

### Out of memory / runtime killed
Look at `memory_report` and the call log (`peak_rss_mb`). Lower per-tool `max_cards`, enable resource blocking, raise `memory.max` only if the host has headroom, or reduce `renderer-process-limit`.

### Enabling or disabling an adapter
On the reference host, as `mcpuser`: `docker compose -f deploy/compose.yml --env-file deploy/.env exec router jobwatch adapters list` shows every installed adapter and whether it is enabled; `... adapters enable linkedin` / `disable linkedin` edits `data/router/adapters.json` (the router mounts `data/router` at `/data`). Then `docker compose ... restart router`, and refresh the connector in Claude if the tool list does not update. A fresh install has nothing enabled. If `JW_ADAPTERS` is set in `deploy/.env` it wins and the CLI refuses to edit. Enabling `linkedin` requires the approved usage budget (`09-security.md`).

### Rotating secrets
`OIDC_CLIENT_SECRET` (rotate in Google Cloud Console, update `deploy/.env`, `docker compose up -d front`). `TOKEN_SIGNING_SECRET`: changing it invalidates every issued token and registered client, so Claude must reconnect (remove and re-add the connector). Redis data (`data/redis`) can be wiped; it only costs in-flight refresh rotations.

### Disk/profile hygiene
Weekly: prune unused images; Chrome caches inside profiles can grow — delete `Cache`/`Code Cache` folders monthly while stopped. Never delete `Cookies`/`Preferences` unless re-logging in.

### Uninstall
`compose down`, remove images, remove connector in Claude, delete the `jw-profile-*` Docker volumes (`docker volume rm`), revoke sessions in LinkedIn (Settings → sign-in & security → where you're signed in).

## Observability (optional Prometheus + Grafana)
- **Logs:** JSON lines to stdout (docker/journald); router call log in SQLite (30-day retention).
- **Metrics → Prometheus → Grafana:** set `JW_METRICS_ENABLED=true` and the router exposes `/metrics` on `JW_METRICS_PORT` (default 9464, separate from the MCP port; metric list in `03-…`). The compose file publishes it on `${JW_METRICS_BIND:-127.0.0.1}:${JW_METRICS_PORT:-9464}`; set `JW_METRICS_BIND` to the LAN address your Prometheus can reach (or attach the router to the network your Prometheus already shares). Never route it through Nginx or the OAuth front.
```yaml
# prometheus.yml (your existing instance)
scrape_configs:
  - job_name: jobwatch-router
    scrape_interval: 30s
    static_configs:
      - targets: ["<host-lan-ip>:9464"]
```
- **Logs in Grafana:** Prometheus stores metrics, not log lines. To see the JSON logs in Grafana, ship container stdout to Loki (Grafana Alloy/Promtail reading Docker logs, or the Loki Docker logging driver) and add Loki as a data source; the log fields (`tool`, `platform`, `result`, `cold_start`, `peak_rss_mb`) can be parsed with `| json`. Skip this if you only want metrics dashboards.
- **Suggested dashboard panels:** calls by result code, p95 duration per tool, runtime state timeline, peak RSS vs `memory.max`, cold starts per day, breaker open, queue wait.
- **Alerts:** the routine itself reports `needs_login`/errors via its notification; optional Grafana alerts on `jw_breaker_open == 1`, peak RSS above 90% of the cap, or `up{job="jobwatch-router"} == 0`.
