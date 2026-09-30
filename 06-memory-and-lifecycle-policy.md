# 06 — Memory and lifecycle policy (strict)

> **Related docs:** Load for RAM policy and runtime lifecycle. Also load: `05` (image flags), `03` (runtime manager and leases), `10` (host cgroups, slices), `11` (measurement and soak tests), `14` (open VERIFY items). Follow a link only if the task needs it.

The host has limited RAM. Policy: **nothing runs when idle; one browser at a time; one tab at a time; hard caps enforced by cgroups; every limit observable.** All numbers below are starting guesses to be replaced by measurements (Phase 0 spike S3).

## Per-platform runtime state machine
```
COLD ──call──▶ STARTING ──ready──▶ BUSY ──call done──▶ IDLE_GRACE ──ttl expiry──▶ STOPPING ──▶ COLD
                  │ fail               ▲  │ new call (same platform)                ▲
                  ▼                    └──┘ (resets timer)                          │
               FAILED ──(1 retry)──▶ STARTING                     preempt (other platform needs RAM) ─┘
BUSY/IDLE_GRACE ──watchdog >90%──▶ STOPPING(kill) ; max_lifetime reached while IDLE_GRACE ──▶ STOPPING
```
- **STARTING**: `docker run` with limits; wait for DevTools (timeout 30 s); fingerprint self-check; logged-in check is done by the adapter, not here.
- **BUSY**: a lease is held; exactly one working tab open.
- **IDLE_GRACE**: no lease; timer `idle_ttl` (default 120 s) runs; the blank tab remains. Any new call for the same platform cancels the timer.
- **STOPPING**: `Browser.close` via DevTools → wait 10 s → SIGTERM → wait to 20 s → SIGKILL → `docker rm`. Profile volume untouched.
- **Preemption**: if a call for platform B arrives while platform A is IDLE_GRACE, stop A immediately (do not wait for the TTL), then start B. If A is BUSY, B queues (FIFO) up to `queue_timeout` (default 60 s), else `busy`.
- **Max lifetime**: a runtime older than `max_lifetime` (default 30 min) is recycled at the next IDLE_GRACE/lease boundary, never mid-call.

## Tab policy
- One working tab per lease; closed in `finally` via `Target.closeTarget`/`page.close()`.
- A blank tab stays so the Chrome window never closes.
- Watchdog (every 5 s while running): close any page that is neither the blank tab nor the working tab (popups, redirects opening new tabs); log it.
- Adapters must set explicit timeouts on every wait (`networkidle` waits on chatty pages keep renderers alive forever).

## Hard limits (per browser container)
```
docker run --rm --name jw-<platform> --init \
  --memory 1100m --memory-swap 1100m            # hard cap, no swap for this container
  --memory-reservation 900m                     # soft limit; under host pressure the kernel reclaims down to it (VERIFY; no memory.high equivalent in docker run)
  --oom-score-adj 500                           # die before the rest of the machine
  --pids-limit 512 --shm-size 256m --cpus 1.5
  --cap-drop ALL --security-opt no-new-privileges
  --read-only --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /home/chrome:rw,size=64m,uid=1000,gid=1000   # Chrome needs a writable HOME; tmpfs counts toward the memory cap
  -v <profiles>/<platform>:/profile:rw
  --network jobwatch-browsers ...
  --label jobwatch.managed=true --label jobwatch.platform=<platform>
  jobwatch-browser:<tag>
```
Per-tool budgets in the catalog (`memory.high_mb`, `memory.max_mb`) override the defaults when the runtime is (re)started; a platform's runtime uses the max of the budgets of the tools it serves (single value per platform in v1).
Host level: run the whole stack in a systemd slice with `MemoryMax`; enable zram swap on the host to absorb spikes (keep it OFF inside the browser container). VERIFY cgroup v2 delegation for the rootless user (`systemctl --user`, `Delegate=yes`).

## Watchdog thresholds
Polling source: `docker stats --no-stream --format json <name>` (or the cgroup `memory.current` file when accessible). Interval 5 s while a runtime is running.
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
2. RSS (container `memory.current`) for: Chrome+Xvfb idle; LinkedIn search page; job details page; after 10 job pages; after closing the working tab; after 20 minutes idle.
3. Cold-start time: `docker run` → DevTools ready → logged-in check.
4. With/without resource blocking; with `--renderer-process-limit` 1 vs 2.
5. Derive: `memory.high`/`max`, `idle_ttl`, `max_lifetime`, warn/critical thresholds. Update this file.

## Invariants (tests must enforce)
- At most one browser container with label `jobwatch.managed=true` exists at any time (assert in integration tests).
- After the TTL expires no managed container remains (`docker ps` empty) — soak test.
- `tools/list` and ops calls never start a runtime.
- A runtime never exceeds its `memory.max` (cgroup) and is killed before the host swaps heavily.
