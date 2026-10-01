# Measurements (Phase 0)

> The `spikes/` directory (Phase 0 scripts and prototypes) was removed from the tree after Phase 1. Every `spikes/...` path below can be recovered from git history: `git show dddea88:spikes/<path>`.

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

### S4 languages and a memory cap hit (2026-10-01)
- **Languages (G8) fixed:** with `ACCEPT_LANGS` seeded into both `intl.accept_languages` and `intl.selected_languages`, `navigator.languages` equals the everyday Chrome's list exactly. All other signals unchanged (webdriver false, not headless, no Playwright globals).
- **Three more `/feed/` cycles, all `STATE: ok`:** `memory.peak` 914 / 1001 / **1100 MB**, i.e. the third run reached the 1100 MB cap (`domcontentloaded` 11.7 / 7.8 / 11.3 s). The container was not OOM-killed (Chrome closed with exit 0) and the page still loaded, because `memory.peak` includes reclaimable page cache, which the kernel drops when the cap is reached. It still means the cap has no headroom on this page.
- **Metric to use:** the watchdog and budgets in `06-…` must use the **working set** (`memory.current - inactive_file`, what `docker stats` reports), not `memory.peak`. `s4-linkedin.sh` now samples both so the next run separates real use from cache.
- **Conclusion so far:** on a logged-in `/feed/` Chrome uses about 0.7-1.1 GB. Do not raise or lower the 1100 MB cap yet: S5 (search-results and job-detail pages, the pages the adapter actually loads) and the working-set numbers decide.

## S5 first run: LinkedIn search page does not fit in 1100 MB (2026-10-01)
`pages` with the default cap (1100 MB, `--renderer-process-limit=2`, `--js-flags=--max-old-space-size=512`, GPU disabled):
- `/jobs/` loaded fine (`STATE: ok`, 9.4 s) but already needed a **working set of 788 MB** (peak 968 MB).
- The **search-results page crashed the tab** (`page.evaluate: Target crashed`) with a working set of **1099 MB**, i.e. the cap. Chrome itself survived (the container exited cleanly on `Browser.close`), so the kernel killed a renderer. The run stopped by itself (0 cards read), so the detail pages are still unmeasured.
- Conclusion: **V4 fails for logged-in LinkedIn at 1100 MB.** The page's real need is unknown. Next experiments (one load each, `STAGES=search`): (A) the same page with `MEM_MAX=1800m` to measure the unconstrained need, with `--oom-score-adj 500` so Chrome dies before the host's other services; (B) at 1100 MB with site isolation disabled (`CHROME_EXTRA='--disable-features=IsolateOrigins,site-per-process --disable-site-isolation-trials'`), which removes many per-iframe renderer processes. Decision options after that: a bigger cap, resource blocking (A/B tested for fingerprint impact, see `06-…`), fewer processes, more host RAM, or running the browser runtime on a bigger machine.

### S5 memory experiments on the search-results page (2026-10-01)
| Run | Cap | Flags | Result |
|---|---|---|---|
| 1 | 1800 MB | default | no crash, **working set 1319 MB, peak 1395 MB**, 0 kernel OOM kills, `domcontentloaded` 7.6 s. **0 cards and no `SearchResultsMainContent` container found** (V8: either results had not rendered or the selectors are stale) |
| 2 | 1100 MB | site isolation off (`--disable-features=IsolateOrigins,site-per-process --disable-site-isolation-trials`) | **tab crashed again** (`Page crashed`, `oom_kill` = 1, working set 1035 MB, peak 1100 MB) |
Conclusions: a logged-in LinkedIn search page needs about **1.3-1.4 GB** in this setup; site-isolation off does not close the gap. The host has 3.8 GB with 1.0-1.7 GB available and a full swap, so a 1.5 GB browser is not safe next to mongod/MariaDB/Grafana/Jellyfin without more RAM or less other load. Next run: `MEM_MAX=1800m BLOCK=image,media,font STAGES=search` (blocking resource types, the third lever in `06-…`) with the new selector diagnostics (`DIAG markers`), to see whether blocking brings the need back near 1 GB and what markup the page really has.

| 3 | 1800 MB | `BLOCK=image,media,font` (resource types aborted) | no crash, **working set 1338 MB at the search stage (1611 MB overall max), peak 1683 MB**: blocking does **not** reduce the need. Still **0 cards**, no container. The selector diagnostic crashed on a null attribute (fixed) so the page markup is still unknown |
Running tally: 6 automated LinkedIn page loads today beyond the sessions checks. Stop automated runs on the search page until the page is looked at by a human (noVNC) to see what it actually renders; a blank/skeleton/error page would also explain 0 cards and the odd memory.

