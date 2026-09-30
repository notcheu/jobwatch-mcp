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
- **Rootless overlay2 on ZFS is unverified.** Rootless Docker stores data under the `jobwatch` user's home; if that filesystem is ZFS, native overlay may not work and Docker falls back to `fuse-overlayfs` or `vfs` (slower, more disk). Put the `jobwatch` home on ext4/xfs if possible. VERIFY in S7.
- Everything else from the Phase 0 spike list is still open; see `14-risks-and-open-questions.md`.
