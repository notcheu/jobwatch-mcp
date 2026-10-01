# 14 — Risks, open questions, VERIFY list

> **Related docs:** Load to resolve a `VERIFY`, record a spike result, or ask open questions. Also load: the spec file named in the relevant row (`02`, `05`, `06`, `07`, `09`, `10`) and `12` for the spike. Follow a link only if the task needs it.

Update this file as spikes resolve items (keep the history: date, result, decision).

## Open questions for Matthieu (ask before the related work)
1. Machine facts: CPU architecture, total/free RAM when idle, disk, always-on desktop session?
2. Public hostname for the connector (subdomain on the existing domain behind Nginx, e.g. `mcp.<domain>`). D10 is decided: Nginx + one published port.
3. Preferred OAuth identity provider for the single-user login (Google account?).
4. LinkedIn usage budget (defaults in `07-…`) — approve or adjust.
5. LinkedIn UI language to standardize on (English vs French).
6. Should the routine's "seen offers" memory move server-side (Phase 4) or stay in the Claude project?
7. CI preference (local `npm run ci` vs GitHub Actions) and repo hosting (private repo!).

## VERIFY list (assumptions, not facts)
| # | Assumption | Where used | Spike | Status |
|---|---|---|---|---|
| V1 | Custom OAuth connectors are usable from scheduled routines and survive token refresh unattended | `02`, `12` | S1 | open |
| V2 | R0Wi/mcp-gateway or babs/mcp-auth-proxy can restrict login to a single identity and work with Claude's DCR/PKCE flow | `01` D7 | S2 | open |
| V3 | Google Chrome stable is available for the host architecture | `05` | S3 | **confirmed** (host is x86_64, `docs/measurements.md`) |
| V4 | One headful Chrome container fits in ≈1 GB on LinkedIn pages | `06` | S3 | **FAILS at 1100 MB** for logged-in LinkedIn: public pages need 487-625 MB, `/jobs/` 788 MB working set, the search-results page crashed a renderer at the cap (S5, `docs/measurements.md`). Real need and mitigations under test (bigger cap, site isolation off, resource blocking, more RAM). Host itself is near its RAM/swap limit |
| V5 | Session cookies persist across graceful restarts with `--restore-last-session` | `05` G4 | S4 | **confirmed**: three consecutive stop/start cycles, `STATE: ok` each time; `li_at` is a persistent cookie (no dependency on session restore) |
| V6 | Chrome on the pinned version honours `--remote-debugging-port` with a custom user-data-dir; DevTools reachable via socat and container IP | `05` G1/G2 | S6 | **confirmed** (Chrome 154, `socat` forward, container IP, internal network; `docs/measurements.md`) |
| V7 | Fingerprint self-check passes with Playwright `connect_over_cdp` | `05` G3 | S4 | **confirmed on LinkedIn `/feed/`** (webdriver false, not headless, no Playwright globals). Open: `navigator.languages` is `en-US,en`, compare with the real browser (G8) |
| V8 | Navigating to `currentJobId` URLs (or `/jobs/view/<id>`) exposes the same description selector | `07` | S5 | open |
| V9 | Rootless Docker flags: `--memory`, `--memory-swap`, `--memory-reservation`, `--init`; cgroup v2 delegation (memory controller) for rootless | `06` | S7 | **confirmed**: `--memory`, `--memory-swap` enforced; `--memory-reservation` does not set `memory.high` (no soft throttle), `--init` works |
| V10 | Chrome sandbox works under the chosen rootless seccomp/userns setup; else `--no-sandbox` decision | `05` G6, `09` | S7 | **confirmed**: works with the custom seccomp profile (default + `unshare`, `setns`, `clone`, `chroot`), `--cap-drop ALL`, `no-new-privileges`, read-only root; re-verify on each Chrome major |
| V11 | MCP TypeScript SDK supports stateless Streamable HTTP (`sessionIdGenerator: undefined`) with custom Express middleware as planned | `01` D9, `03` | Phase 1 start | **confirmed** (Node 26.10.0, SDK 1.31.0, Express 5: two fresh clients, raw `tools/list` without a session header, no `mcp-session-id`; `spikes/echo-mcp`) |
| V12 | ATS endpoint patterns (Greenhouse/Lever/Ashby/SmartRecruiters/Workable/Teamtailor) | `08` | S9 | **confirmed** for Greenhouse, Lever, Ashby (15 of 24 watch-list companies have a public board, see `08`); SmartRecruiters/Recruitee matched nothing, Teamtailor not probed |
| V13 | WTTJ/APEC public endpoints or login needs | `08` | S9 | **confirmed**: APEC search API is public over plain HTTP (no login); full description needs a browser (`/cms/webservices/offre/public` is 403 to plain HTTP, 200 in-page without cookies); WTTJ returns 403 to plain HTTP and its `robots.txt` disallows `*/jobs?query=*` (decided: only `wttj_matches`, company jobs via ATS, see `08`) |
| V14 | LinkedIn checkpoint/login marker strings | `07` | S4/S5 | **partly**: logged-in `/feed/` = path `/feed/`, no `input[name=session_key]`, `nav` present, `/jobs/` and `/mynetwork/` links; login/checkpoint path patterns are assumptions (`/login`, `/authwall`, `/checkpoint`) until seen |
| V15 | Nginx can proxy all OAuth/MCP paths (streaming, no buffering) and allowlisting `160.79.104.0/21` does not break discovery | `09` | S8 | open |

## Risk register
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LinkedIn checkpoint/ban | medium | high (job-search tool) | conservative budget, breaker, residential IP, manual fallback, never write |
| Scheduled routines can't use custom OAuth connectors | unknown | high | S1 first; plan B static header (beta) or keep Chrome path |
| Selector drift breaks adapters | high over time | medium | fixtures, `adapter_broken` code, nightly smoke, small adapters |
| RAM pressure on the host | medium | medium | strict policy, measurements, zram, single browser |
| Automation fingerprint detected | medium | medium/high | headful Chrome, consistency with real Chrome, Patchright option, low volume |
| Over-engineering for one consumer | medium | wasted time | phase gates; Phase 1 is useful alone; stop after Phase 2 if value is reached |
| Nginx/WAF rules break OAuth discovery or MCP streaming | low/medium | high | follow Anthropic's notes, test with checklist, allowlist carefully |
| Exposed OAuth front vulnerability | low | high | pinned images, updates, single identity, minimal surface |
| Maintenance burden (Chrome upgrades, image rebuilds) | high | low/medium | monthly routine, tests, rollback tag |

## Decisions log (append)
- 2026-09-30: custom router chosen over off-the-shelf gateways (D1). Static schemas (D2). Shared browser image (D4). Headful Chrome preferred (D5, pending S3/S4). Rootless runtime (D8).
