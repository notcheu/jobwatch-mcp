# 08 — Other adapters (Phase 3)

> **Related docs:** Load for APEC, WTTJ and ATS adapters (Phase 3). Also load: `04` (tool shapes), `03` (Adapter SDK), `05` (browser), `13` (routine side). Follow a link only if the task needs it.

All return the normalized card shape from `04-…`. Every adapter declares `allowed_hosts` and respects the platform's rate policy.

## WTTJ (Welcome to the Jungle) — browser-backed
Facts from the Chrome-extension era:
- The site is client-rendered: `fetch()` of the pages from another page (status 202, empty shell) and iframes (empty) do **not** work. Real navigation in a real browser tab is required.
- `https://www.welcometothejungle.com/fr/jobs-matches` (logged in) shows matches per the account's preferences (Lead Frontend Engineer; Senior/Expert; Maisons-Laffitte/Paris; CDI; 70K+). Pages 1–2. In the page text each card's **date appears after the card block** (after "Pas pour moi"); in the new adapter parse by DOM structure instead of text order.
- Links: `a[href*="/jobs/"]` → `/fr/companies/<slug>/jobs/<offer-slug>` (prefix the host).
- Company jobs: `https://www.welcometothejungle.com/fr/companies/<slug>/jobs?query=front` (also `design%20system`, `platform`, `staff`). It redirects to `/fr/companies-v1/<slug>/jobs?...`. Wrong slugs give a 404 page ("Erreur 404"): `contentsquare` and `alan` returned 404 on 2026-09-30 (real slugs to discover). Relative dates (`il y a X jours` / `X days ago`) depend on the UI language.
- Watch-list slugs from the routine: pigment, nabla, doctolib, bsport-1, ornikar, modjo, sorare, contentsquare, alan, payfit, swile, back-market, manomano, aircall, mirakl, algolia, criteo, spendesk, malt, leboncoin, brevo, pennylane, blablacar, ledger.
- Tools: `wttj_matches(page)` only (`wttj_company_jobs` dropped in v1, see S9 decision below). Pace like LinkedIn (lower budget). Exactly one tab (the browser always has one), sequential companies.
- **S9 result (2026-10-01):** a plain HTTP request to a WTTJ page returns **403** (bot protection), so a browser is required; no public API was found without inspecting the site's own network calls in a real browser (not done). `robots.txt` disallows `*/jobs?query=*` and any URL with a query string (`/*?`), which covers the company-page search URL used by the routine. **DECIDED (Matthieu, 2026-10-01): use the ATS tools (below) for watch-list companies and keep WTTJ to `wttj_matches` (logged-in, no query string). Drop `wttj_company_jobs` and the `jobs?query=` URLs from v1** (robots.txt disallows them); for watch-list companies without a public ATS, use the career-page fallback instead.

