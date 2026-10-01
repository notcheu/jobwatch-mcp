# 10 — Deployment and operations

> **Related docs:** Load for Docker, compose, Nginx, CI/CD, Watchtower and observability. Also load: `09` (hardening), `05` (browser image), `06` (container limits), `03` (config keys, endpoints), `02` (front and OAuth), `01` (D8-D10). Follow a link only if the task needs it.

## Host prerequisites (Ubuntu LTS)
- **Rootless Docker** for a dedicated user `mcpuser` (no sudo, not in the `docker` group; leave your existing rootful Docker untouched or disabled for this user). One-time setup, as root:
  ```bash
  sudo apt install -y uidmap dbus-user-session docker-ce-cli docker-compose-plugin docker-ce-rootless-extras   # from Docker's apt repo (on Nuc-desktop only uidmap and dbus-user-session are missing)
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
  The daemon socket is `/run/user/<uid>/docker.sock` (`$XDG_RUNTIME_DIR/docker.sock`). Rootless limits to know: no ports below 1024 (we use 8080/9464), slower networking (slirp4netns/pasta), and cgroup limits need cgroup v2 delegation (next line).
- cgroup v2 with delegation to user services (VERIFY: `systemctl --user` with `Delegate=yes`; `cat /sys/fs/cgroup/cgroup.controllers`).
- `loginctl enable-linger mcpuser` so user services start at boot.
- zram swap enabled on the host (spike S3/S7 decides size); disk encryption recommended.
- **RAM:** the browser runtime needs about 1.5 GB (`memory.max`) on top of the always-on services (`06-…` "Measured budget"). Plan for at least 2 GB genuinely free when a runtime starts. The current home machine (3.8 GB total, 1.0-1.7 GB available, swap nearly full) does not guarantee that. **Decision (Matthieu, 2026-10-01): no hardware upgrade for now; look into zram** (and, if needed, freeing memory during the routine window). Until that is done, treat RAM as the main operational risk: expect `budget_exceeded`/`oom_killed` errors and slower navigation under pressure.
- Time sync (NTP), automatic security updates, UFW: allow inbound only from the Nginx host to the single published port (or nothing at all if Nginx runs on this host and the port is bound to `127.0.0.1`).
- Record in `docs/measurements.md`: CPU arch, RAM, free RAM idle, disk free, Ubuntu version, runtime versions.

## Directory layout on the host
```
/srv/jobwatch/                 (owner mcpuser:mcpuser, mode 0750)
  compose/compose.yml
  secrets/                     (0700)  front secrets, shared secret (file-based secrets)
  data/                        router SQLite, logs (0700)
  profiles/linkedin|apec|wttj  browser profiles (0700) — NEVER in git or plain backups
  images/                      Dockerfiles (build context)
