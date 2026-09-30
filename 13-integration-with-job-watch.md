# 13 — Integration with the job-watch routine

> **Related docs:** Load for the routine side. Also load: `04` (tool contracts), `07`/`08` (per-platform behaviour), `02` (connector constraints). The routine's own files live outside this repo. Follow a link only if the task needs it.

The routine lives in the parent folder: `../00-orchestrator.md` (entry), `01-profile.md`, `02-linkedin.md`, `03-indeed.md`, `04-other-sources.md`, `05-mail-rules.md`, `06-mail-template.md`, `mail-template.html`, `linkedin-extract.js`; its memory is the Claude project document `claude/offres-vues.md`. The routine is a scheduled task that reads these files and writes one HTML mail via Gmail.

## What changes
Only **how sources are read**. Profile, criteria, triage, mail template/rules, memory file and notification rules stay as they are.

## Mapping (old → new)
| Old step (Chrome extension) | New step (orchestrator tools) |
|---|---|
| Check Chrome availability (`tabs_context_mcp`) | Check connector availability: call `session_status("all")`; `needs_login`/`checkpoint` → notify Matthieu, fall back if possible |
| LinkedIn Paris daily (2 keyword sets, pages 1–2, `f_TPR=r86400`) | `linkedin_search_and_read(keywords=…, geo="paris_idf", posted_within="24h", page=1..2, skip_ids=<ids from offres-vues.md>, open="unseen_matching")` |
| LinkedIn France remote (post-filter) | `linkedin_search(geo="france", remote_only=true, posted_within="24h", page=1..2)` then `linkedin_job` for plausible ones |
| Wednesday sweep (5 pages, no time filter, all offers) | `linkedin_search(posted_within="any", page=1..5)` (+ `linkedin_job` for unseen plausible cards); promoted flag available in cards |
| WTTJ matches | `wttj_matches` (Phase 3) |
| WTTJ company pages | `ats_jobs` for companies with a public ATS (WTTJ `robots.txt` disallows the `jobs?query=` URLs) |
| APEC searches | `apec_search`, then `apec_job` for plausible offers (Phase 3) |
| Career pages | `ats_jobs` (Phase 3) |
| Indeed | unchanged (separate Claude connector) |
| Dedup vs memory | `skip_ids` built from `claude/offres-vues.md` (LinkedIn ids appear in its links); optional later: `seen_filter` |
| Triage, mail, memory update, notification | unchanged |

## Documentation updates at cutover (Phase 5)
- `00-orchestrator.md`: step 3 becomes "connector availability"; the tools table lists the orchestrator tools; keep the Chrome path as fallback.
- `02-linkedin.md`: replace the JS-injection procedure with the tool calls above; keep the old procedure in an appendix "Fallback (Chrome extension)"; move the LinkedIn lessons into this repo's `07-…` (already captured).
- `04-other-sources.md`: per source, note the tool that replaces the Chrome steps.
- `05-mail-rules.md`: alerts vocabulary: `needs_login`, `checkpoint`, `rate_limited`, `budget_exceeded`, `adapter_broken`.
- The routine's scheduled-task configuration must have the connector enabled (VERIFY how connectors attach to scheduled tasks; spike S1).

## Failure handling the routine must implement
- `needs_login` / `checkpoint`: send the notification ("LinkedIn session needs manual login"), skip LinkedIn, continue with other sources.
- `rate_limited` / `busy`: wait `retry_after_s` once, then report the source as partial.
- `adapter_broken`: report in the mail's alerts (source name + tool) and continue.
- Connector unreachable: fall back to the Chrome-extension path if available; else report all browser sources as failed.

## Token-cost expectations (why this is worth it)
The Chrome-extension runs spent many calls per source (navigate, run JS, read chunks). With tools, a daily run is a handful of calls returning compact JSON (descriptions truncated to ~1.2–1.5k chars and only for unseen, plausible titles). Measure tokens per run before/after during the parallel-run phase.

## Data passed between the two worlds
- Input to tools: `skip_ids` (strings), keywords from `01-profile.md`'s title list, geo presets.
- Output from tools: normalized cards; the routine maps them to its mail fields (`TITLE`, `COMPANY`, `LOCATION`, `SALARY`, `PUBLISHED`, `SUMMARY`, flags). Flags logic remains in `01-profile.md`.
