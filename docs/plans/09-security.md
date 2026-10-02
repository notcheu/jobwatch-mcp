# 09 — Security

> **Related docs:** Load for threat modelling and hardening reviews. Also load: `10` (compose, Docker socket, CI/CD), `05` (browser sandbox), `03` (error model, trust), `07` (LinkedIn budget), `02` (OAuth). Follow a link only if the task needs it.

## Assets to protect
1. The owner's LinkedIn (and other) sessions: cookies in the browser profiles.
2. The home network / machine.
3. The OAuth tokens and client secrets.
4. The job-search data (low sensitivity) and the owner's identity.

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| Anyone on the internet calls the MCP endpoint | OAuth front; router accepts only requests carrying the front's shared secret / mTLS on the private network; router not published on any host port |
| A second Google/IdP account signs in | Allowlist exactly one identity at the front (VERIFY how each candidate enforces it; test with a second account) |
| Token theft | Short access tokens (≈1 h), refresh rotation, revoke-on-suspicion runbook, HTTPS only, no tokens in URLs or logs |
| Client-side misuse of tools (prompt injection from job text) | Read-only catalog; no generic browser tools; `additionalProperties:false`; outputs flagged as untrusted; Claude-side per-tool permissions; router ignores any instruction-like content (it never acts on page text) |
| Malicious page content exploits the browser | Headful Chrome kept current (monthly rebuild), container hardening, host allowlist on navigation, no file downloads (block downloads), no extensions |
| Exfiltration from a compromised page | Egress allowlist for browser containers (proxy or nftables) — Phase 4; container has no access to the home LAN |
| Docker socket abuse | Rootless Docker only; router uses the `mcpuser` user's own socket; no root socket anywhere; router runs as a non-root user with `no-new-privileges`, read-only root fs |
| Account ban or checkpoint | Conservative budgets, jittered pacing, one tab (opt-in extra tabs share the same budget and memory cap), circuit breaker, `session_status`, notify the owner; residential IP only |
| Profile theft from disk | Profiles 0700, dedicated user, disk encryption recommended; do not back up profiles unencrypted |
| Stored job postings (public text, `jobs` table in the router's SQLite file, 0600, in `data/`) | Not secret, but personal in aggregate (what you look for). Evicted after `JW_JOB_RETENTION_DAYS` without a sighting; never logged; the call log still keeps only an argument hash. Back up or wipe `data/` with the same care as the rest |
| Request forgery through an adapter that takes a URL (`openHttps`, Teamtailor custom domains): a prompt-injected job text asks the router to fetch `https://192.168.1.1/` or the cloud metadata address | `openHttps` is off by default, declared per adapter and visible in the catalog. For open hosts the client refuses IP literals and private-looking names, resolves the name and refuses it unless every address is public, re-checks every redirect hop, allows https port 443 only with certificate validation (a home-network service cannot present a valid certificate for a name the caller chose), sends no cookies or identity headers, caps size and time, and logs `open_https_request` (host only). The response is parsed with a strict schema and never echoed. The path of a caller's URL is now kept (a careers site can live under a path of its own domain), but only plain segments are accepted, the request is always `<host><path>/jobs.json`, and a page can only send us to a feed on its own host. Residual risk: the name is resolved once for the check and again by the connection (DNS rebinding), neutralised by the certificate check above |
| Secrets in git | `.gitignore` for `profiles/`, `data/`, `.env`, `secrets/`; pre-commit secret scan |
| Supply chain | CI publishes the router to a private registry (credentials only in GitHub secrets and the host `~/.docker/config.json`); Watchtower updates only the labelled router; pin image digests and npm deps (committed `package-lock.json`, `npm ci`, exact versions); scheduled `npm audit` checks; rebuild browser image deliberately |
| Runaway resource use (DoS on the house) | cgroup caps, rate limits, queue timeout, global semaphore |

## Network
- Public: only the hostname served by your existing Nginx (HTTPS, TLS terminated there). The stack publishes a single host port (the OAuth front), bound to `127.0.0.1` when Nginx runs on the same host, or to the private LAN address otherwise; never `0.0.0.0` unless a firewall restricts it to the Nginx host.
- Optional: restrict the Nginx `server` block (`allow`/`deny`) or WAF to Anthropic's egress range `160.79.104.0/21` — but keep `/.well-known/*` and OAuth endpoints reachable from that range (Anthropic notes a WAF in front of the authorization server can break discovery).
- The optional Prometheus `/metrics` listener (port 9464, `JW_METRICS_ENABLED`) is off by default, is never proxied by Nginx or the front, and is bound to `127.0.0.1` or the LAN address your Prometheus uses.
- **OAuth front and Redis:** the front (babs/mcp-auth-proxy) keeps its production defaults (PKCE required, consent page, per-IP rate limits, `TRUSTED_PROXY_CIDRS` set to Nginx only). Redis is on the internal compose network, not published, memory-capped. The only identity is the Google account listed as the single test user of the Google OAuth app (Testing mode); do not publish that app. `TOKEN_SIGNING_SECRET` and `OIDC_CLIENT_SECRET` live in `deploy/.env` (0600, gitignored).
- Internal networks: `jobwatch-core` (front ↔ router) and `jobwatch-browsers` (router ↔ browser containers). **Egress of the browsers is open until the Phase 4 allowlist proxy (decided by the owner, 2026-10-01):** a compromised page could reach the internet and the home LAN from a browser container. Accepted for now; mitigations in place are the read-only tool surface, `allowedHosts` navigation checks, hardened containers and one browser at a time. Block the LAN with host firewall rules if the reference host shares a network with other devices.
- The DevTools endpoint (port 9222 via socat) is reachable **only** on `jobwatch-browsers` and is never published on a host port (it is full control of the browser and its cookies).
- The login viewer (noVNC) is bound to `127.0.0.1` on the host and reached through an SSH tunnel; never public.

## Browser container hardening checklist
`--cap-drop ALL`, `--security-opt no-new-privileges`, read-only root fs + tmpfs for `/tmp`/`/run`, non-root user, `--pids-limit`, `--memory`/`--memory-swap`, `--cpus`, the custom Chrome seccomp profile (Docker default plus `unshare`, `setns`, `clone`, `chroot`; decided in spike S7, `05` G6) so Chrome keeps its own sandbox; `--no-sandbox` only as a recorded fallback, no host mounts except the platform profile, downloads disabled (Chrome policy or `Browser.setDownloadBehavior deny`), clipboard/permissions denied, no device passthrough.

## Authorization model
Single user. Scopes: `jobwatch.read` (all read-only tools) and `jobwatch.state` (only for `seen_mark` if/when enabled). Enforce scope per tool in the router (the front passes claims in a signed header). Log every call with request id and result code.

## Terms of service and account-risk position (be honest in the docs and with the owner)
LinkedIn's User Agreement prohibits automated access; accounts using automation can be restricted. This project reads the owner's own search results at human-scale volume from the owner's own residential IP with the owner's own logged-in session, and never writes. That is lower risk than commercial scraping but **not zero**. Keep the budget conservative, stop at the first checkpoint, and make it easy to fall back to manual/extension use. Other sites: check each site's terms before enabling its adapter; prefer official feeds/APIs (ATS endpoints) where available.

## Privacy
Do not log descriptions or cookies. Keep call logs 30 days. Never send the profile contents anywhere. Job descriptions returned to Claude are public job-post text.

## Incident runbook (short)
- Suspected token leak: revoke refresh tokens at the front, rotate `JW_FRONT_SHARED_SECRET`, re-add the connector.
- LinkedIn checkpoint email/notification: stop the router's LinkedIn tools (breaker manual open), log in manually from the usual device, resolve the challenge, wait 24 h, resume with lower budgets.
- Unexpected container running: `docker ps --filter label=jobwatch.managed=true`; stop and inspect logs; check the router's call log.
