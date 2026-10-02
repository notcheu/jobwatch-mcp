# 11 — Testing and validation

> **Related docs:** Load for tests and acceptance. Also load: `12` (phase exit criteria), `06` (RAM expectations), `05` (fingerprint checks), `09` (security checklist), `14` (VERIFY items), `03` (contract tests, testkit). Follow a link only if the task needs it.

## Test pyramid
1. **Unit (fast, no containers)**: catalog validation, argument validation, rate limiter, circuit breaker, state machine (with a fake `RuntimeBackend`), output shaping/size caps, parsers (fixtures), hints dictionaries (including the `Vue` case-sensitivity trap).
2. **Contract**: for each tool, adapter output validates against `outputSchema`; `tools/list` snapshot equals catalog; `tools/list` never calls the backend; every tool has `readOnlyHint` and `additionalProperties:false`; descriptions ≤ N chars.
3. **Integration (local, real containers, no internet)**: serve saved sanitized HTML from a local static server (fake `www.linkedin.com` via a hosts override or a test-mode base URL) and run adapters end-to-end through a real browser container: spawn → extract → close → reap. Asserts lifecycle invariants (see `06-…`).
4. **Live smoke (manual, off by default)**: real LinkedIn/APEC/WTTJ with the real profile, within budget; record cold start and peak RSS.
5. **Protocol/auth**: MCP Inspector or a scripted client against the router alone (no auth), then against the full stack: 401 discovery, OAuth flow, token refresh, scopes, second-account rejection.
6. **End-to-end**: add the connector in Claude, run a real tool call; then a **scheduled routine** run calling the tools unattended.

## Lifecycle/memory tests (must pass before go-live)
- **Cold/warm**: first call cold (record ms); second call within the TTL warm (no spawn).
- **Idle reap**: after the TTL no managed container remains (poll `docker ps`).
- **Preemption**: call APEC while LinkedIn is in grace → LinkedIn container stops immediately, APEC starts; never two at once.
- **Queueing**: two simultaneous calls → serialized; third beyond `queue_timeout` → `busy`.
- **Watchdog**: fake adapter that allocates memory → `budget_exceeded`, container stopped, router healthy.
- **OOM**: container limit below need → `oom_killed` error, one retry policy respected.
- **Crash recovery**: kill the router mid-call → on restart orphan containers with the label are removed.
- **Soak**: 6 h of periodic calls (every 5–20 min) → no growth in router RSS; no leaked tabs/containers; logs clean. Runner: `tests/soak/soak.ts` (plain Node 26, no dependencies, read-only). On the reference host, from the repo root:
  `docker run --rm --network jobwatch_jobwatch-core -e SOAK_SECRET=<JW_FRONT_SHARED_SECRET> -v "$PWD/tests/soak:/soak:ro" node:26-bookworm-slim node /soak/soak.ts`
  It calls `memory_report` every 5–20 min (add real tools with `SOAK_CALLS`, only once the platform budget is approved), fails on any failing call, on router RSS growth above `SOAK_RSS_MB` (40) between the first and last three samples, and, with `SOAK_DOCKER=1` and the socket mounted, on more than one managed browser container. Exit 0 green, 1 red. Check the router logs for errors afterwards: `docker compose logs router | grep '"level":"error"'`. Result of the 6 h run: **not yet recorded**.
- **Profile persistence**: stop/start the runtime ≥ 3 times → still logged in (G4).

## Fingerprint test
Start a runtime, run the fingerprint self-check (`05-…`) and additionally open a public bot-detection test page manually through the login viewer. Compare with the Mac's real Chrome values. Record results in `docs/measurements.md`. Re-run after every Chrome upgrade.

## Acceptance criteria per phase
See `12-roadmap.md` (exit criteria). Global acceptance for go-live:
- [ ] Routine's daily run completes using only the orchestrator for LinkedIn (+ APEC/WTTJ if implemented) for 5 consecutive days without manual intervention.
- [ ] No managed container left running 5 minutes after the last call, on every day.
- [ ] Peak container RSS ≤ configured `memory.max` with ≥ 20% margin; host never swaps heavily during runs.
- [ ] Zero checkpoints/captchas in the 5-day window; otherwise budgets reduced and window restarted.
- [ ] Security checklist in `09-…` fully ticked.

## Tooling
`nx` (`nx affected -t lint typecheck test` in CI), `vitest`, `@jobwatch/sdk/testkit` (fakes + `describeAdapterContract` in every adapter package), `msw` (or undici `MockAgent`) to mock HTTP adapters, `eslint` + `prettier`, `tsc --noEmit` with `strict`, `husky`/`pre-commit` (eslint, secret scan), GitHub Actions or a local `npm run ci` (the owner's choice) running unit+contract+integration on the Ubuntu machine (integration needs the runtime; separate vitest project/tag, e.g. `npm run test:integration`).
