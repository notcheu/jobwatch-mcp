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

### `linkedin_job` (Phase 1)
Input: `{ "ids": ["<id>", ...] (maxItems 25), "refresh": false, "detail": "full" | "summary" | "none" (default full), "description_max_chars": 3000 (500-6000, with detail full), "disallowed_terms": ["…"] (maxItems 60, default none), "disallowed_scope": "title" | "title_then_description" }`.
Output: `{ jobs: [{ id, title, company, location, description (untrusted text, cut to N chars), description_truncated, url, source: "linkedin", board: null, read_from: "fetched"|"stored", new, first_seen, fetched_at, last_seen, stack_hints, years_hints, remote_hints, salary_text }], not_returned_ids, excluded: [{ id, title, reason, term }], failed: [{ id, status: "not_loaded"|"closed" }] }`.
Behaviour: see `07-adapter-linkedin.md`. Stored jobs are answered without a visit; opened jobs are opened **by navigation** with human-like pacing and stored as soon as their title passes.

### `stored_jobs` (built in, always available)
For the weekly summary and for judging the search keywords. Lists the jobs stored in a date window, from the database only (no site, no browser, cost 0).
Input: `{ "since": "2026-10-05" (ISO date or date-time, UTC; default 7 days before until), "until": (exclusive; default now), "date_field": "first_seen" (default, the week's new jobs) | "last_seen" | "fetched_at", "sources": [...], "boards": [...], "terms": [...] (keywords, one per entry, whole words, case-insensitive), "only_matching": false, "detail": "none" (default) | "summary" | "full", "description_max_chars": 3000, "limit": 50 (1-200), "offset": 0 }`.
Output: `{ jobs: [{ source, id, board, company, title, location, url, first_seen, fetched_at, last_seen, description_chars, summary, summary_kind, description, description_truncated, title_terms, description_terms }], total, offset, next_offset, window, stats: { jobs, scan_truncated, by_source, by_board (top 20), by_day, terms: [{ term, jobs, in_title, in_description_only }], matching_any_term } }`. The statistics cover the whole window (up to 5000 newest jobs), not only the listed page; `only_matching` and paging change `jobs` and `total`, never the statistics. `detail: "none"` keeps a listing small; read the text of chosen jobs with `stored_job_texts`.
The terms are checked at query time against the stored title and description. The router does not record which search found a job, so the statistics say how often a keyword appears in what was stored, not which query brought a job in.

### `stored_job_texts` (built in, always available)
Input: `{ "jobs": [{ "source": "linkedin", "id": "4000000001" }, ...] (1-25, as returned by the search and job tools), "part": "full" (default) | "summary" | "outline" | "role" | "requirements" | "nice_to_have" | "offer" | "about" | "process" | "legal" | "intro", "max_chars": 3000 (200-6000) }`.
Output: `{ jobs: [{ source, id, board, company, title, location, url, first_seen, fetched_at, last_seen, description_chars, part, part_found, text, text_truncated, summary_kind, outline }], missing: [{ source, id }], not_returned: [{ source, id }] }`. Reads the router database only: no site is visited, no browser is started, no platform budget is spent (the call settles its cost to 0). Jobs never read, or evicted after `JW_JOB_RETENTION_DAYS`, are in `missing`; what does not fit one answer is in `not_returned`.

### Returned text: `summary`, `description`, `detail` (all job tools)
Every returned job has `summary`, `summary_kind` (`sections` | `excerpt` | null), `description`, `description_truncated` and `description_chars`. `detail: "summary"` (default of the search and board tools) fills `summary`; `detail: "full"` (default of the `*_job` tools) fills `description`; `none` fills neither. `max_results` is the most jobs returned (and examined); there is no `max_returned`. Details in `07`.

