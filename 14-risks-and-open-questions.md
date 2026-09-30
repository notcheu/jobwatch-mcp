# 14 — Risks, open questions, VERIFY list

Update this file as spikes resolve items (keep the history: date, result, decision).

## Open questions for Matthieu (ask before the related work)
1. Machine facts: CPU architecture, total/free RAM when idle, disk, always-on desktop session?
2. Public domain + tunnel provider (D10). Does he already own a domain?
3. Preferred OAuth identity provider for the single-user login (Google account?).
4. LinkedIn usage budget (defaults in `07-…`) — approve or adjust.
5. LinkedIn UI language to standardize on (English vs French).
6. Should the routine's "seen offers" memory move server-side (Phase 4) or stay in the Claude project?
7. CI preference (local `make ci` vs GitHub Actions) and repo hosting (private repo!).

## VERIFY list (assumptions, not facts)
| # | Assumption | Where used | Spike | Status |
|---|---|---|---|---|
| V1 | Custom OAuth connectors are usable from scheduled routines and survive token refresh unattended | `02`, `12` | S1 | open |
| V2 | R0Wi/mcp-gateway or babs/mcp-auth-proxy can restrict login to a single identity and work with Claude's DCR/PKCE flow | `01` D7 | S2 | open |
| V3 | Google Chrome stable is available for the host architecture | `05` | S3 | open |
| V4 | One headful Chrome container fits in ≈1 GB on LinkedIn pages | `06` | S3 | open |
| V5 | Session cookies persist across graceful restarts with `--restore-last-session` | `05` G4 | S4 | open |
| V6 | Chrome on the pinned version honours `--remote-debugging-port` with a custom user-data-dir; DevTools reachable via socat and container IP | `05` G1/G2 | S6 | open |
| V7 | Fingerprint self-check passes with Playwright `connect_over_cdp` | `05` G3 | S4 | open |
| V8 | Navigating to `currentJobId` URLs (or `/jobs/view/<id>`) exposes the same description selector | `07` | S5 | open |
| V9 | Podman flags: `--cgroup-conf memory.high`, `--memory-swap`, `--init`; cgroup v2 delegation for rootless | `06` | S7 | open |
| V10 | Chrome sandbox works under the chosen rootless seccomp/userns setup; else `--no-sandbox` decision | `05` G6, `09` | S7 | open |
| V11 | MCP Python SDK supports stateless Streamable HTTP with a custom ASGI middleware as planned | `01` D9, `03` | Phase 1 start | open |
| V12 | ATS endpoint patterns (Greenhouse/Lever/Ashby/SmartRecruiters/Workable/Teamtailor) | `08` | S9 | open |
| V13 | WTTJ/APEC public endpoints or login needs | `08` | S9 | open |
| V14 | LinkedIn checkpoint/login marker strings | `07` | S4/S5 | open |
| V15 | Tunnel can route all OAuth/MCP paths, and allowlisting `160.79.104.0/21` does not break discovery | `09` | S8 | open |

## Risk register
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LinkedIn checkpoint/ban | medium | high (job-search tool) | conservative budget, breaker, residential IP, manual fallback, never write |
| Scheduled routines can't use custom OAuth connectors | unknown | high | S1 first; plan B static header (beta) or keep Chrome path |
| Selector drift breaks adapters | high over time | medium | fixtures, `adapter_broken` code, nightly smoke, small adapters |
| RAM pressure on the host | medium | medium | strict policy, measurements, zram, single browser |
| Automation fingerprint detected | medium | medium/high | headful Chrome, consistency with real Chrome, Patchright option, low volume |
| Over-engineering for one consumer | medium | wasted time | phase gates; Phase 1 is useful alone; stop after Phase 2 if value is reached |
| Tunnel/WAF breaks OAuth discovery | low/medium | high | follow Anthropic's notes, test with checklist, allowlist carefully |
| Exposed OAuth front vulnerability | low | high | pinned images, updates, single identity, minimal surface |
| Maintenance burden (Chrome upgrades, image rebuilds) | high | low/medium | monthly routine, tests, rollback tag |

## Decisions log (append)
- 2026-09-30: custom router chosen over off-the-shelf gateways (D1). Static schemas (D2). Shared browser image (D4). Headful Chrome preferred (D5, pending S3/S4). Rootless runtime (D8).