```

## Services declared in compose (always-on)
1. **front** — OAuth front (decision D7: R0Wi/mcp-gateway or babs/mcp-auth-proxy); the only service with a published host port (`${JW_BIND}:${JW_PORT}`, default `127.0.0.1:8080`); forwards authenticated MCP traffic to the router on `jobwatch-core`.
2. **router** — this project; built from the repo-root `Dockerfile`; mounts the rootless runtime socket (user-level), `/srv/jobwatch/data`, `/srv/jobwatch/profiles` (for passing volume paths to spawned containers), catalog (baked into the image). No published port.
Browser containers are **not** declared in compose; the router spawns them with `docker run` (label `jobwatch.managed=true`). Your existing Nginx stays outside this stack.

## Router image (`Dockerfile`)
Multi-stage build from the repo root: `deps` (`npm ci`) → `build` (`npm run build`, must also copy non-TS assets such as `adapters/**/extract.js` into `dist/`) → `prod-deps` (`npm ci --omit=dev`) → `runtime` (Node 26 slim, `tini`, a remote-only container CLI, non-root user `node`, `catalog/` baked in, `HEALTHCHECK` on `/healthz`). The filesystem is read-only at run time; state lives in `/data`.
```bash
docker build -t jobwatch-router:dev .                       # run as mcpuser so it uses the rootless daemon
docker compose -f deploy/compose.yml --env-file deploy/.env build router
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
```
Planned `package.json` scripts: `docker:build` (the first command), `docker:up`. VERIFY when the code exists: the `docker:<version>-cli` tag used to copy the CLI (`DOCKER_CLI_VERSION` build arg), `better-sqlite3` prebuilt binaries on Node 26 (otherwise add a build toolchain to the `deps` stage only), and that the published image runs with `read_only: true`. The browser image (`images/browser/`) is built separately (see `05-…`). The `Dockerfile`, `.dockerignore` and `deploy/compose.yml` have not been built yet because the router code does not exist.

## compose.yml
Lives in `deploy/compose.yml` (variables in `deploy/.env`, template `deploy/.env.example`). Adapt after D7.
Notes: only the front publishes the MCP port; the router publishes only the optional metrics port (9464); spawned browsers attach to `jobwatch-browsers` only. If the router cannot attach spawned containers to a compose-created network, create it with `docker network create --internal jobwatch-browsers` and mark it `external: true`.

## Nginx (your existing reverse proxy)
Add a `server` block for the connector hostname; the upstream is the published port.
```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key: as for your other hosts

    location / {
        proxy_pass http://127.0.0.1:8080;      # JW_BIND:JW_PORT
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;                   # Streamable HTTP / SSE must not be buffered
        proxy_cache off;
        proxy_read_timeout 300s;               # longer than the slowest tool timeout (catalog timeout_s) + queue time
        proxy_send_timeout 300s;
    }
}
```
Rules: route every path (`/.well-known/*`, `/register`, `/authorize`, `/token`, `/mcp`) to the front; do not rewrite paths; do not put a login page, WAF challenge or rate-limit rule in front of the OAuth endpoints; if you allowlist `160.79.104.0/21`, keep `/.well-known/*`, `/register`, `/token` reachable from it (Anthropic's discovery runs from that range). Set `JW_BASE_URL` to the public `https://` URL exactly as Nginx serves it. VERIFY in spike S8.

## CI/CD: build, publish, auto-update
Same pattern as the TraderTavern project: GitHub Actions builds the image and pushes it to your **private registry**; **Watchtower** on the Ubuntu host notices the new digest and restarts the router. Workflow: `.github/workflows/docker-publish.yml`.

```
push to main → [test job: lint, typecheck, unit+contract, catalog drift] → build router image (Buildx, linux/amd64, provenance: false)
             → push <registry>/jobwatch-router:latest → Watchtower (host, polls) → pulls + recreates router
```
- **GitHub secrets:** `REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` (same names as TraderTavern). The test job is skipped until `package.json` exists.
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
Create user, enable linger, install runtime, create dirs, create networks, build images, fill `secrets/` and `deploy/.env`, bring up compose, add the Nginx server block and reload Nginx, add the connector in Claude, perform the LinkedIn login (see `05-…`), run the acceptance checklist in `02-…`.

### Session expired / `needs_login` or `checkpoint`
The routine notifies Matthieu. Procedure: `jobwatch login linkedin` → SSH tunnel to the viewer → log in → `jobwatch login --done`. After a checkpoint wait 24 h and reduce budgets.

### Out of memory / runtime killed
Look at `memory_report` and the call log (`peak_rss_mb`). Lower per-tool `max_cards`, enable resource blocking, raise `memory.max` only if the host has headroom, or reduce `renderer-process-limit`.

### Rotating secrets
Front secrets and the shared secret: change in `secrets/`, restart front+router. OAuth signing key rotation: per the front's docs; re-add the connector if required.

### Disk/profile hygiene
Weekly: prune unused images; Chrome caches inside profiles can grow — delete `Cache`/`Code Cache` folders monthly while stopped. Never delete `Cookies`/`Preferences` unless re-logging in.

### Uninstall
`compose down`, remove images, remove connector in Claude, delete `/srv/jobwatch/profiles`, revoke sessions in LinkedIn (Settings → sign-in & security → where you're signed in).

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