## APEC — plain HTTP JSON API (no browser, no login)
- URL: `https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=<kw>&lieux=75&typesContrat=101888&salaireMinimum=70&salaireMaximum=200&sortsType=DATE` (75 = Paris department; 101888 = CDI; salary in k€). Keywords used: `frontend`, `react`, `design system`, `tech lead front`.
- Results are cards with: company, title, snippet, salary (`70 - 92 k€ brut annuel`), contract, location (`Paris 08 - 75`), date `dd/mm/yyyy`. Anchors point to `/candidat/recherche-emploi.html/emploi/detail-offre/<id>` (the old extraction tool could not return hrefs; a server-side adapter can).
- The date sort does not guarantee relevance (sales/DevOps/SAP noise, many recruiters like Bluethink, Meteojob): the routine triages; the adapter only normalizes.
- **S9 result (2026-10-01): the site's own search API works over plain HTTP with no login and no cookies** (HTTP 200, JSON). `robots.txt` has no disallow rules. Request (verified):
  ```
  POST https://www.apec.fr/cms/webservices/rechercheOffre      content-type: application/json
  {"motsCles":"frontend","lieux":["75"],"typesContrat":["101888"],"salaireMinimum":"70","salaireMaximum":"200",
   "pagination":{"range":20,"startIndex":0},"sorts":[{"type":"DATE","direction":"DESCENDING"}],"typeClient":"CADRE"}
  ```
  Response: `{ resultats: [...], offreFilters: [...], totalCount }`. Each result has `numeroOffre` (e.g. `179291358W`, this is the id for the detail URL), `intitule`, `nomCommercial`, `lieuTexte`, `salaireTexte`, `datePublication` (ISO), `typeContrat`, `texteOffre` (a truncated snippet of about 300 characters), `origineCode`, `latitude`/`longitude`. The salary filter matches overlapping ranges (a 55-75 k€ offer appeared for a 70+ filter), so post-filter on `salaireTexte`.
  Consequence: `apec_search` becomes an HTTP adapter (`kind: "http"`, no container, no semaphore). This is an undocumented internal API, so treat it as fragile: contract-test the response shape and map a shape change to `adapter_broken`.
  **Full description (browser inspection, 2026-10-01):** the detail page calls `GET /cms/webservices/offre/public?numeroOffre=<id>` (same origin). Verified inside a real APEC tab: HTTP 200 **without cookies** (`credentials: "omit"`), returning the full offer, including `texteHtml` (description, about 3.8 KB for the sample), `texteHtmlProfil`, `texteHtmlEntreprise`, `competences`, `lieux`, `salaireTexte`, `datePublication`, `nomInterlocuteur`. From a plain HTTP client (curl, honest user-agent, with or without `Accept`/`Referer`/`X-Requested-With`) the same URL returns **403**, while the search POST returns 200. We do not try to disguise a client to get past that. Design: `apec_job(id)` is **browser-backed**: open one APEC page in the browser runtime (for example the offer page) and call that endpoint with `fetch` from inside the page; no login is needed, so this can share the APEC runtime and never needs a session check. `apec_search` stays plain HTTP. The endpoint is undocumented: contract-test the shape, map changes to `adapter_broken`. The page also calls `identification/cadre`, `communes/<id>`, `pageEntreprise/public/<id>` and a tracking beacon (`info-apec`), which the adapter must not replicate.
- Tool: `apec_search(keywords, min_salary_k, page, max_age_days)`.

## Free-Work — low priority
Filters in the URL were ignored (mix of freelance/CDI/support). Skip in v1 unless an API/feed with contract filters is found (VERIFY).

## Indeed
An Indeed connector already exists on the Claude side (tools `search_jobs`, `get_job_details`, …). Keep using it directly; it is **not** part of the orchestrator. (It failed to connect on 2026-09-29/30 and appeared later: test it during Phase 5.)

## Applicant tracking systems (ATS): one dedicated adapter each (decided 2026-10-02)
A combined `ats_jobs` tool was dropped: every ATS has its own URLs, response shape, quirks and failure modes, so each one gets its own adapter package, tool and tests (`packages/adapter-<ats>`, tool `<ats>_jobs`), sharing only the SDK helpers (`termMatcher`, `extractHints`, the job store). A company is passed to the tool as a **handle** (its name at that ATS, `bsport`) **or as the URL of its board** (`https://careers.bsport.io/`, `https://boards.greenhouse.io/algolia`), up to a few per call; the adapter works out the provider-specific API from either. A URL must belong to that ATS or, for Teamtailor, be a company's own custom domain that turns out to be a Teamtailor site.

**Hosts that cannot be listed in advance.** Greenhouse, Lever and Ashby have fixed API hosts, so their `allowedHosts` stay exact. Teamtailor boards live on `<handle>.teamtailor.com` (a wildcard suffix) or on any custom domain (`careers.bsport.io`). Letting a model-supplied URL reach arbitrary hosts is a request-forgery risk (the router could be pointed at the home network or a cloud metadata address), so the SDK gets two explicit, visible capabilities, off by default and shown in the catalog: wildcard suffixes (`*.teamtailor.com`) and an `openHttps` flag for custom domains. With `openHttps` the HTTP client still enforces: GET only; https on port 443 only; no IP literals, no `localhost`/`.local`/`.internal`; every address the name resolves to must be public (loopback, private, link-local and metadata ranges are refused), re-checked on every redirect hop; size, time and per-host pacing limits; no cookies or identity headers. See `09-security.md`. The first batch is **Apec, Teamtailor and WTTJ**; the rest are listed here so the choice of the next one is deliberate.

