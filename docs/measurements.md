# Measurements (Phase 0)

## Host facts (Nuc-desktop), recorded 2026-10-01
| Item | Value | Note |
|---|---|---|
| CPU arch | x86_64 (4 CPUs) | Google Chrome stable is available (V3); CI `linux/amd64` is correct |
| OS / kernel | Ubuntu 24.04.3 LTS, kernel 7.0.0-30-generic | |
| RAM | 3806 MB total, 1332 MB available, 1060 MB free | measured while 11 containers were running |
| Swap | 3810 MB total, 2968 MB used (78 %) | already under memory pressure before any browser runs |
| Docker | Engine 29.1.5 **rootful**, Compose v5.0.1, Buildx v0.30.1 | cgroup v2, systemd cgroup driver, seccomp + apparmor |
| Storage | overlay2 on **ZFS** backing filesystem | relevant to rootless Docker (see below) |
| Existing workload | 16 containers (11 running), 36 images | shares the machine with the orchestrator |

## Consequences for the plan
- **RAM is the binding constraint.** The default `memory.max` of 1100 MB for Chrome plus always-on services (front, router, Watchtower, a second rootless daemon) does not fit in 1332 MB available without pushing the host deeper into swap. V4 (one headful Chrome in about 1 GB) is at risk; S3 must measure real Chrome on LinkedIn pages and the budgets in `06-…` may need to drop (for example `max` 800 MB) or other containers may need to be stopped during runs.
- **Rootless Docker is a second daemon**, separate from the existing rootful one (its own images and containers, plus its own memory overhead). Existing containers and the existing Watchtower are not affected and cannot see ours.
- **Rootless overlay2 on ZFS is unverified (but likely fine).** Rootless Docker stores data under the `jobwatch` user's home; if that filesystem is ZFS, native overlay may not work and Docker falls back to `fuse-overlayfs` or `vfs` (slower, more disk). Put the `jobwatch` home on ext4/xfs if possible. VERIFY in S7.
- Everything else from the Phase 0 spike list is still open; see `14-risks-and-open-questions.md`.

## `host-check.sh` results (run as `noguetith`, 2026-10-01)
| Check | Result | Meaning |
|---|---|---|
| subuid / subgid | `noguetith:100000:65536` present | a new `jobwatch` user gets its own range from `adduser` |
| `uidmap` | **not installed** | `sudo apt install uidmap dbus-user-session` is required |
| cgroup v2 delegation to user services | `cpu memory pids` | memory limits (`--memory`, `--memory-reservation`) and `--cpus`, `--pids-limit` work rootless; `cpuset`/`io` are not delegated (not needed) |
| Linger | yes (for `noguetith`) | must also be enabled for `jobwatch` |
| User namespaces | `max_user_namespaces=10919`, `kernel.apparmor_restrict_unprivileged_userns=1` | Ubuntu 24.04 blocks unprivileged userns unless an AppArmor profile allows the binary: **rootlesskit needs a profile** (see `10-…`). The same restriction may affect Chrome's sandbox (V10) |
| Filesystem | `/home` and `/var/lib` both on ZFS | rootful overlay2 on ZFS already works here (`Native Overlay Diff: true`); rootless uses `userxattr`, verify with `docker info` after install |
| Swap | one 3.7 GB disk partition, 2.9 GB used, **no zram** | zram (compressed RAM swap, higher priority) would absorb Chrome spikes better than disk swap |
| Top RSS | mongod 287 MB, node 186 MB, mariadbd 134 MB, node 109 MB, grafana 83 MB, gnome-shell 72 MB, jellyfin 69 MB | the host is a shared box with a desktop session; Grafana already runs here |
| `docker-ce-rootless-extras` | already installed (29.1.5; 29.8.1 available) | no new apt repo needed |
| `google-chrome-stable` on the host | not found | irrelevant: Chrome is installed **inside the browser image** from Google's repo, not on the host |

## Decisions and next actions
- Keep a dedicated `jobwatch` user (not `noguetith`), so the rootless daemon and its `DOCKER_HOST` never interfere with your existing rootful Docker.
- Before S3, consider enabling zram and, if acceptable, stopping the desktop session during runs (`gnome-shell` and friends) to free memory. Decide after the first Chrome measurement.
- Budgets in `06-…` stay at the current guesses until S3 measures real Chrome; expect to lower `memory.max`.

