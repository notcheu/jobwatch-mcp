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
