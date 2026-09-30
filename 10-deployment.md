# 10 — Deployment and operations

## Host prerequisites (Ubuntu LTS)
- Rootless container runtime for a dedicated user `jobwatch` (no sudo): Podman (+ `podman-compose`/`docker compose` pointing at the rootless Podman socket) or rootless Docker.
- cgroup v2 with delegation to user services (VERIFY: `systemctl --user` with `Delegate=yes`; `cat /sys/fs/cgroup/cgroup.controllers`).
- `loginctl enable-linger jobwatch` so user services start at boot.
- zram swap enabled on the host (spike S3/S7 decides size); disk encryption recommended.
- Time sync (NTP), automatic security updates, UFW with no inbound rules (tunnel is outbound).
- Record in `docs/measurements.md`: CPU arch, RAM, free RAM idle, disk free, Ubuntu version, runtime versions.

## Directory layout on the host
```
/srv/jobwatch/                 (owner jobwatch:jobwatch, mode 0750)
  compose/compose.yml
  secrets/                     (0700)  front secrets, shared secret, tunnel token (file-based secrets)
  data/                        router SQLite, logs (0700)
  profiles/linkedin|apec|wttj  browser profiles (0700) — NEVER in git or plain backups
  images/                      Containerfiles (build context)
```

## Services declared in compose (always-on)
1. **tunnel** (e.g. `cloudflared`) — outbound tunnel to the public hostname; routes `/.well-known/*`, `/register`, `/authorize`, `/token`, `/mcp` to the OAuth front.
2. **front** — OAuth front (decision D7: R0Wi/mcp-gateway or babs/mcp-auth-proxy); the only service the tunnel talks to; forwards authenticated MCP traffic to the router on `jobwatch-core`.
3. **router** — this project; mounts the rootless runtime socket (user-level), `/srv/jobwatch/data`, `/srv/jobwatch/profiles` (for passing volume paths to spawned containers), catalog (baked into the image).
Browser containers are **not** declared in compose; the router spawns them with `podman run` (label `jobwatch.managed=true`).

## compose.yml sketch (adapt after D7/D10)
```yaml
name: jobwatch
networks:
  jobwatch-core:     { internal: false }     # tunnel <-> front; front <-> router
  jobwatch-browsers: { internal: true }      # router <-> spawned browsers (created here so the router can attach containers)
services:
  tunnel:
    image: cloudflare/cloudflared:<pinned>
    command: tunnel run
    environment: [ "TUNNEL_TOKEN_FILE=/run/secrets/tunnel_token" ]
    secrets: [ tunnel_token ]
    networks: [ jobwatch-core ]
    restart: unless-stopped
  front:
    image: <front-image>@sha256:<pinned>
    # config: issuer/base URL, single allowed identity, backend = http://router:8080/mcp
    networks: [ jobwatch-core ]
    volumes: [ "../data/front:/data" ]
    restart: unless-stopped
  router:
    build: ../router
    user: "1000:1000"
    read_only: true
    cap_drop: [ ALL ]
    security_opt: [ "no-new-privileges:true" ]
    environment:
      JW_BASE_URL: https://mcp.example.com
      JW_RUNTIME: podman
      CONTAINER_HOST: unix:///run/podman/podman.sock        # rootless user socket mounted below
    volumes:
      - "${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock"
      - "../data/router:/data"
      - "../profiles:/profiles:ro"     # read-only here; browser containers mount the subfolders rw by host path
    networks: [ jobwatch-core, jobwatch-browsers ]
    restart: unless-stopped
secrets:
  tunnel_token: { file: ../secrets/tunnel_token }
```
Notes: the router never gets published ports; the front is reached only through the tunnel; spawned browsers attach to `jobwatch-browsers` only. If the runtime refuses to spawn containers on a network created by compose, create it with `podman network create --internal jobwatch-browsers` and mark it `external: true`.

## Autostart
`podman generate systemd`/Quadlet (`~/.config/containers/systemd/*.container`) or a user unit that runs `compose up -d`; `Restart=on-failure`; slice with `MemoryMax` for the always-on services (small) and a separate slice for spawned browsers.

## Build/update procedure
1. `git pull` the repo; run tests; build router image with a new tag.
2. Build browser image only when Chrome/entrypoint changes; tag by Chrome major; keep the previous tag.
3. Update compose image tags/digests; `compose up -d router`; check `/healthz`.
4. Run `session_status all` and the smoke test; if red, roll back the tag.

## Runbooks
### First-time setup
Create user, enable linger, install runtime, create dirs, create networks, build images, fill `secrets/`, bring up compose, configure tunnel/domain, add the connector in Claude, perform the LinkedIn login (see `05-…`), run the acceptance checklist in `02-…`.

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

## Observability
- Logs: JSON to stdout → journald; router call log in SQLite (30-day retention).
- Metrics (optional): `/metrics` on the private network: runtimes up, cold starts, peak RSS per tool, error counts by code, rate-limit tokens.
- Alerts: the routine itself reports `needs_login`/errors via its notification; add a weekly "router alive" check if desired.
