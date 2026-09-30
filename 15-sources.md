# 15 — Sources consulted during design (re-check when implementing)

Claude connector requirements
- Authentication for connectors — https://claude.com/docs/connectors/building/authentication
- Third party connectors with remote MCP — https://claude.com/docs/connectors/custom/remote-mcp
- Anthropic egress IP reference — https://platform.claude.com/docs/en/api/ip-addresses

Gateways / OAuth fronts
- R0Wi/mcp-gateway — https://github.com/R0Wi/mcp-gateway
- Docker MCP Gateway — https://github.com/docker/mcp-gateway and https://docs.docker.com/ai/mcp-gateway/
- MetaMCP — https://github.com/metatool-ai/metamcp
- IBM ContextForge — https://github.com/IBM/mcp-context-forge
- babs/mcp-auth-proxy — https://github.com/babs/mcp-auth-proxy
- obot-platform/mcp-oauth-proxy — https://github.com/obot-platform/mcp-oauth-proxy
- Awesome MCP gateways — https://github.com/e2b-dev/awesome-mcp-gateways
- Existing LinkedIn MCP (reference only) — https://github.com/stickerdaniel/linkedin-mcp-server

Browser runtime
- chromedp/docker-headless-shell — https://github.com/chromedp/docker-headless-shell
- Lightpanda — https://github.com/lightpanda-io/browser
- Detecting headless Chrome driven by Playwright (Castle) — https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/
- Session cookies persisted with "Continue where you left off" (Brave issue) — https://github.com/brave/brave-browser/issues/28379
- Headless Chromium RAM growth and fixes — https://dev.to/rendershot/headless-chromium-at-scale-four-fixes-for-a-fleet-that-kept-eating-ram-1mdp
- Chromium memory practices and flags — https://webscraping.ai/faq/headless-chromium/what-are-the-best-practices-for-managing-memory-usage-in-headless-chromium

Project context (local files, parent folder)
- `../linkedin-extract.js`, `../02-linkedin.md`, `../04-other-sources.md`, `../01-profile.md`, `../00-orchestrator.md`
