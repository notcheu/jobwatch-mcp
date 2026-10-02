# 07 — LinkedIn adapter (with lessons learned from the Chrome-extension era)

> **Related docs:** Load for the LinkedIn adapter. Also load: `04` (tool shapes), `03` (Adapter SDK), `05` (browser and fingerprint), `09` (usage budget and ToS), `13` (routine side), `14` (VERIFY items). Follow a link only if the task needs it.

The proven extraction logic is `../linkedin-extract.js` (and the procedure in `../02-linkedin.md`). This adapter must reproduce its behaviour server-side with better reliability. Everything below comes from real runs on 2026-09-29/30 unless tagged VERIFY.

## Scope (read-only)
Search results pages and job details pages only. No messaging, no profile views, no Easy Apply, no saving, no following.

## Layouts: A (classic `/jobs/search/`, primary since 2026-10-01) and B (AI `/jobs/search-results/`, kept for when it returns)
LinkedIn serves two search UIs. On 2026-09-29/30 `/jobs/search-results/` (the new AI-assisted search, with a `semanticSearchBox`) worked and was used by the routine. On 2026-10-01 it answered "No results found" for every query (container and Matthieu's Chrome) and LinkedIn reverted to the classic `/jobs/search/` (Matthieu, 2026-10-01). **Decision: layout A is primary; layout B is preserved below and in code, because it may come back.**

The adapter implements a `SearchLayout` per variant (`packages/adapter-linkedin/src/layouts/classic.ts` = A, `layouts/aiSearchResults.ts` = B) with the same interface (`searchUrl(args)`, `isLoaded(page)`, `readCards(page)`, `detailUrl(id)`, `readDescription(page, id)`). The adapter navigates with layout A. After load it detects which markup is present (A: `.scaffold-layout__list` / `li[data-occludable-job-id]`; B: `[componentKey=SearchResultsMainContent]` / `job-card-component-ref-*`) and uses the matching reader, so a silent switch by LinkedIn still parses. "No results found" on the canary query (a search known to have results) maps to `adapter_broken`, never to an empty list. A config flag `JW_LINKEDIN_LAYOUT=classic|ai` chooses which URL is requested.

### Layout A: classic `/jobs/search/` (primary)
Observed 2026-10-01 in Matthieu's Chrome (markers and counts only):
- URL: `https://www.linkedin.com/jobs/search/?keywords=<urlencoded>&geoId=<id>&distance=0[&f_TPR=r86400][&start=<N>]`. LinkedIn adds `currentJobId=<first id>` to the URL on load. **Confirmed (S5, container, 2026-10-01): the routine's boolean `OR` keywords work** ("Staff Frontend Engineer OR Lead Frontend OR Frontend Tech Lead", Paris, no time filter): 25 cards on load, `STATE: ok`. `f_TPR` and `start=` paging are still to verify on layout A.
- Cards: `li[data-occludable-job-id]` (id = that attribute; 7 initially, more after scrolling; each has an `a[href*="/jobs/view/"]`); first three text lines are title / company / location (e.g. `European Union (Remote)`), as in layout B. Container `.scaffold-layout__list`; pagination `.jobs-search-pagination`; a promoted label appears in the list.
- Details pane (split view, `currentJobId` in the URL): description in `#job-details` = `.jobs-box__html-content` = `.jobs-description__content` (same text, about 1.9 KB for the pane's default job); an "About the job" `h2` and the `job-details-jobs-unified-top-card` header exist; `h1` present. **Confirmed (S5).**
- **`/jobs/view/<id>/` (logged in) serves the NEW markup, not the classic one, and does not redirect**: description in `[componentKey^=JobDetails_AboutTheJob_] [data-testid=expandable-text-box]` (1.8 KB and 5.6 KB for two jobs), "About the job" heading present, no `h1`, no `.jobs-description__content`. **Confirmed (S5).** So layout B's detail reader keeps working for single-job pages even while the search list is classic.
- **Design consequence:** `linkedin_job(id)` navigates to `/jobs/view/<id>/` and reads the B description selector first, then falls back to the classic selectors (`#job-details`), so job details do not depend on which search layout is live.
- Loading: 25 cards were already present on load; 3 gentle scroll steps added none (25 per page, consistent with `start=0,25,...` paging). Navigation was **slow in the container**: `domcontentloaded` took 8-28 s (search 25.6 s, one job page 27.6 s) with the host under memory pressure, so adapter timeouts must be generous (at least 45 s per navigation) and `timeout_s` budgets in the catalog sized accordingly.

### Layout B: AI `/jobs/search-results/` (preserved, last verified working 2026-09-30)
URLs:
- Search results: `https://www.linkedin.com/jobs/search-results/?keywords=<urlencoded>&geoId=<id>&distance=0.0[&f_TPR=r86400][&start=<N>]`
  - `geoId=104246759` — LinkedIn resolves it to **"Île-de-France, France"** (checked on the live page 2026-10-02: the location box shows that, and most cards are Paris or its suburbs). It is the whole region, not Paris city only, and LinkedIn also lists remote roles open to a wider area (an "EMEA (Remote)" card came first). `geoId=105015875` — France. Any numeric geoId is accepted by the tools.
  - `posted_within` maps to `f_TPR`: `last_24_hours` = `r86400`, `past_week` = `r604800`, `past_month` = `r2592000`, `any` = no parameter. All three were checked on the live page 2026-10-02: LinkedIn's filter shows "Past 24 hours / Past week / Past month" for them.
  - `start=0,25,50,75,100` for pages 1–5 (25 cards/page). The pagination buttons have `aria-label="Page N"` (clicking one worked in the past; prefer `start=`).
- **`f_WT=2` (remote) is dropped by LinkedIn on load** — the filter is never applied. Remote must be **post-filtered**: keep cards whose location shows `(Remote)` and set `warnings: ["remote filter not applied by LinkedIn; post-filtered"]`. Results for the France search are mixed (Hybrid/On-site/Remote).
- Job details: known-good path = the search-results page with `currentJobId=<id>` (split view; selectors below). `https://www.linkedin.com/jobs/view/<id>` is the public/permalink form used for output URLs; its DOM may differ: **VERIFY in spike S5** (capture both DOMs while logged in and pick one; prefer navigating, not clicking synthetic events).


Selectors / DOM facts (as of 2026-09-30; expect drift):
- Results container: `[componentKey=SearchResultsMainContent]`.
- Cards: `[componentKey^="job-card-component-ref-"]`; job id = last `-`-separated segment of the attribute. **Each card appears twice in the DOM → dedupe by id.**
- Card text (`innerText` split on `\n`, trimmed): noise lines to drop: `Promoted`, `Viewed`, `Easy Apply`, `Be an early applicant`, `Posted …`, and `(Verified job)` markers. After stripping, drop consecutive duplicate lines; the remaining first three are **title, company, location** (location carries the mode: `Paris (Hybrid)`, `(Remote)`, `(On-site)`).
- Salary line (when present) contains `EUR/yr`, e.g. `70K EUR/yr - 100K EUR/yr`.
- `Posted 2 hours ago` / `20 minutes ago` / `3 weeks ago` / `1 month ago` → parse to `posted_hours_ago`.
- `Promoted` line → `promoted: true` (important for the Wednesday sweep); `Easy Apply` line → `easy_apply: true` (never click it).
- Details text: `[componentKey^=JobDetails_AboutTheJob_] [data-testid=expandable-text-box]` → `textContent` (no newlines; fine). The description is loaded only when the details pane is showing **that** job: the URL query `currentJobId` must equal the id, and the text must have changed from the previous job. Poll every ~400 ms, up to ~9 s.
- Descriptions do **not** render in a hidden/background tab (it required taking a screenshot to force rendering in the extension era). A headful, foreground Chrome tab avoids this; keep the window visible to the virtual display.
- Login/checkpoint markers (VERIFY strings): URL containing `/login`, `/uas/login`, `/checkpoint/`, `authwall`; page title "Security Verification"; captcha iframe. Treat any of them as `needs_login` / `checkpoint`.

## Behaviour of each tool
### `session_status("linkedin")`
Navigate to `https://www.linkedin.com/jobs/` (allowed host only), wait for the main content or a login/checkpoint marker. Return `ok | needs_login | checkpoint | unknown`.

### `linkedin_search`
1. Build the URL from validated args (keywords are URL-encoded; `OR` operators allowed: e.g. `Staff Frontend Engineer OR Lead Frontend OR Frontend Tech Lead`).
2. `goto`, wait for cards (timeout 15 s). Zero cards after load ⇒ `adapter_broken` unless the page shows an explicit "no results" text.
3. Extract cards in the page with a JS function (port of the card parsing in `linkedin-extract.js`: dedupe by id, strip noise, title/company/location/salary/posted/promoted/easy_apply).
4. Post-filter `remote_only`; compute `work_mode` from the location suffix; build `url`.
5. Return cards (+ `warnings`). One page view = 1 rate-limit cost unit.

### `linkedin_job`
Reads up to 25 jobs by id with the same rules as the search tool. A job that is already stored is **judged from the database** with this call's terms (`read_from: "stored"`, no visit, no pacing, cost 0) unless `refresh: true`. Otherwise: navigate to the details URL, wait for the About-the-job element (12 s), read the full text, pace 2.5-5 s between jobs. `not_loaded` and `closed` go to `failed` and are **not stored**. Once the page is read and its title passes the terms, the job is **stored at once** (full description, max 20 000 characters); then, with `disallowed_scope: "title_then_description"`, a description match puts it in `excluded` (`reason: description`) but it stays in the database. A title match is excluded and **not stored**. The text returned is cut to `description_max_chars` (500-6000, default 3000) and the list is trimmed to fit the result size (the others come back in `not_returned_ids`).

### `linkedin_search_and_read`
The tool for the daily routine. One call scans `max_results` search results (25 per LinkedIn page, so 50 = pages 1 and 2, 250 = ten pages). For every search card, in order, cheapest check first:
1. **In `skip_ids`** (your own "already reported" list): left alone entirely, reported in `known_ids`.
2. **Disallowed term in the card title**: `excluded` (`reason: title`), **not stored, not opened**. Reading the search page already gave us the card (id, title, company, location), so judging it again with other terms next time costs nothing; there is nothing worth storing.
3. **Already stored** (read by an earlier call, whatever terms it had then): judged **from the database** with this call's terms. No visit, no pacing, no budget. With `disallowed_scope: "title_then_description"` a description match goes to `excluded`; otherwise the job is returned with `read_from: "stored"`. (`stored_jobs: "skip"` lists them in `known_ids` instead, for a plain "only what is new" run.)
4. **Otherwise it is visited** (up to `max_jobs`, default 25, and a soft 200 s time budget): the page is read, the job is **stored immediately**, and only then judged on its description. A description that matches a disallowed term does not undo the storing, so a search with another list reads the job from the database, never from the page again.
5. Jobs not visited because of `max_jobs` or the time budget come back in `remaining_ids`: **call again with the same arguments** (the pages are scanned again, 1 unit each; stored jobs cost nothing), or pass the ids to `linkedin_job` (25 per call), which skips the scan.

Passing jobs are returned newly read first (`new: true`), then stored ones, at most `max_returned` (default 25, max 50) and at most what fits the result size; the others are named in `not_returned_ids` and are free to read with `linkedin_job`. Every returned job carries `source` (`linkedin`), `board` (`null`: LinkedIn has no company boards), `read_from` (`fetched` or `stored`), `new`, `first_seen` and `fetched_at`, so the routine can tell what it has not seen before. The router does not remember what it has already **reported**: to hide those, pass them in `skip_ids` or use `stored_jobs: "skip"`.

`disallowed_terms` has no built-in default and no environment variable: the caller sends the list with every call (whole words or phrases, case-insensitive, plain text, never a regex, which also rules out ReDoS). That is what lets one run search "full stack" and ignore "frontend", and another search "backend" and ignore "fullstack". A job rejected by a list is **not** remembered as rejected: it is judged again by every call, from the cheapest source available.

### Usage guide (what each tool is for)
| Tool | Use it to | Reserved | Spent |
|---|---|---|---|
| `session_status` | check the LinkedIn session before a run (`ok`, `needs_login`, `checkpoint`) | 1 | 1 |
| `linkedin_search` | peek at results: `max_results` cards over as many pages as needed, with `known` flags. Opens and stores nothing | 10 | search pages loaded |
| `linkedin_job` | read specific jobs by id (up to 25). Stored ones come from the database with no visit | 25 | job pages visited, 0 for stored jobs |
| `linkedin_search_and_read` | the routine: scan `max_results` results, read every job that is new and acceptable | 35 | search pages + job pages visited |

Typical run, two searches over 50 results each (2 calls):
```
linkedin_search_and_read { keywords: "full stack engineer", geo: "paris_idf", max_results: 50,
                           disallowed_terms: ["frontend", "front-end", "Angular"], disallowed_scope: "title_then_description" }
linkedin_search_and_read { keywords: "backend engineer", max_results: 50, disallowed_terms: ["fullstack", "full-stack", "full stack"] }
```
For a deep sweep use `max_results: 250` (ten pages). If a result has `remaining_ids`, repeat that same call until it is empty.

**Budget accounting.** A call reserves its maximum up front (so two concurrent calls cannot both pass the last units) and the engine hands back what the handler did not use (`AdapterResult.cost`, `03-router-spec.md`). The reservation is what must fit in the hour: with 200 per hour a `linkedin_search_and_read` (35) can start 5 times at once. What counts afterwards is the real spend: 2 search pages + 25 job pages = 27.

### Job memory and retention
Jobs whose page was read (and whose title was accepted) live in the router's SQLite `jobs` table (`03-router-spec.md`, "Job store") and are evicted `JW_JOB_RETENTION_DAYS` (default 30) after they were **last seen**. Every sighting refreshes `last_seen`: a page read, and also a stored job showing up as a card on any search page (before any filter, title terms and `remote_only` included; `linkedin_job` answering from the database is not a sighting). A posting that is still listed on LinkedIn is therefore never evicted, however long ago its page was read; one that has disappeared from the searches goes after the retention. After eviction a posting counts as new again and is opened again. `fetched_at` stays the time the page was read; `last_seen` is returned on every job.

## Hints dictionaries (`parse.ts`)
- Stack: React, Next.js, TypeScript, JavaScript, Angular/AngularJS, Vue/Vue.js/Nuxt, Node.js, Java, Kotlin, PHP/Symfony, Python, Svelte, GraphQL, Storybook, Design System, micro-frontends. Use **case-sensitive word-boundary** matching for `Vue` (the French word "vue" otherwise matches everywhere).
- Years: patterns like `(\d+)\s*\+?\s*(ans|years)`; return the list of matches.
- Remote: `télétravail`, `remote`, `hybrid`, `\d+ jours`, `full remote`.
- Salary in description: `k€`, `€`, `K EUR`, ranges.

## Language
Labels above are the **English** LinkedIn UI. Keep the account/browser language English (or add French variants: `Sponsorisé`, `il y a`, `Candidature simplifiée`). Decide in Phase 1 and record it; the router's `--lang` and `Accept-Language` must match the account.

## Pacing and budget (defaults, to be approved by Matthieu before going live)
- Minimum 2.5 s (jittered 2.5–5 s) between navigations; never parallel tabs.
- **Budget approved by Matthieu (2026-10-01): 200 per hour, 400 per day** (search page = 1, job page = 1), declared as `rate` by the adapter. At most 10 search pages + 25 job pages per call. This is high for one signed-in account: watch `memory_report` for the real daily spend and lower it at the first sign of friction (a `checkpoint`).
- Circuit breaker: any checkpoint/authwall/captcha marker opens the breaker for 6 h and returns `checkpoint`; `needs_login` opens until `session_status` returns ok.
- A typical daily routine needs ≈ 4–6 search pages + ≈ 15–25 job pages; the Wednesday sweep adds 5–10 pages + ≈ 20 jobs.

## Known oddities
- Once, during the scripted click-through, the tab ended up on `https://www.linkedin.com/notifications/` (a click landed on a navigation link). Navigation-based job opening avoids clicking anchors inside cards.
- Returning a URL or query string from `javascript_tool` was blocked in the extension era; irrelevant here but explains why old notes avoid URLs.
- Output limits (≈1500 chars) of the old tool are gone; the MCP return size cap is ours (60 KB).
- LinkedIn search relevance is loose (returns unrelated roles); the router does **not** filter by relevance beyond explicit args; the routine triages.

## Tests for this adapter
- Fixture-based parser tests: saved **sanitized** HTML of a search page and a details page (store outside git or scrub; no personal data).
- Golden cases: duplicate cards; "(Verified job)" duplicates; promoted + easy apply lines; salary line; every `Posted …` unit; location with `(Remote)`; card with no salary.
- Live smoke test (manual/nightly, off by default): search page 1 returns ≥ 5 cards; one job returns a description ≥ 200 chars; both within budget.

## Implementation status (Phase 1, step 7b)
- Code: `packages/adapter-linkedin` (`parse.ts` pure parsing and filtering, `extract.ts` in-page scripts that only return raw text, `layouts/` URL builders, `search.ts` page readers, `index.ts` the three tools and `sessionCheck`). `JW_LINKEDIN_LAYOUT=ai` picks layout B.
- An empty card list is an honest result only when the page says "No results found"; otherwise it is `adapter_broken`. A login form or `/login`, `/checkpoint` URL throws `SessionInvalid` or `Checkpoint` (opens the breaker).
- Jobs are opened by navigation to `/jobs/view/<id>/`, never by clicking; ids are digits only. Text from the pages is marked untrusted in the tool descriptions.
- Tested with a fake browser and synthetic data only. **VERIFY:** the in-page scripts and the `f_TPR` / `start=` parameters on layout A against the live site, from the NUC after a manual login.

## Verification status (updated 2026-10-02)
- **First live run (2026-10-01, NUC):** the session check returned `ok` and the tools were listed, but `linkedin_search_and_read` skipped 18 of 25 cards and every job page came back `not_loaded`. Two causes, both found by reading the live search page and the original `linkedin-extract.js` / `linkedin-read-job.js`:
  1. **The classic result list is virtualized.** LinkedIn renders only the cards near the viewport; the 25 `li[data-occludable-job-id]` exist at once but 18 of them are empty (7 were filled in the page inspected). The in-page reader now scrolls the result list in steps of 80 % of its height, keeps the fullest read of each card, and stops when all cards are read or two steps in a row add nothing, then scrolls back to the top.
  2. **The job description is rendered lazily.** The `JobDetails_AboutTheJob_` container exists before its text does, so reading once found nothing. The reader now polls inside the page, up to 10 s, until the text is not empty.
- **Checked in a real Chromium container** against a synthetic page that behaves the same way (cards filled only near the viewport and emptied when they leave it, a description that appears 3 s after its container): 25 of 25 cards read in about 5.6 s (a single pass saw 4), the description read after 3.2 s, and `null` after 10 s when it never comes. This proves the scripts' logic, not LinkedIn's current markup.
- **Not yet confirmed on the live site from the NUC:** that the scroll hydrates the cards in the container's Chrome, and that the description is found. A hidden browser tab does not render cards at all (the original scripts needed a "kick" to paint a frame); the container's Chrome runs in a visible Xvfb window, which should not have that problem. Re-run the small test call after updating (`max_results 25`, `max_jobs 3`).
