# 16 — Architecture diagrams

> **Related docs:** Load for the visual picture. Also load: `00` (overview), `03` (router spec wins on conflicts), `06` (state machine), `10` (deployment and CI), `13` (routine integration). Follow a link only if the task needs it.

Visual companion to `00-overview.md`, `03-router-spec.md`, `06-…` and `13-…`. If a diagram and a numbered spec disagree, the spec wins; fix the diagram.

## 1. Overall system (deployment view)

```mermaid
flowchart LR
  subgraph Cloud["Anthropic cloud"]
    Routine["job-watch routine<br/>scheduled task<br/>00-orchestrator.md ... 06-mail-template.md"]
    Gmail["Gmail connector"]
    Indeed["Indeed connector"]
  end

  Nginx["Existing Nginx reverse proxy<br/>TLS, mcp.example.com"]
  Google["Google sign-in<br/>OAuth app in Testing mode,<br/>one test user"]

  subgraph Host["Home Ubuntu host, rootless Docker, limited RAM"]
    direction LR

    subgraph Core["network jobwatch-core, always-on, one published host port"]
      Front["OAuth front, babs/mcp-auth-proxy<br/>validates bearer token<br/>serves /.well-known, /register, /authorize, /token"]
      Redis[("Redis<br/>replay defence")]
      Router["Router, Node 26 + TypeScript<br/>MCP Streamable HTTP, stateless<br/>optional /metrics on :9464"]
    end

    subgraph Browsers["network jobwatch-browsers, open egress until Phase 4, on-demand, max 1 running"]
      BLI[["Chrome container<br/>profile: linkedin"]]
      BAP[["Chrome container<br/>profile: apec / wttj"]]
    end

    Data[("/srv/jobwatch/data<br/>SQLite: counters, breaker,<br/>seen_ids, call_log")]
    Profiles[("/srv/jobwatch/profiles<br/>0700, never in git")]
    Catalog[("catalog/*.json<br/>static tool schemas")]
  end

  subgraph Obs["Existing observability stack, optional"]
    Prom["Prometheus"]
    Loki["Loki<br/>only if you ship logs"]
    Graf["Grafana<br/>dashboards + alerts"]
  end

  Sites["LinkedIn / APEC / WTTJ"]
  ATS["Public ATS APIs<br/>Greenhouse, Lever, Ashby ..."]

  Routine -- "HTTPS + OAuth, MCP tools/call" --> Nginx
  Nginx -- "proxy_pass to 127.0.0.1:18931" --> Front
  Front -- "authenticated MCP" --> Router
  Front --- Redis
  Front -. "OIDC login at /callback" .-> Google
  Router --- Catalog
  Router --- Data
  Router -- "docker run / stop, CDP by container IP" --> BLI
  Router -- "docker run / stop, CDP by container IP" --> BAP
  BLI --- Profiles
  BAP --- Profiles
  BLI -- "allowlisted hosts only" --> Sites
  BAP -- "allowlisted hosts only" --> Sites
  Router -- "plain fetch, no container" --> ATS
  Prom -. "scrape :9464/metrics<br/>if JW_METRICS_ENABLED=true" .-> Router
  Router -. "JSON logs on stdout,<br/>shipped by Alloy/Promtail" .-> Loki
  Prom --> Graf
  Loki --> Graf
  Routine -.-> Gmail
  Routine -.-> Indeed
```

Notes:
- Nginx is your existing reverse proxy, outside this stack. It is the only public entry point, and the front is the only service behind a published host port.
- Browser containers are not in compose. The router spawns them on demand, with a memory cap, and reaps them after the idle grace period.
- Prometheus and Grafana are your existing instances. The metrics endpoint is off by default, runs on its own port (not behind Nginx or the front), and Prometheus pulls from it. Grafana shows logs only if they are shipped to Loki; Prometheus itself stores metrics, not log lines.
- Indeed and Gmail stay separate connectors, not going through the router.

## 2. Router internals and how adapters plug in

Adapters are the per-platform "sub routines". The router owns everything generic (validation, limits, lifecycle, output shaping). An adapter only knows how to turn validated arguments into a result for one platform.