"Verified" means checked against the live service. Everything else is from memory and carries **VERIFY**: probe it (plain GET, honest user agent, one request) before writing the adapter, and never assume a shape.

| ATS | Used by | Public access (handle = the company's name at the ATS) | Status |
|---|---|---|---|
| **Apec** (platform) | French "cadre" jobs | search `POST apec.fr/cms/webservices/rechercheOffre` (plain HTTP); full text `GET /cms/webservices/offre/public?numeroOffre=` only from a page (browser) | **first batch**, verified 2026-10-01 |
| **Teamtailor** | bsport, PayFit, Ornikar, many European companies | `GET https://<handle>.teamtailor.com/jobs.json` (JSON Feed, all open jobs with full descriptions, no login), also `/jobs.rss`; the same paths work on a company's own domain (`careers.bsport.io`) | **adapter built** (`teamtailor_jobs`), verified live 2026-10-02 |
| **WTTJ** (platform) | French tech | logged-in `jobs-matches` page, browser only (plain HTTP is 403; `robots.txt` disallows query strings) | **first batch**, see above |
| Greenhouse | Doctolib, Algolia, Mirakl | `GET boards-api.greenhouse.io/v1/boards/<handle>/jobs?content=true` | **adapter built** (`greenhouse_jobs`), verified live 2026-10-02 |
| Lever | Pigment, Aircall, Swile, Malt, Brevo, BlaBlaCar | `GET api.lever.co/v0/postings/<handle>?mode=json` (handle is case-sensitive) | **adapter built** (`lever_jobs`), verified live 2026-10-02 |
| Ashby | Alan, Pennylane, Nabla, Back Market, Ledger | `GET api.ashbyhq.com/posting-api/job-board/<handle>` (up to 4 MB) | **adapter built** (`ashby_jobs`), verified live 2026-10-02 |
| SmartRecruiters | large groups | `GET api.smartrecruiters.com/v1/companies/<handle>/postings` | documented API, matched no watched company; VERIFY |
| Workable | SMBs | `GET apply.workable.com/api/v1/widget/accounts/<handle>` (widget) | VERIFY; the widgets seen returned 0 jobs |
| Recruitee | SMBs, Europe | `GET <handle>.recruitee.com/api/offers/` | VERIFY |
| Personio | German-speaking and French SMBs | XML feed `<handle>.jobs.personio.de/xml` | VERIFY |
| BambooHR | SMBs | `GET <handle>.bamboohr.com/careers/list` | VERIFY |
| Breezy HR | SMBs | `GET <handle>.breezy.hr/json` | VERIFY |
| Pinpoint | mid-size UK/EU | `GET <handle>.pinpointhq.com/postings.json` | VERIFY |
| JazzHR, Jobvite, Homerun | SMBs | public job pages or feeds, no stable JSON known | VERIFY, low priority |
| Workday | large groups (TotalEnergies, L'Oréal, Decathlon...) | tenant sites `<tenant>.wd<N>.myworkdayjobs.com`; an undocumented JSON endpoint behind the site's own search | VERIFY, fragile |
| SAP SuccessFactors, Oracle Taleo, iCIMS, Cornerstone | large groups | no clean public API, often a login-free HTML search | low priority; LinkedIn already surfaces most of these |

Companies of the routine's watch list that were first marked "no public ATS": **bsport, Ornikar and PayFit are on Teamtailor** (found 2026-10-02: `bsport`, `ornikar` and `payfit` all answer `/jobs.json` on teamtailor.com; Swile has a Teamtailor board with one job but its main board is on Lever). Still unknown: ManoMano, Criteo, Leboncoin; check Personio, Recruitee and Workable before building anything for them.

Per adapter, in this order: probe the endpoint, fix the response shape in a zod schema (a changed shape becomes `adapter_broken`, never an empty list), write synthetic fixtures, then tests, docs, live smoke. Conventions every ATS tool follows (same as LinkedIn, `07-adapter-linkedin.md`): a handle (or a short list) in, `disallowed_terms` plus `disallowed_scope` per call, a date range, `max_results`, normalized postings with `source` (the ATS), `board` (the company handle), `read_from`, `new`, `first_seen`, `last_seen`, and the job store for "have I seen this". **Every stored posting records its source and board** (`03-router-spec.md`): a job id is only unique within one ATS, and the board says which company's page it came from.

Draft code for Greenhouse, Lever and Ashby (provider parsers, HTML-to-text, the watch list) was written on 2026-10-02 and set aside when the decision above was taken; it is a starting point, not a design.

## Teamtailor (`packages/adapter-teamtailor`, tool `teamtailor_jobs`)
- **Endpoint (verified live 2026-10-02 on bsport, PayFit, Ornikar, Swile):** `GET https://<handle>.teamtailor.com/jobs.json`, a JSON Feed 1.1 with every open job: `items[]` = `{ id (uuid), title, url (.../jobs/<numeric id>-<slug>), date_published, content_html, _jobposting }`, where `_jobposting` is schema.org JobPosting data: `identifier.value` (the numeric job id), `datePosted`, `description` (HTML), `hiringOrganization.name`, `jobLocation[].address` (locality, region, postal code, country). It carries no employment type, salary or remote flag: remote and salary come from the description hints. `/jobs.rss` carries the same. No pagination was seen (22 jobs on bsport in one response). A company's own domain serves the same path (`https://careers.bsport.io/jobs.json`).
- **Input:** `boards` = up to 10 handles (`bsport`) or careers-site URLs (`https://careers.bsport.io/`). Only the host of a URL is used. A handle goes to `<handle>.teamtailor.com` (listed host); any other host is reached through `openHttps` and must answer with a Teamtailor feed or it is reported `not_this_ats`. Hosts that cannot be public (IP literals, `localhost`, `.local`...) are reported `invalid` without any request.
- **Filters, all optional:** `title_any` (substring, accents and case ignored: `front` matches `Frontend`), `location_any` (city, country code or postal code of any office), `posted_within` (default `any`; a job without a date is kept), `disallowed_terms` + `disallowed_scope` (`title`, or `title_then_description`), `only_new`, `max_results` (50, max 200), `description_max_chars` (1500, 0 leaves them out).
- **Source and board:** `source: "teamtailor"`; `board` = the lower-case company name the feed announces (`bsport`, `payfit`), so a company reached by handle and by its own domain is one board. The job id is Teamtailor's numeric id, unique across all boards. Every job whose title passes is stored with its full description (a description match does not undo the storing); a title match is neither stored nor returned. Every job still listed has its `last_seen` refreshed.
- **Output:** `jobs`, `excluded`, `not_returned_ids`, and one report per board (`ok`, `not_found`, `not_this_ats`, `invalid`, `refused`, `error`, with job counts), so one bad handle never fails the others.
- **Budget:** one request per board (reserved 10, spent = boards requested); the adapter declares 120 per hour and 600 per day. Not a login-protected platform: no `needs_login` and no circuit breaker.
- **Not verified:** a very large board (hundreds of jobs) in one feed response; the NUC's network reaching custom domains.

## Greenhouse (`packages/adapter-greenhouse`, tool `greenhouse_jobs`)
- **Endpoint (verified live 2026-10-02 on Algolia, Doctolib, Mirakl):** `GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true` returns `{ jobs: [...], meta }`; each job has `id` (number), `title`, `absolute_url`, `company_name`, `location.name`, `first_published`, `updated_at` and `content` (the description as **entity-encoded** HTML, decoded by `htmlToText`). The whole board is one response (Doctolib: 156 jobs, about 2 MB, hence the 8 MB body cap).
- **Input:** `boards` = up to 10 board tokens (`algolia`) or board URLs: `https://boards.greenhouse.io/<token>`, `https://job-boards.greenhouse.io/<token>[/jobs/<id>]`, the embed link (`.../embed/job_board?for=<token>`) or the API URL. Only the token is taken from a URL: the request always goes to `boards-api.greenhouse.io` (the only allowed host), so the adapter is not `openHttps`. URLs with a port or credentials, other hosts and other API versions are `invalid`. The same board named several ways is requested once.
- **Filters, output, source and board, budget (120 per hour, 600 per day):** exactly as for every company-board tool (`03-router-spec.md`, "Company-board adapters"; `04`). `source: "greenhouse"`, job id = Greenhouse's numeric id, `board` = the company name the API reports (`algolia`, `doctolib`).
- **Not verified:** boards on Greenhouse's EU hosts, if they differ from `boards-api.greenhouse.io`.

## Lever (`packages/adapter-lever`, tool `lever_jobs`)
- **Endpoint (verified live 2026-10-02 on Pigment, Aircall, Swile, Modjo):** `GET https://api.lever.co/v0/postings/<site>?mode=json` returns a plain array with every posting: `id` (uuid), `text` (title), `hostedUrl`, `createdAt` (ms), `workplaceType`, `categories.location` and `allLocations`, and the description in parts (`descriptionPlain`, `lists[]` with HTML, `additionalPlain`), which the adapter joins. The site name is case-sensitive (`Modjo`). Postings carry **no company name**: the `board` is the lower-case site name.
- **Input:** `boards` = up to 10 site names or page URLs (`https://jobs.lever.co/<site>[/<posting id>]`, or the API URL). Only the site is taken from a URL; the request always goes to `api.lever.co`, the only allowed host (not `openHttps`). Ports, credentials, other hosts and other API versions are `invalid`. The same site named several ways is requested once.
- **Remote:** Lever states remote work in `workplaceType`, not in the location, so a posting marked `remote` gets `Remote` added to its locations, which is what `location_any: ["remote"]` matches.
- **Filters, output, source and board, budget (120 per hour, 600 per day):** as for every company-board tool (`03-router-spec.md`). `source: "lever"`, job id = the Lever uuid.
- **Not verified:** Lever's EU instance (`api.eu.lever.co` answered 404 for the one company tried).

## Ashby (`packages/adapter-ashby`, tool `ashby_jobs`)
- **Endpoint (verified live 2026-10-02 on Pennylane, Alan, Back Market, Nabla):** `GET https://api.ashbyhq.com/posting-api/job-board/<name>` returns `{ apiVersion, jobs: [...] }` with every posting: `id` (uuid), `title`, `location`, `secondaryLocations` (strings or `{ location }` objects), `publishedAt`, `isListed`, `isRemote`, `jobUrl`, `descriptionHtml` and `descriptionPlain` (the plain text is used). Pennylane's board is 4.3 MB for 147 jobs, which needs the 8 MB body cap. The name must be spelled exactly (`backmarket`, not `back-market`). Postings carry **no company name**: the `board` is the lower-case board name. Postings with `isListed: false` are dropped. `?includeCompensation=true` exists but the salary summaries were empty on the board tried, so it is not used.
- **Input:** `boards` = up to 10 board names or page URLs (`https://jobs.ashbyhq.com/<name>[/<posting id>]`, or the API URL). Only the name is taken from a URL; the request always goes to `api.ashbyhq.com`, the only allowed host (not `openHttps`). Ports, credentials, other hosts and other API paths are `invalid`. The same board named several ways is requested once.
- **Remote:** a posting with `isRemote: true` gets `Remote` added to its locations, which is what `location_any: ["remote"]` matches.
- **Filters, output, source and board, budget (120 per hour, 600 per day):** as for every company-board tool (`03-router-spec.md`). `source: "ashby"`, job id = the Ashby uuid.

## Adapter checklist (for any new platform)
1. Catalog entry (schemas, limits, hosts). 2. Adapter class (+ session check if logged-in). 3. Parser + fixtures. 4. Rate policy and budget. 5. Contract tests. 6. Docs: add a section here with URL patterns, DOM facts, pitfalls.
