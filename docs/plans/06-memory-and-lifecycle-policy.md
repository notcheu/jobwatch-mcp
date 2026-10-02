# 06 — Memory and lifecycle policy (strict)

> **Related docs:** Load for RAM policy and runtime lifecycle. Also load: `05` (image flags), `03` (runtime manager and leases), `10` (host cgroups, slices), `11` (measurement and soak tests), `14` (open VERIFY items). Follow a link only if the task needs it.

The host has limited RAM. Policy: **nothing runs when idle; one browser at a time; exactly one tab, always; hard caps enforced by cgroups; every limit observable.** All numbers below are starting guesses to be replaced by measurements (Phase 0 spike S3).

## Per-platform runtime state machine
```
COLD ──call──▶ STARTING ──ready──▶ BUSY ──call done──▶ IDLE_GRACE ──ttl expiry──▶ STOPPING ──▶ COLD
                  │ fail               ▲  │ new call (same platform)                ▲
                  ▼                    └──┘ (resets timer)                          │
               FAILED ──(1 retry)──▶ STARTING                     preempt (other platform needs RAM) ─┘
BUSY/IDLE_GRACE ──watchdog >90%──▶ STOPPING(kill) ; max_lifetime reached while IDLE_GRACE ──▶ STOPPING
```
- **STARTING**: `docker run` with limits; wait for DevTools (timeout 30 s); fingerprint self-check; logged-in check is done by the adapter, not here.
- **BUSY**: a lease is held; the single tab is in use.
- **IDLE_GRACE**: no lease; timer `idle_ttl` (default 120 s) runs; the single tab is parked on `about:blank`. Any new call for the same platform cancels the timer.
- **STOPPING**: `Browser.close` via DevTools → wait 10 s → SIGTERM → wait to 20 s → SIGKILL → `docker rm`. Profile volume untouched.
- **Preemption**: if a call for platform B arrives while platform A is IDLE_GRACE, stop A immediately (do not wait for the TTL), then start B. If A is BUSY, B queues (FIFO) up to `queue_timeout` (default 60 s), else `busy`.
- **Max lifetime**: a runtime older than `max_lifetime` (default 30 min) is recycled at the next IDLE_GRACE/lease boundary, never mid-call.

## Benchmark ceiling (decided 2026-10-02)
The measurements in `docs/measurements.md` and the budgets below are the **maximum target for tool usage**: the browser container's `memory.max` / `high`, one browser at a time, the per-platform and per-board rate budgets. No feature raises them. Anything that lets a call use more of the browser than a single tab did (multi-tab, below) works inside the same container cap, and the watchdog still sheds memory at the warn mark by closing every extra tab.

## Multi-tab (decided 2026-10-02, simplified the same day)
One variable: `JW_BROWSER_MAX_TABS` (integer, minimum 1, default 3, no upper limit). 1 is the single-tab policy below; more than 1 is multi-tab. There is no separate on/off flag. `BrowserSession.maxTabs` tells an adapter how many tabs may be open at once, this one included, and `session.openTab()` opens one more.
- An extra tab has the same host allowlist, error mapping and page-load metering as the session (every `goto` is a rate-limit unit, in any tab). It has `close()`, cannot open further tabs and is never the router's primary tab: the primary tab is still navigated to `about:blank` at the end of the call and never closed.
- Only `openTab` creates a tab. A popup or `target=_blank` is still closed at once, and at the end of the call (`park`) and at the memory warn mark (`shedMemory`) every tab except the primary is closed.
- The container memory cap does not change, whatever the limit. More tabs mean more renderer memory: nothing stops a high value, so measure before raising `JW_BROWSER_MAX_TABS` and keep `memory_report` `peak_mb` under the cap. No adapter uses extra tabs yet, so the default of 3 changes nothing today.

## Tab policy (decided 2026-10-01): one primary tab, always
- The browser always has **exactly one tab**. The router never opens a second one (no `newPage`, no `window.open`, no `target=_blank`) and never closes the last one (closing it would close Chrome).
- The single tab is the one Chrome starts with. At lease start the router takes `context.pages()[0]`; the adapter navigates it with `goto`. At lease end it **navigates the tab to `about:blank`** (not `close()`), which releases the page's renderer memory.
- Between steps of one call (for example the search page, then each job page) the adapter just navigates the same tab; it may park on `about:blank` between phases to drop memory (measured: the job page after a search used 640 MB vs 1040 MB for the search page).
- Watchdog (every 5 s while running): if `context.pages().length > 1` (popups, redirects opening new tabs), close every page except the one the router is using and log `stray_tab`. Block `window.open`/popups in Chrome policy as well.
- Adapters must set explicit timeouts on every wait (`networkidle` waits on chatty pages keep renderers alive forever).

