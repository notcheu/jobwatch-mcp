# CLAUDE.md — entry point for Claude Code sessions (jobwatch MCP orchestrator)

You are continuing a design that was prepared in a Claude (Cowork) session. Everything you need is in these Markdown files. Read them in the order below before writing code.

## Goal in one paragraph
Build a self-hosted **MCP orchestrator** ("jobwatch-mcp") that runs on Matthieu's home Ubuntu machine (limited RAM) and exposes a small set of **read-only, task-level MCP tools** (LinkedIn search/job details, APEC, WTTJ, public ATS job boards…) to Claude over a **public HTTPS endpoint protected by OAuth**. Browser-based tools run in an **on-demand, memory-capped, headful Chrome container** (one shared image, one persistent profile per platform) that is spawned on the first call and stopped after an idle grace period. Its first consumer is the daily job-search routine documented in `/Users/mnogueron/Documents/Private/ClaudeTasks/JobSearch` (the `00-orchestrator.md` … `06-mail-template.md` files and `linkedin-extract.js`).

## Read order
1. `00-overview.md` — context, goals, non-goals, architecture, request flow
2. `01-decisions.md` — decisions taken / proposed / open (with rationale)
3. `02-claude-connector-requirements.md` — what Claude requires from the endpoint (verified from Anthropic docs)
4. `03-router-spec.md` — the router (the core piece)
5. `04-catalog-and-tool-schemas.md` — static tool catalog format + v1 tools
6. `05-browser-runtime.md` — the shared Chrome image and how it is driven
7. `06-memory-and-lifecycle-policy.md` — RAM policy, state machine, limits
8. `07-adapter-linkedin.md` and `08-adapters-other-sources.md` — what each adapter must do (with lessons learned)
9. `09-security.md`, `10-deployment.md`, `11-testing-and-validation.md`
10. `12-roadmap.md` — phases, tasks, exit criteria. **Start with Phase 0 (spikes).**
11. `13-integration-with-job-watch.md`, `14-risks-and-open-questions.md`, `15-sources.md`

## Ground rules (do not break)
- **Read-only by construction.** Never add a tool that posts, sends messages, applies, edits a profile or changes any setting on a third-party platform. No generic `navigate` / `evaluate` / `click` tool is ever exposed to the client: only the catalog's task-level tools exist.
- **Never commit secrets**, cookies, browser profiles, tokens or saved HTML of logged-in pages. `.gitignore` them from the first commit.
- **Static schemas.** `tools/list` must be answered from the catalog files without starting any container.
- **One browser at a time** (global semaphore), one working tab, strict RAM policy (see `06-…`). Treat a RAM regression as a bug.
- **Assumptions tagged `VERIFY:`** in these files are NOT facts. Phase 0 exists to verify them; record the outcome in `14-risks-and-open-questions.md` and update the affected file.
- Prefer small, reviewable commits; every phase ends with its exit criteria met and documented.
- Ask Matthieu before: choosing the public domain/tunnel provider, enabling any tool that writes state outside the router's own data directory, exposing anything beyond the catalog, or changing the LinkedIn usage budget (see `09-security.md`).

## Suggested working directory
The existing job-watch routine documents and `linkedin-extract.js` (the proven LinkedIn extraction logic) are in the original folder; copy `linkedin-extract.js` into `adapters/linkedin/` as the starting point for the adapter.

## First prompt to use
> Read CLAUDE.md and the docs it lists. Start Phase 0 from `12-roadmap.md`: run the spikes, record results in `14-risks-and-open-questions.md`, then propose the repo skeleton from `03-router-spec.md` before writing the router.

## Language
Docs, code comments, commit messages: English. Tool output strings returned to the routine: English (source-site text stays in its original language).
