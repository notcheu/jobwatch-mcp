# 03 — Router specification

The router is the only custom service (plus adapters). It is always-on, small, single process, async.

## Responsibilities
1. Serve MCP over Streamable HTTP (stateless) at `/mcp`.
2. Answer `tools/list` from the static catalog (no spawn).
3. Validate `tools/call` arguments with the tool's input schema.
4. Enforce rate limits, daily budgets and the circuit breaker **before** touching a browser.
5. Manage runtimes (browser containers): spawn, health-check, reuse, preempt, reap, kill.
6. Run the adapter, normalize output, enforce output size caps.
7. Record structured logs and metrics.
8. Never trust the client: only catalog tools exist, only allowlisted hosts are reachable by adapters.

It does **not** implement OAuth (the front does), unless decision D7(c) is taken. It still validates that requests come through the front (shared secret header or mTLS on the private network; VERIFY best option for the chosen front).

## Suggested repo layout
```
jobwatch-mcp/
  docs/                      # these MD files
  pyproject.toml             # uv project
  src/jobwatch/
    app.py                   # Starlette app + FastMCP wiring, /healthz
    config.py                # pydantic-settings; env + config.yaml
    catalog/
      loader.py              # reads catalog/*.json, builds MCP Tool objects
      models.py              # pydantic models: ToolSpec, Budget, RatePolicy
    runtime/
      backend.py             # RuntimeBackend protocol
      podman_cli.py          # PodmanCliBackend
      manager.py             # state machine per platform, semaphore, reaper
      watchdog.py            # memory polling, thresholds
    browser/
      cdp.py                 # connect_over_cdp wrapper, tab lifecycle, host allowlist
      fingerprint.py         # startup self-check (navigator.webdriver etc.)
    adapters/
      base.py                # Adapter protocol
      linkedin/
        adapter.py, extract.js, parse.py, selectors.py
      apec/ wttj/ ats/       # later phases
    limits/
      ratelimit.py, breaker.py
    store/
      db.py                  # sqlite (WAL): counters, breaker, seen_ids, call_log
    obs/
      logging.py, metrics.py
  catalog/                   # static tool definitions (see 04)
    session_status.json, linkedin_search.json, linkedin_job.json, ...
  images/browser/            # Containerfile + entrypoint.sh (see 05)
  deploy/                    # compose.yml, systemd units, tunnel config (see 10)
  tests/                     # unit, contract, integration (see 11)
  data/                      # runtime state (gitignored)
  profiles/                  # browser profiles (gitignored, 0700)
```

## Core interfaces (sketch)

```python
class RuntimeBackend(Protocol):
    async def start(self, spec: RuntimeSpec) -> RuntimeHandle: ...
    async def stop(self, handle: RuntimeHandle, grace_s: int) -> None: ...   # graceful then kill
    async def is_running(self, handle) -> bool: ...
    async def memory_bytes(self, handle) -> int: ...                          # cgroup memory.current
    async def cdp_url(self, handle) -> str: ...                               # internal ws/http endpoint

class Adapter(Protocol):
    platform: str
    async def call(self, tool: str, args: dict, ctx: BrowserContextHandle) -> AdapterResult: ...
    async def session_status(self, ctx) -> SessionStatus: ...

@dataclass
class AdapterResult:
    data: dict            # structured payload matching the tool's output schema
    text: str | None      # compact markdown view (optional)
    warnings: list[str]   # e.g. "remote filter not applied; post-filtered"
```