### S5 root cause found by reading the page (2026-10-01, Matthieu's Chrome, 4 loads of search pages)
The three container runs had loaded **a "No results found" page** (`/jobs/search-results/` no longer returns results, see `07-…`), so the 1.3-1.6 GB memory figures describe a mostly empty page and **must not be used for budgeting**. In the same Chrome, the classic `/jobs/search/` URL returned real results with the legacy markup (7 cards, 7 `/jobs/view/` links). JS heap in that tab was 146 MB. Next measurement: the probe targets the classic `/jobs/search/` URL (LinkedIn reverted from the AI `/jobs/search-results/` UI; `SEARCH_URL` overrides it), supports both markups, scrolls the list 3 times, and tries more description selectors; run `pages` once. Until then V4 is **open, not failed**.

## S5 run on the classic layout (2026-10-01, cap 1800 MB, five loads, all `STATE: ok`, no checkpoint)
| Stage | Page | gotoMs | Working set | memory.peak |
|---|---|---|---|---|
| `jobs_home` | `/jobs/` | 8.2 s | 774 MB | 860 MB |
| `search` | `/jobs/search/` (routine OR query, 25 cards) | 25.6 s | **1749 MB** | 1800 MB |
| `view_1` | `/jobs/view/<id>/` | 12.0 s | 1699 MB | 1800 MB |
| `view_2` | `/jobs/view/<id>/` | 27.6 s | 1513 MB | 1800 MB |
| `split_view_1` | search with `currentJobId` | 19.8 s | 1673 MB | 1800 MB |
No kernel OOM kill, memory.peak sat at the 1800 MB cap throughout. This does **not** show the minimum need: with a high cap Chrome keeps caches and the working set (current - inactive_file) still includes active file pages. The earlier runs at 1100 MB crashed on a "No results found" page, a different page, so they say nothing about this one. Decisive next run: the same flow at `MEM_MAX=1100m` (stages `search,view_1,view_2`) with the new `anon+shmem` metric (process memory without file cache). `/jobs/` alone needed 774 MB.
Selector results are recorded in `07` (layout A) and V8 in `14`.

## S5 decisive run: classic layout at the original 1100 MB cap (2026-10-01, `STAGES=search,view_1,view_2`)
All three stages completed and read their data (25 cards; descriptions 1826 and 5604 characters via `/jobs/view/<id>/`), `STATE: ok`. But:
| Stage | gotoMs | Working set | anon+shmem | memory.peak |
|---|---|---|---|---|
| `search` | 16.8 s | 1091 MB | **1036 MB** | 1100 MB |
| `view_1` | 7.7 s | 752 MB | 641 MB | 1100 MB |
| `view_2` | 7.6 s | 1043 MB | 956 MB | 1100 MB |
`kernel oom_kill events = 1`: the kernel killed one process (the page data was still obtained, so it was probably a helper or a spare renderer), and the search stage used 94 % of the cap as process memory. A 1100 MB cap is therefore not safe, and the router's 90 % watchdog (990 MB) would have aborted this very call. **Verdict: the realistic need is about 1.04 GB of process memory on the search page; budget `memory.max` 1500 MB (`high` 1200 MB).** Navigation was fast this time (7-17 s), so the 8-28 s of the previous run came from host memory pressure, not from LinkedIn. The host still has to provide about 2 GB free when a runtime starts.

## Decisions after S5 (Matthieu, 2026-10-01)
- No hardware upgrade for now; zram will be looked into. The 1500 MB browser budget stays; RAM remains the main operational risk (`10-…`).
- **Exactly one tab, always** (recorded in `CLAUDE.md`, `05`, `06`, `03`): the router reuses the browser's single tab and parks it on `about:blank`, instead of opening a working tab next to a blank one. The spike probes (S4-S6) still call `newPage()`; they are throwaway.

## Multi-architecture check: browser image on Apple Silicon (2026-10-01, Matthieu's Mac, Docker Desktop, arm64)
Built `spikes/chrome` natively for arm64 (Debian Chromium, 378 MB image) and ran it with the same hardening as the NUC: `--cap-drop ALL`, `no-new-privileges`, the custom seccomp profile, read-only root, tmpfs home, 1500 MB cap. **Result: Chromium 154.0.8037.57 starts with its sandbox ON, DevTools answers on 9222 (`uname -m` = aarch64).** `/json/version` still reports a "Chrome/154" UA string (Chrome freezes the UA platform to `X11; Linux x86_64`), so the differences from the NUC's Google Chrome are in other signals (for example `navigator.userAgentData` brands), not visible in the UA: the arm64 image is for development only. Not measured on the Mac: memory, LinkedIn pages, fingerprint. The OAuth front, Redis, Nginx files and the full compose stack have not been run (they need the Google credentials and the public hostname); `docker compose config` resolves both the production file and the dev override.
