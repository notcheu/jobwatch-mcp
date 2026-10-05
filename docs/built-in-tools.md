# Built-in tools

`session_status`, `memory_report`, `stored_jobs`, `stored_searches` and `stored_job_texts` are always available. The router remembers the search keywords you used and the jobs each one listed, for `JOB_RETENTION_DAYS`, so that `stored_searches` can tell you which keywords bring jobs in.

## Example queries

Is the LinkedIn session still valid?

```json
{ "platform": "linkedin" }
```

Router state, rate-limit usage per platform and per company board, recent calls (no arguments):

```json
{}
```

The week's new jobs from the database, without calling any site. Add `terms` to see which keywords each job contains and how many jobs each keyword brought in (`stats`); text is off unless you ask for it:

```json
{
  "since": "2026-10-05",
  "until": "2026-10-12",
  "terms": ["react", "typescript", "vue", "remote"],
  "detail": "none",
  "limit": 100
}
```

Only the matching jobs, with a summary, from one source:

```json
{ "since": "2026-10-05", "sources": ["linkedin"], "terms": ["react"], "only_matching": true, "detail": "summary" }
```

How did each search keyword do this week? Runs, jobs listed, returned and new, per keyword:

```json
{ "since": "2026-10-05", "until": "2026-10-12", "source": "linkedin" }
```

The jobs one keyword listed (and, on every job, the keywords that listed it in `found_by`):

```json
{ "since": "2026-10-05", "found_by": "react", "detail": "none" }
```

The text of chosen stored jobs, batched (up to 25). `part` is `full`, `summary`, `outline` or one section (`role`, `requirements`, `nice_to_have`, `offer`, `about`, `process`, `legal`):

```json
{
  "jobs": [{ "source": "linkedin", "id": "4000000001" }, { "source": "teamtailor", "id": "8429717" }],
  "part": "requirements"
}
```
