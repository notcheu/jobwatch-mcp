# 02 — What Claude requires from the public endpoint

Source: Anthropic docs "Authentication for connectors" and "Third party connectors with remote MCP" (see `15-sources.md`). Re-read them at implementation time: they change. Items marked VERIFY were not testable from the design session.

## Supported authentication types for a custom remote MCP connector
- `oauth_dcr` — OAuth 2.0 with Dynamic Client Registration (RFC 7591). Default.
- `oauth_cimd` — OAuth 2.0 with Client ID Metadata Document. Default. Claude uses it only if the authorization server metadata advertises `client_id_metadata_document_supported: true` AND `"none"` in `token_endpoint_auth_methods_supported`; otherwise falls back to DCR.
- Static header credential (API key / bearer) entered by an organization Owner: **beta, limited set of organizations**. UI path: "No sign-in" + "Request headers". Up to 4 headers; for `Authorization` the Owner must type the full value including the scheme (`Bearer <token>`). Cannot be combined with OAuth on the `Authorization` header. Never accept tokens in the URL/query string.
- No authentication (anyone with the URL): rejected for this project.
- `client_credentials` (machine-to-machine) is NOT supported. Anthropic-held credentials exist but require contacting `mcp-review@anthropic.com`.
- Authentication settings can't be edited after the connector is added (remove and re-add; members must reconnect).

## OAuth requirements the endpoint must meet
1. **401 with discovery pointer.** Unauthenticated requests get `401` and `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`. A header on a `200` is ignored. Fallback probing: `/.well-known/oauth-protected-resource/<mcp-path>` then `/.well-known/oauth-protected-resource`.
2. **Protected resource metadata (RFC 9728).** `resource` must equal the MCP URL exactly as entered in Claude (including path). `authorization_servers[0]` = issuer (only the first entry is used).
3. **Authorization server metadata** (RFC 8414 or OIDC discovery) reachable from Anthropic's egress range **`160.79.104.0/21`**. A WAF in front of the AS can break the flow.
4. **PKCE S256** on every authorization request; AS must advertise `"code_challenge_methods_supported": ["S256"]`.
5. **Client registration**: expose `registration_endpoint` (DCR) or support CIMD as above.
6. **Redirect URI to allow**: `https://claude.ai/api/mcp/auth_callback` (hosted Claude apps). Claude Code uses loopback redirects on ephemeral ports (`http://localhost:<port>/callback`, `http://127.0.0.1:<port>/callback`, port-agnostic match).
7. **Token endpoint**: accepts `application/x-www-form-urlencoded` (both code exchange and refresh); DCR `/register` uses JSON. Return RFC 6749 error codes (`invalid_grant` for dead refresh tokens). Rotate refresh tokens for public clients (new refresh token in the same response that invalidates the old one).
8. **Scopes**: Claude requests scopes from the `WWW-Authenticate` `scope` parameter, else from `scopes_supported`; it appends `offline_access` when the AS lists it in `scopes_supported` (needed for refresh tokens — recommended so scheduled runs survive token expiry).
9. **Latency**: discovery, registration and token endpoints must answer within **10 s** (refresh: **30 s**). These endpoints must therefore be always-on and never depend on a cold start.
10. **Transport**: Streamable HTTP at a path such as `/mcp`. (A URL ending in `/sse` selects the legacy SSE transport — avoid.)
11. **Consent screen** should show the redirect URI hostname clearly (MCP spec).

## Implications for this project
- The OAuth front and router are **always-on**; only browsers are on-demand.
- Token lifetime/refresh behaviour decides whether unattended routines keep working for weeks: test refresh over days (Phase 0 spike S1/S2). Prefer refresh-token rotation with a long absolute lifetime (e.g., 30–90 days) and a short access token (≈1 h).
- Single authorized user: the OAuth front must only issue tokens to Matthieu's identity (allowlist one account/email). VERIFY how each candidate front enforces this.
- Static-header fallback: if the org has the beta, a long random bearer token in `Authorization` is the simplest machine-friendly option. Keep it as plan B; treat the token as a password (rotate, never in URL).
- Tool-level controls in Claude: Claude lets the user set per-tool permissions (Always allow / Blocked). Expose `readOnlyHint` annotations so read-only tools can be safely "always allowed" for the routine.

## Acceptance checklist for the auth layer (used in Phase 2)
- [ ] `curl -i https://<host>/mcp` (no token) → `401` + `WWW-Authenticate` with `resource_metadata`.
- [ ] `/.well-known/oauth-protected-resource` returns JSON with exact `resource` and first `authorization_servers` entry.
- [ ] AS metadata reachable, lists `registration_endpoint` (or CIMD flags), `code_challenge_methods_supported: ["S256"]`, `offline_access` in `scopes_supported`.
- [ ] Token endpoint accepts form-encoded bodies; refresh rotation works; expired/revoked refresh → `invalid_grant`.
- [ ] Response times < 2 s for discovery/registration/token under normal conditions.
- [ ] Adding the URL as a custom connector in Claude completes the sign-in; tools list appears; a call works.
- [ ] Only Matthieu's account can complete sign-in (try a second account: must fail).
- [ ] Works from Claude Code (`claude mcp add --transport http …`) with loopback redirect.
- [ ] Works from a **scheduled routine** (spike S1). Record exact behaviour when the access token expires during a run.