```mermaid
flowchart TB
  MCP["MCP endpoint<br/>app.ts"] --> List["tools/list"]
  MCP --> Call["tools/call"]

  Catalog[("Tool registry built from adapters<br/>snapshot: catalog/*.json<br/>schemas, limits, allowed_hosts")]
  List -- "answered from catalog,<br/>never starts a container" --> Catalog
  Call --> Lookup["Catalog lookup + zod validation<br/>invalid_arguments"]
  Catalog --> Lookup

  Lookup --> Guard["Rate limiter + circuit breaker<br/>rate_limited, needs_login, checkpoint"]
  Guard --> Decide{"spec.needs_browser?"}

  Decide -- "yes" --> Lease["Runtime manager<br/>global semaphore = 1, FIFO queue<br/>busy after 60 s"]
  Lease --> Backend["RuntimeBackend<br/>DockerCliBackend"]
  Backend --> Container[["Chrome container"]]
  Lease --> CDP["browser/cdp.ts<br/>connectOverCDP, exactly ONE tab,<br/>host allowlist, parked on about:blank in finally"]
  Container --- CDP
  Watchdog["Watchdog, every 5 s<br/>warn 70 %, critical 90 %, OOM"] -. monitors .-> Container
  FP["fingerprint.ts<br/>startup self-check"] -. gates .-> CDP

  Decide -- "no" --> Plain["Plain HTTP path<br/>own concurrency limit and per-host pacing"]

  subgraph Adapters["enabled adapter packages, each exports defineAdapter (see diagram 7)"]
    direction LR
    LI["linkedin<br/>adapter.ts, extract.js,<br/>parse.ts, selectors.ts"]
    APEC["apec"]
    WTTJ["wttj"]
    ATS["ats<br/>fetch only"]
  end

  CDP -- "BrowserSession" --> LI
  CDP -- "BrowserSession" --> APEC
  CDP -- "BrowserSession" --> WTTJ
  Plain -- "HttpClient" --> ATS

  Adapters --> Result["AdapterResult<br/>data, text, warnings"]
  Result --> Shape["shapeOutput<br/>size caps, structuredContent + text,<br/>error codes without secrets"]
  Shape --> MCP

  Guard <--> Store[("store/db.ts<br/>SQLite WAL")]
  Lease --> Idle["touch: idle timer 120 s<br/>then graceful close, SIGTERM, SIGKILL"]
```

To add a platform (diagram 7 shows the packages):
1. `npm run new:adapter -- <id>` creates `packages/adapter-<id>`, adds one line to `packages/adapters` and writes the first catalog snapshot.
2. Write the tools with `defineHttpTool` or `defineBrowserTool`, add fixtures and a contract test using `@jobwatch/sdk/testkit`.
3. `npm run catalog:gen` after every change to a tool, commit the snapshot, then `jobwatch adapters enable <id>` and restart the router.

Only enabled adapters reach `tools/list`. Handlers only receive `AdapterContext` (`BrowserSession`, `HttpClient`, `pace`, `log`), so no generic `navigate` or `evaluate` tool is ever exposed and the host allowlist cannot be bypassed.

## 3. One browser-backed call (sequence)

```mermaid
sequenceDiagram
  autonumber
  participant C as Claude routine
  participant F as OAuth front
  participant R as Router
  participant M as Runtime manager
  participant B as Chrome container
  participant L as LinkedIn

  C->>F: tools/call linkedin_search, bearer token
  F->>R: forward, token validated
  R->>R: validate args, rate limit, breaker check
  R->>M: lease linkedin, budget
  alt another platform is IDLE_GRACE
    M->>M: preempt, stop it now
  else another platform is BUSY
    M-->>R: queue FIFO, busy after 60 s
  end
  opt runtime is COLD
    M->>B: docker run with memory cap, profile volume
    M->>B: wait for DevTools, fingerprint self-check
  end
  M-->>R: lease granted
  R->>B: take the single tab over CDP
  R->>L: goto allowlisted URL, run extract.js
  L-->>R: raw cards
  R->>R: parse.ts normalize, post-filter, cap output
  R->>B: park the tab on about:blank
  R->>M: release, start idle timer 120 s
  R-->>F: structured JSON + compact text
  F-->>C: result
  Note over M,B: after 120 s idle: Browser.close, SIGTERM at 10 s, SIGKILL at 20 s, container removed, profile kept
```

## 4. Runtime state machine (per platform)

```mermaid
stateDiagram-v2
  [*] --> COLD
  COLD --> STARTING: call
  STARTING --> BUSY: DevTools ready
  STARTING --> FAILED: start error
  FAILED --> STARTING: one retry
  BUSY --> IDLE_GRACE: call done
  IDLE_GRACE --> BUSY: new call, same platform
  IDLE_GRACE --> STOPPING: ttl expired, preempted, or max_lifetime
  BUSY --> STOPPING: watchdog above 90 %
  STOPPING --> COLD: container removed, profile kept
```