## `host-check.sh` results as `mcpuser` (2026-10-01)
The dedicated stack user is **`mcpuser`** (uid 1002; not in the `docker` group).
| Check | Result |
|---|---|
| subuid / subgid | `mcpuser:165536:65536` |
| `uidmap` | installed (`newuidmap`, `newgidmap`) |
| cgroup delegation | `cpu memory pids` |
| Linger | yes |
| `kernel.apparmor_restrict_unprivileged_userns` | 1 (rootlesskit AppArmor profile still required, see `10-…`) |
| Home filesystem | ZFS (`/home`), same pool as before |
| Memory | 1017 MB available, swap 3028 of 3810 MB used: worse than the first run, so host pressure varies; S3 must be measured several times |

## Rootless Docker installed (`mcpuser`, 2026-10-01)
| Check | Result |
|---|---|
| Daemon | Docker 29.1.5, **rootless** in Security Options, 0 containers/images (separate from the rootful daemon) |
| Cgroup | v2, systemd driver |
| Storage | `overlayfs` with the containerd snapshotter (Docker 29 default), root dir `/home/mcpuser/.local/share/docker`: works on the ZFS home |
| Warnings | no `cpuset`, no `io.*`: expected (only `cpu memory pids` are delegated). We use `--cpus`, `--memory`, `--pids-limit`, none of which need them |
| Still to test | that `--memory`/`--memory-swap`/`--memory-reservation` are actually enforced, Chrome's sandbox, peak RSS (spike script `spikes/host/s3-chrome-memory.sh`) |

## S3/S7 Chrome memory test, 2026-10-01 (`spikes/host/s3-chrome-memory.sh`)
Headful Chrome + Xvfb, container capped at `--memory 1100m --memory-swap 1100m --memory-reservation 900m`, logged-out public pages, 10 s settle per page.

| Run | Sandbox / seccomp | Host available before | Cold start | Idle | Wikipedia | Le Monde | WTTJ | APEC | Peak |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `--no-sandbox`, default | 469 MB | 2.7 s | 361 MB | 404 | 442 | 601 | 451 | **625 MB** |
| 2 | `--no-sandbox`, default | 1191 MB | 1.7 s | 226 MB | 288 | 332 | 492 | 334 | 516 MB |
| 3 | `--no-sandbox`, default | 1501 MB | 1.1 s | 198 MB | 262 | 310 | 463 | 304 | 487 MB |
| 4 | **sandbox ON**, `seccomp=unconfined` | 1691 MB | 1.1 s | 211 MB | 273 | 315 | 472 | 314 | 498 MB |
(page columns are current MB after loading; `OOMKilled=false` in all runs.)

Findings:
- **Enforcement works:** `memory.max=1153433600` (1100 MiB) and `memory.swap.max=0` are applied in the rootless container. `--memory-reservation` does **not** set `memory.high` (it stays `max`), so there is no kernel-side soft throttle: the watchdog thresholds (70 % warn, 90 % critical) in `06-…` are the only soft control.
- **Memory (V4):** peak 487-625 MB on the heaviest public pages (WTTJ adds about 150 MB), so one headful Chrome fits well inside 1100 MB with a 40 % margin. Run 1 was higher because the host was already starved (469 MB available). **Logged-in LinkedIn pages are not measured yet (S5); treat these as a lower bound.** No change to the 1100 MB default until then.
- **Cold start:** 1.1-2.7 s to DevTools ready.
- **After closing tabs** memory falls by 100-200 MB but not back to idle, which is fine for the 120 s grace period.
- **Sandbox (V10):** with default seccomp the sandbox fails ("Failed to move to new namespace: Operation not permitted"). With `seccomp=unconfined` and everything else unchanged (`--cap-drop ALL`, `no-new-privileges`, read-only root) it works. So **seccomp is the only blocker**. AppArmor's userns restriction did not interfere. A minimal profile is in `spikes/chrome/chrome-seccomp.json` (Docker's default plus `unshare`, `setns`, `clone`); to be verified.
- **Host health:** swap was 3.4-3.7 GB of 3.8 GB in every run, with available RAM swinging between 469 and 1691 MB. The container itself is fine, but the host is close to its limit. Enabling zram or trimming other services is recommended before running this unattended.