### `linkedin_search` (Phase 1, the routine's tool)
Input: the search args `{ "keywords": "string (<=200)", "geo": "paris_idf | france | <geoId string>", "posted_within": "last_24_hours | past_week | past_month | any", "remote_only": false, "max_results": 25, "page": 1 }` + `{ "skip_ids": [...] (maxItems 500), "stored_jobs": "evaluate" | "skip", "max_jobs": 50 (0-50, job pages to read; the call also stops reading after about 200 s), "detail": "summary" | "full" | "none" (default summary), "description_max_chars": 3000, "disallowed_terms": [...], "disallowed_scope": "title"|"title_then_description" }`. No built-in terms: the caller sends them.
Output: `{ jobs: [as above, `read_from` "fetched" or "stored"], cards, known_ids, not_returned_ids, excluded, failed, remaining_ids, page, pages_loaded, scanned, has_more }`. `remaining_ids` non-empty = call again with the same arguments to continue. **One tool for searching and reading (decided 2026-10-02):** with `max_jobs: 0` no job page is opened and `cards` lists every result (work mode, salary, posted time, `known`); with `max_jobs` > 0 `cards` is empty. There is no separate list-only tool.

### `ashby_jobs` (Phase 3, built)
Same arguments and output as `teamtailor_jobs`, with `boards` = Ashby job board names (`pennylane`, spelled exactly) or page URLs (`https://jobs.ashbyhq.com/pennylane`) and `source: "ashby"`. Details in `08`.

### `lever_jobs` (Phase 3, built)
Same arguments and output as `teamtailor_jobs`, with `boards` = Lever site names (`swile`, case matters) or page URLs (`https://jobs.lever.co/swile`) and `source: "lever"`. Details in `08`.

### `greenhouse_jobs` (Phase 3, built)
Same arguments and output as `teamtailor_jobs`, with `boards` = Greenhouse board tokens (`algolia`) or board URLs (`https://boards.greenhouse.io/algolia`) and `source: "greenhouse"`. Details in `08`.

### `teamtailor_jobs` (Phase 3, built)
Input: `{ "boards": ["bsport", "https://careers.bsport.io/"] (1-10 handles or careers-site URLs), "title_any": [...], "location_any": [...], "posted_within": "last_24_hours|past_week|past_month|any" (default any), "disallowed_terms": [...], "disallowed_scope": "title|title_then_description", "only_new": false, "max_results": 50, "description_max_chars": 1500 }`.
Output: `{ jobs: [{ id, source: "teamtailor", board, company, title, locations, url, posted_at, description, description_truncated, read_from: "fetched", new, first_seen, fetched_at, last_seen, stack_hints, years_hints, remote_hints, salary_text }], not_returned_ids, excluded: [{ id, board, title, reason, term }], boards: [{ board, feed_url, status, jobs_total, relevant, message? }] }`. Details in `08`.

### `apec_search`, `apec_job` (Phase 3, built; browser)
Arguments and output follow `linkedin_search` and `linkedin_job` (`07`), including `cards` with `max_jobs: 0`, with Apec's search arguments: `keywords`, `departments` (default `["75"]`), `cdi_only`, `min_salary_k`, `posted_within`, `max_results` (20 per page). Jobs carry `source: "apec"`, `board: null`, `read_from`, `new`, `first_seen`, `last_seen`, `posted_at`, `salary_text`. Details in `08`.

### `wttj_matches`, `wttj_job` (Phase 3, built; browser, signed in)
Arguments and output follow the Apec tools (`08`): `max_results` (10 per page), `posted_within`, `disallowed_terms` / `disallowed_scope`, `stored_jobs`, `max_jobs` (0 = list the cards only), `skip_ids`; `wttj_job` takes `urls` (WTTJ job URLs, never ids). Jobs carry `source: "wttj"`, `board` = the company slug, `read_from`, `new`, `first_seen`, `last_seen`, `posted_at`, `salary_text`. Details in `08`.

### then `greenhouse_jobs`, `lever_jobs`, `ashby_jobs`... (Phase 3)
One dedicated adapter and tool per ATS (see `08`); there is no combined `ats_jobs`. `wttj_company_jobs` was dropped in v1 (WTTJ `robots.txt`): company jobs come from the company's own ATS tool.
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