## Hard limits (per browser container)
```
docker run --rm --name jw-<platform> --init \
  --memory 1500m --memory-swap 1500m            # hard cap, no swap for this container (measured need on LinkedIn search: about 1.04 GB anon+shmem, see S5)
  --memory-reservation 1200m                    # only a reclaim hint under host pressure; does NOT set memory.high (measured), so the watchdog below is the soft control
  --oom-score-adj 500                           # die before the rest of the machine
  --pids-limit 512 --shm-size 256m --cpus 1.5
  --cap-drop ALL --security-opt no-new-privileges
  --security-opt seccomp=/path/to/chrome-seccomp.json   # Docker default + unshare/setns/clone/chroot so Chrome's sandbox works (see 05 G6)
  --read-only --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /home/chrome:rw,size=64m,uid=1000,gid=1000   # Chrome needs a writable HOME; tmpfs counts toward the memory cap
  -v jw-profile-<platform>:/profile             # named volume; persists across runs, never a host path
  --network jobwatch-browsers ...
  --label jobwatch.managed=true --label jobwatch.platform=<platform>
  jobwatch-browser:<tag>
```
Per-tool budgets in the catalog (`memory.high_mb`, `memory.max_mb`) override the defaults when the runtime is (re)started; a platform's runtime uses the max of the budgets of the tools it serves (single value per platform in v1).
Host level: run the whole stack in a systemd slice with `MemoryMax`; enable zram swap on the host to absorb spikes (keep it OFF inside the browser container). VERIFY cgroup v2 delegation for the rootless user (`systemctl --user`, `Delegate=yes`).

## Measured budget (spikes S3/S5, 2026-10-01; details in `docs/measurements.md`)
- Chrome + Xvfb idle: 200-360 MB. Public sites (Wikipedia, Le Monde, WTTJ, APEC): peak 490-630 MB. Logged-in LinkedIn: `/jobs/` about 775 MB working set; **search page with 25 cards: about 1.04 GB of process memory (anon+shmem)**, job pages (`/jobs/view/<id>/`) 640-960 MB. At a 1100 MB cap the same flow completed but the kernel killed a process once (`oom_kill` = 1) and the working set reached 1091 MB: too close to the cap, and the 90 % watchdog threshold (990 MB) would have aborted the call with `budget_exceeded`.
- Therefore defaults are **`memory.max` 1500 MB, `high` 1200 MB** (about 30 % margin over the measured peak; watchdog warn at 70 % = 1050 MB, critical at 90 % = 1350 MB). The host must have at least cap + 300 MB genuinely free when a runtime starts. On the 3.8 GB home machine that is not guaranteed (1.0-1.7 GB available, swap full): see `10-…` host prerequisites.
- Tuning ideas to verify in Phase 1: navigate the single tab to `about:blank` between the search page and the detail pages (the detail stage after the search used 641 MB anon vs 1036 MB), keep `--renderer-process-limit=2`, `--js-flags=--max-old-space-size=512`. Not effective in S5: site isolation off, blocking images/media/fonts.

## Watchdog thresholds
Polling source: `docker stats --no-stream --format json <name>` (or the cgroup `memory.current` file when accessible). **Use the working set (`memory.current` minus `inactive_file`, which is what `docker stats` reports), not `memory.peak` or raw `memory.current`:** both include reclaimable page cache and would trigger false alarms (measured in S4: `memory.peak` reached the 1100 MB cap on a page that still loaded fine). Interval 5 s while a runtime is running.
| Level | Condition | Action |
|---|---|---|
| warn | ≥ 70% of `memory.max` | close every non-working tab; `HeapProfiler.collectGarbage`; log `mem_warn` |
| critical | ≥ 90% | abort the current call with `budget_exceeded`; stop the runtime (graceful → kill); profile kept |
| oom | container exit code 137 / `OOMKilled=true` | mark call `oom_killed`; one automatic retry only if the tool is idempotent and no retry happened in the last 10 min; otherwise return the error |
Record `peak_rss_mb` per call (max observed `memory.current` during the lease) in the call log.

## Flags that reduce memory (see `05-…` for the full list)
`--disable-gpu`, `--disable-dev-shm-usage` (with explicit `--shm-size`), `--js-flags=--max-old-space-size=512`, `--renderer-process-limit=2`, `--disable-background-networking`, `--disable-extensions`, `--mute-audio`. Resource blocking (media/fonts) is optional and must be A/B-tested: it saves memory but changes the page-load profile relative to a normal user.

## Pacing interacts with lifecycle
The idle TTL (120 s) must be longer than the typical gap between a routine's consecutive calls (seconds) and shorter than a long reasoning pause. Cold start costs a few seconds plus a page load; that is acceptable. Do not raise the TTL to "save" cold starts: RAM is the scarce resource. If a routine regularly exceeds the gap, add a client-side hint instead (a `keep_warm_s` argument capped at 300 s) — decide later.

## Measurement plan (Phase 0, S3) — record results in `docs/measurements.md`
On the real machine, with the pinned Chrome image:
1. Idle RAM and free RAM of the host before anything runs (`free -m`).
2. RSS (container `memory.current`) for: Chrome+Xvfb idle; LinkedIn search page; job details page; after 10 job pages; after parking the tab on `about:blank`; after 20 minutes idle.
3. Cold-start time: `docker run` → DevTools ready → logged-in check.
4. With/without resource blocking; with `--renderer-process-limit` 1 vs 2.
5. Derive: `memory.high`/`max`, `idle_ttl`, `max_lifetime`, warn/critical thresholds. Update this file.

## Invariants (tests must enforce)
- At most one browser container with label `jobwatch.managed=true` exists at any time (assert in integration tests).
- After the TTL expires no managed container remains (`docker ps` empty) — soak test.
- `tools/list` and ops calls never start a runtime.
- A runtime never exceeds its `memory.max` (cgroup) and is killed before the host swaps heavily.