## 5. How the job-watch routine plugs into the router

The routine keeps its profile, triage, mail template and memory. Only the "read sources" step changes. Each source step becomes one or a few tool calls.

```mermaid
flowchart TB
  subgraph Routine["Job-watch routine, scheduled task"]
    Orch["00-orchestrator.md<br/>entry point"]
    Prof["01-profile.md<br/>titles, criteria, flags"]
    LIs["02-linkedin.md"]
    Oth["04-other-sources.md"]
    Mem[("claude/offres-vues.md<br/>seen offers")]
    Triage["Triage + dedup"]
    Mail["05-mail-rules.md +<br/>06-mail-template.md"]
  end

  subgraph Tools["Router tools, catalog"]
    SS["session_status"]
    LS["linkedin_search"]
    LJ["linkedin_job"]
    WM["wttj_matches<br/>Phase 3"]
    AS["apec_search, apec_job<br/>Phase 3"]
    AJ["ATS tools: teamtailor_jobs, greenhouse_jobs, ...<br/>Phase 3"]
    MR["memory_report"]
  end

  Orch -- "1. connector availability" --> SS
  Prof -- "keywords, geo presets" --> LIs
  Mem -- "skip_ids" --> LIs
  LIs --> LS
  LS -- "plausible cards" --> LJ
  Oth --> WM
  Oth --> AS
  Oth --> AJ

  SS & LS & LJ & WM & AS & AJ --> RouterBox["Router, see diagram 2"]
  RouterBox -- "normalized cards" --> Triage
  Prof -- "flags logic" --> Triage
  Triage --> Mail
  Triage -- "update" --> Mem
  Mail -- "Gmail connector" --> Out(["HTML mail to the owner"])

  SS -. "needs_login / checkpoint:<br/>notify, skip LinkedIn, continue" .-> Mail
  RouterBox -. "rate_limited / busy: wait retry_after_s once<br/>adapter_broken: report in alerts" .-> Mail
```

Fallbacks: if the connector is unreachable, the routine falls back to the Chrome-extension path when available, otherwise it reports all browser sources as failed (see `13-…`).

## 6. Deployment pipeline (CI to the Ubuntu host)

```mermaid
flowchart LR
  Dev["git push to main"] --> GHA
  subgraph GHA["GitHub Actions, docker-publish.yml"]
    Test["test job<br/>lint, typecheck, unit + contract,<br/>catalog drift check"] --> Build["Buildx build<br/>linux/amd64, provenance: false"]
  end
  Build -- "push :latest" --> Reg[("Private registry")]
  subgraph Host["Ubuntu host, rootless Docker"]
    WT["Watchtower<br/>label-enabled containers only"]
    RouterC["router container"]
  end
  WT -- "poll digest, pull" --> Reg
  WT -- "recreate" --> RouterC
  Browser["Chrome browser image<br/>separate workflow, manual pull"] -.-> Reg
```

Only the router auto-updates. The OAuth front is pinned by digest, and the browser image is updated by hand. After a restart the router reaps leftover `jobwatch.managed=true` containers.

## 7. Workspace packages and registration (Nx monorepo)

```mermaid
flowchart TB
  subgraph Apps["apps/"]
    MCP["mcp<br/>composition root, serves MCP"]
    CLI["cli<br/>jobwatch adapters list, enable, disable<br/>login, catalog, doctor"]
  end
  subgraph Pkgs["packages/"]
    Core["core<br/>engine: registry, pipeline, limits, store,<br/>runtime, browser, obs, ops tools"]
    Installed["adapters<br/>installed map: id to import"]
    SDK["sdk<br/>defineAdapter, defineHttpTool/defineBrowserTool, AdapterContext,<br/>testkit, SDK_API_VERSION"]
    AL["adapter-linkedin"]
    AA["adapter-apec"]
    AT["adapter-ats"]
  end
  Cfg[("data/adapters.json<br/>enabled: [linkedin, ...]<br/>or env JW_ADAPTERS")]

  MCP --> Core
  MCP --> Installed
  CLI --> Installed
  CLI -- "edits atomically" --> Cfg
  MCP -- "reads at startup" --> Cfg
  Installed --> AL
  Installed --> AA
  Installed --> AT
  Core --> SDK
  AL --> SDK
  AA --> SDK
  AT --> SDK
```

Allowed dependency directions only (enforced by Nx module boundaries): adapters depend on `sdk` and nothing else, so they can never reach the engine, the browser library or Node's network and file APIs directly. `core` never imports an adapter: the server hands it the enabled ones by name.
