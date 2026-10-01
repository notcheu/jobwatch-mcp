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
  - `geoId=104246759` — the Paris / Île-de-France search used by the routine; `geoId=105015875` — France.
  - `f_TPR=r86400` = posted in the last 24 h. Omit for the Wednesday sweep and for `posted_within=any`.
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
For each id (max 10 per call): navigate to the details URL, wait for the About-the-job element (timeout 12 s), read text, truncate to `description_max_chars`, compute hints (stack/years/remote), close nothing (same tab reused). Pace between jobs: random 2.5–5 s. Status `not_loaded` if the element never appears; `closed` if the page shows "No longer accepting applications".

### `linkedin_search_and_read`
Search, drop `skip_ids`, apply `title_exclude` (a list of whole words or phrases, never a client-supplied regex, to rule out ReDoS; default = the routine's exclusions: Engineering Manager, Angular, Vue, Java, .NET, fullstack, freelance, stage/alternance, **word-bounded `intern(ship)?`** — the old unbounded `intern` matched "Internal Tools"), open up to `max_jobs` remaining jobs, return cards + details.

## Hints dictionaries (`parse.ts`)
- Stack: React, Next.js, TypeScript, JavaScript, Angular/AngularJS, Vue/Vue.js/Nuxt, Node.js, Java, Kotlin, PHP/Symfony, Python, Svelte, GraphQL, Storybook, Design System, micro-frontends. Use **case-sensitive word-boundary** matching for `Vue` (the French word "vue" otherwise matches everywhere).
- Years: patterns like `(\d+)\s*\+?\s*(ans|years)`; return the list of matches.
- Remote: `télétravail`, `remote`, `hybrid`, `\d+ jours`, `full remote`.
- Salary in description: `k€`, `€`, `K EUR`, ranges.

## Language
Labels above are the **English** LinkedIn UI. Keep the account/browser language English (or add French variants: `Sponsorisé`, `il y a`, `Candidature simplifiée`). Decide in Phase 1 and record it; the router's `--lang` and `Accept-Language` must match the account.

## Pacing and budget (defaults, to be approved by Matthieu before going live)
- Minimum 2.5 s (jittered 2.5–5 s) between navigations; never parallel tabs.
- ≤ 40 page views per tool call, ≤ 120 per hour, ≤ 300 per day (search page = 1, job page = 1).
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
