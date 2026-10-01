# 04 — Catalog and v1 tool schemas

> **Related docs:** Load for tool definitions and schemas. Also load: `03` (Adapter SDK, `defineHttpTool` or `defineBrowserTool`), `07`/`08` (platform behaviour behind each tool), `13` (how the routine calls the tools). Follow a link only if the task needs it.

> **Source of truth.** Tool definitions are authored in code next to their handler (`defineHttpTool` or `defineBrowserTool`, see `03-…` "Adapter SDK"). The JSON below is the **generated, committed snapshot** (`jobwatch catalog gen`, one `catalog/` folder per adapter package, e.g. `packages/adapter-linkedin/catalog/`) that `tools/list` mirrors and that reviewers diff. Do not hand-edit it; a contract test fails on drift.

## Catalog entry format (`catalog/<tool>.json`)
```json
{
  "name": "linkedin_search",
  "title": "LinkedIn job search (read-only)",
  "description": "Search LinkedIn job listings ... Returns compact cards; never applies to jobs.",
  "platform": "linkedin",
  "adapter": "linkedin",
  "needs_browser": true,
  "inputSchema": { "type": "object", "properties": { ... }, "required": [...], "additionalProperties": false },
  "outputSchema": { ... },
  "annotations": { "readOnlyHint": true, "openWorldHint": true, "idempotentHint": true },
  "limits": {
    "timeout_s": 90,
    "memory": { "high_mb": 1200, "max_mb": 1500 },
    "rate": { "cost": 1 },
    "output_max_bytes": 60000
  },
  "allowed_hosts": ["www.linkedin.com", "media.licdn.com"]
}
```
Rules: `additionalProperties: false` everywhere; every string has `maxLength`; every array has `maxItems`; enums for modes. Descriptions must state read-only behaviour and side effects (none). Keep descriptions short: they are sent on every `tools/list`.

## v1 tool set

### `session_status` (Phase 1)
Input: `{ "platform": "linkedin" | "apec" | "wttj" | "all" }`.
Output: `[{ platform, logged_in: bool, state: "ok"|"needs_login"|"checkpoint"|"unknown", checked_at, note }]`.
Behaviour: opens the platform home page in the platform's browser (spawns it), checks logged-in markers. For LinkedIn a cached answer younger than 10 minutes may be returned (`cached: true`) to avoid needless page loads. The routine calls it first and notifies Matthieu when it is not `ok`.

### `linkedin_search` (Phase 1)
Input:
```json
{
  "keywords": "string (<=200)",
  "geo": "paris_idf | france | <geoId string>",
  "posted_within": "24h | any",
  "remote_only": false,
  "page": 1,
  "max_cards": 25
}
```
Notes: maps to the LinkedIn search URL (classic `/jobs/search/` since 2026-10-01; the AI `/jobs/search-results/` layout is kept as a variant, see `07-adapter-linkedin.md`). `remote_only` is **post-filtered** on the card location because LinkedIn drops the remote URL filter. `page` 1..5 (start = (page-1)*25).
Output: `{ cards: [{ id, title, company, location, work_mode: "remote|hybrid|on-site|unknown", salary_text, posted_text, posted_hours_ago, promoted, easy_apply, url, known }], page, has_more, truncated, warnings }`.
`url` is always `https://www.linkedin.com/jobs/view/<id>` (no tracking parameters).

### `linkedin_job` (Phase 1)
Input: `{ "ids": ["<id>", ...] (maxItems 10), "refresh": false, "description_max_chars": 3000 (500-6000), "disallowed_terms": ["…"] (maxItems 60, default none), "disallowed_scope": "title" | "title_and_description" }`.
Output: `{ jobs: [{ id, title, company, location, description (untrusted text, cut to N chars), description_truncated, url, source: "fetched"|"stored", fetched_at, stack_hints, years_hints, remote_hints, salary_text }], excluded: [{ id, title, reason, term }], failed: [{ id, status: "not_loaded"|"closed" }] }`.
Behaviour: see `07-adapter-linkedin.md`. Stored jobs are answered without a visit; opened jobs are opened **by navigation** with human-like pacing and stored when accepted.

### `linkedin_search_and_read` (Phase 1, the routine's tool)
Input: the search args + `{ "skip_ids": [...] (maxItems 500), "max_jobs": 25 (0-25), "description_max_chars": 3000, "disallowed_terms": [...], "disallowed_scope": "title"|"title_and_description" }`. No built-in terms: the caller sends them.
Output: `{ jobs: [as above, source "fetched"], known_ids, excluded, failed, remaining_ids, page, has_more }`. `remaining_ids` non-empty = call again with the same arguments to continue.

### `apec_search` (HTTP), `apec_job` (browser), `wttj_matches`, `free_work_search`, `ats_jobs` (Phase 3)
`wttj_company_jobs` was dropped in v1 (WTTJ `robots.txt`, see `08`): company jobs come from `ats_jobs`.
See `08-adapters-other-sources.md` for inputs/outputs. All return the same normalized card shape: `{ id, source, title, company, location, work_mode, salary_text, posted_text, url, promoted? }`.

### `seen_filter`, `seen_mark` (Phase 4, optional state)
`seen_filter({ platform, ids[] }) -> { unseen_ids[] }`; `seen_mark({ platform, items:[{id,title,company}] })` writes to the router's SQLite only. `seen_mark` is the only non-read-only tool: annotate `readOnlyHint: false` and `destructiveHint: false`, scope strictly to the router's own data. Decide with Matthieu whether the routine's memory stays in the Claude project (current) or moves here.

### `memory_report` (Phase 1, ops)
Output: `{ runtimes: [{platform, state, uptime_s, rss_mb, peak_rss_mb, last_call_at}], last_calls: [{tool, duration_ms, peak_rss_mb, cold_start, result}] }`.

## Normalized card shape (all sources)
```json
{ "id": "string", "source": "linkedin|apec|wttj|greenhouse|lever|...",
  "title": "string", "company": "string", "location": "string",
  "work_mode": "remote|hybrid|on-site|unknown",
  "salary_text": "string|null", "posted_text": "string|null", "posted_hours_ago": 0,
  "promoted": false, "url": "string" }
```

## Contract tests (Phase 1 onward)
For every tool: (1) catalog validates; (2) adapter output validates against `outputSchema`; (3) output stays under `output_max_bytes` on a max-size fixture; (4) `tools/list` response equals the catalog (snapshot test); (5) `tools/list` does not start any runtime (assert backend not called).