## tools/call flow (pseudo-code)
```python
async def handle_call(tool_name, args, request):
    spec = catalog[tool_name]                      # 404 if unknown
    args = spec.validate(args)                     # pydantic / jsonschema
    if spec.platform:                              # browser- or http-backed
        limiter.check(spec.platform, spec.cost)    # raises RateLimited(retry_after)
        breaker.check(spec.platform)               # raises NeedsLogin / CheckpointOpen
    if spec.needs_browser:
        async with runtimes.lease(spec.platform, budget=spec.budget):   # global semaphore=1, preempts idle others
            ctx = await browser.open_working_tab(spec.platform)         # one tab, host allowlist enforced
            try:
                res = await asyncio.wait_for(adapter.call(tool_name, args, ctx), spec.timeout_s)
            except SessionInvalid:  breaker.open(spec.platform, "needs_login");  raise
            except Checkpoint:      breaker.open(spec.platform, "checkpoint", ttl=6h); raise
            finally:
                await ctx.close_tab()                                   # always
        runtimes.touch(spec.platform)              # (re)start idle timer, default 120 s
    else:
        res = await adapter.call(tool_name, args, None)                 # plain HTTP adapters
    return shape_output(res, spec.output_limits)   # cap bytes, add structured content + text
```

## Concurrency model
- Global `asyncio.Semaphore(1)` for browser leases (configurable later; default 1 because RAM is limited).
- Waiters are served FIFO with a **queue timeout** (default 60 s) → error `busy` with `retry_after`.
- Plain-HTTP adapters (ATS APIs) run outside the semaphore, with their own small concurrency limit (e.g., 4) and per-host pacing.
- Tool calls from the same client may arrive in parallel; serialization happens at the lease, not in the client.

## Error model
Tool errors return MCP `isError: true` with a JSON body `{ "code": "...", "message": "...", "retry_after_s": int|null, "details": {...} }`. Codes:
`invalid_arguments`, `needs_login`, `checkpoint`, `rate_limited`, `busy`, `budget_exceeded` (memory), `oom_killed`, `timeout`, `adapter_broken` (selector drift: extracted 0 cards / missing fields), `upstream_error`, `internal`.
Never include cookies, tokens, full URLs with session parameters, or raw HTML in errors.

## Output rules
- Structured result + optional compact Markdown. Hard cap per call (default 60 KB of text; adapters paginate/truncate with `truncated: true` and counts).
- Always include `source`, `fetched_at` (UTC ISO), `warnings`.
- Mark text coming from web pages as **untrusted content** (field name `untrusted_text` or a wrapper) so the client can treat it as data, not instructions.

## Configuration (env + `config.yaml`)
```
JW_BASE_URL=https://mcp.example.com          # public URL (resource identifier)
JW_FRONT_SHARED_SECRET=...                    # header from the OAuth front (or mTLS)
JW_RUNTIME=podman                             # podman | systemd-scope
JW_BROWSER_IMAGE=localhost/jobwatch-browser:1
JW_PROFILES_DIR=/srv/jobwatch/profiles
JW_DATA_DIR=/srv/jobwatch/data
JW_IDLE_TTL_S=120  JW_MAX_LIFETIME_S=1800  JW_QUEUE_TIMEOUT_S=60
JW_MEM_HIGH_MB=900 JW_MEM_MAX_MB=1100         # defaults; per-tool budgets override (see 06)
JW_LOG_LEVEL=info
```

## Health and ops endpoints
- `GET /healthz` (unauthenticated, returns only `{"ok":true}`) for the tunnel/compose healthcheck.
- `GET /metrics` only on the private network (Prometheus text) — optional.
- Ops tool `memory_report` (catalog, read-only) returns runtime states and recent peak RSS.

## Logging
JSON lines: `ts, request_id, tool, platform, duration_ms, cold_start, peak_rss_mb, result(ok|code), args_hash`. Do not log raw arguments containing user data beyond search keywords; never log tokens or cookies.

## Graceful shutdown
On SIGTERM: stop accepting calls, let in-flight finish (max 20 s), stop all runtimes gracefully, close DB.

## Startup self-checks
1. Catalog loads and validates.
2. Runtime backend reachable (`podman info`).
3. Browser image present (no pull at runtime unless configured).
4. Orphan cleanup: remove containers with the `jobwatch.managed=true` label left from a crash.
