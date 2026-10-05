# How it fits together

```
Claude ──HTTPS──▶ your reverse proxy (TLS) ──▶ OAuth front ──▶ router ──▶ adapters ──▶ site (HTTP)
                                                                                  └──▶ Chrome container (browser sites)
```

| Part | Role |
|---|---|
| **OAuth front** ([`babs/mcp-auth-proxy`](https://github.com/babs/mcp-auth-proxy) + Redis) | Signs you in with Google and only forwards calls that carry a valid token. |
| **Router** (`apps/mcp`) | The MCP server: validates arguments, applies rate limits, runs modules, stores the jobs it read in SQLite. |
| **Adapters** (`packages/adapter-*`) | One package per source. Only the ones you enable are plugged in. |
| **Utilities** (`packages/utility-*`) | Helper modules that fetch no jobs (places, ATS discovery). Enabled separately. |
| **Browser container** (`images/browser`) | Headful Chrome with one persistent profile per site, spawned by the router through the Docker socket. |
| **Watchtower** | Optional, see [`watchtower.md`](watchtower.md). |

More diagrams: [`plans/16-architecture-diagrams.md`](plans/16-architecture-diagrams.md). Design documents: [`plans/`](plans/) (start with `00-overview.md`).