### Run 5: sandbox ON with the custom seccomp profile (2026-10-01)
Host available 1562 MB. Cold start 1.3 s, idle 229 MB, Wikipedia 286, Le Monde 333, WTTJ 490, APEC 322 MB, **peak 518 MB**, `OOMKilled=false`. Chrome started with its sandbox after adding `unshare`, `setns`, `clone` (first attempt: namespace creation denied) and `chroot` (second attempt: `sys_chroot` denied) to Docker's default seccomp profile. V10 is confirmed; decision recorded in `05` G6. The profile still needs to be moved to `images/browser/` and pinned in Phase 1.

## S6: router-like container driving Chrome over an internal network (2026-10-01, `spikes/host/s6-devtools.sh`)
Chrome 154.0.8037.92 container on an `--internal` Docker network (no published ports), probe container with `playwright-core` 1.63.0 on Node 26.
- DevTools by container IP: 200. By container name: 500 "Host header is specified and is not an IP address or localhost" (also fails through `connectOverCDP`); with `Host: localhost`: 200. Chrome's own port 9223 is refused from other containers, so `socat` on 9222 is required (G2, V6 confirmed).
- WebSocket handshake succeeds with any `Origin` (`--remote-allow-origins=*`): the internal network is the only protection; never publish 9222.
- `chromium.connectOverCDP(http://<IP>:9222)`: one context and one page; `newPage()` then `page.close()` restores the original single tab.
- Fingerprint signals on a blank page: `navigator.webdriver=false`, UA without `HeadlessChrome`, `window.chrome` present, 5 plugins, screen 1366x800, TZ `Europe/Paris`, no `playwright`/`__pw` globals. `navigator.languages` is `["en-US","en"]`: set the container locale/`--lang` to match the real browser (G8).
- `Browser.close` over CDP: Chrome exits, container stops with exit code 0 (G5 confirmed).
- Finding for the router: Playwright needs a writable temp dir, so the router container needs a `/tmp` tmpfs (already in `deploy/compose.yml`).

## S4: LinkedIn login and first session check (2026-10-01, `spikes/host/s4-linkedin.sh`)
Logged in once through noVNC (login mode), Chrome stopped gracefully, then one `check` cycle (fresh start, one load of `/feed/`):
- **Session restored after a restart:** `STATE: ok`, final path `/feed/`, no login form. `li_at` is a **persistent** cookie (`expires` set, not a session cookie), so it survives restarts independently of session restore; `JSESSIONID` is a session cookie. The three-restart test (`persist`) is still to run.
- **Markers on `/feed/` (V14 input):** no login form, `nav` present, links to `/jobs/` and `/mynetwork/` present, `<html lang="en">`, title `Feed | LinkedIn`.
- **Fingerprint on the real site (V7):** `navigator.webdriver=false`, not headless, 5 plugins, `window.chrome` present, no Playwright globals. `navigator.languages` is `["en-US","en"]` even with `--lang=fr-FR`: that flag sets the UI locale, not `navigator.languages`. To align (G8), compare with the real browser (`navigator.languages` in the everyday Chrome) and set `LANGUAGE`/`intl.accept_languages` in the profile if they differ. The LinkedIn account UI is English (`lang="en"`).
- **Load time:** `domcontentloaded` in 10.3 s (host under swap pressure).
- **Memory: peak 985 MB of the 1100 MB cap (90 %) on the feed page.** This is far above the 487-625 MB on public pages and leaves no margin. `/feed/` is among the heaviest LinkedIn pages (video, infinite scroll) and is not what the adapter will load; S5 must measure the actual search-results and job-detail pages, and pick a lighter page for `session_status`. Until then V4 is at risk for logged-in LinkedIn.

### S4 persistence test (3 restarts, 2026-10-01)
Three cycles, 20 s apart, each a fresh container on the same profile volume: `STATE: ok` and path `/feed/` every time (V5 confirmed). `domcontentloaded` took 7.0 / 11.0 / 7.0 s. Peak memory on `/feed/`: 847 / 967 / 685 MB (cap 1100 MB), so the logged-in feed varies by about 280 MB between runs; budget for the high end. `navigator.languages` stayed `["en-US","en"]`: seeding only `intl.accept_languages` was not enough; the entrypoint now sets `intl.selected_languages` as well and logs what it applied.
