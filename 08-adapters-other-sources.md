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
- Tools: `wttj_matches(page)` only (`wttj_company_jobs` dropped in v1, see S9 decision below). Pace like LinkedIn (lower budget). Keep one tab, sequential companies.
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

## Company career pages / public ATS job boards — plain HTTP, no browser (high value)
Many watch-list companies host jobs on Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Teamtailor, etc., which expose public JSON/RSS endpoints. A `ats_jobs(provider, company, query)` tool calls them with built-in `fetch` (no container, no semaphore).
**S9 result (2026-10-01):** probed the 24 watch-list slugs (`spikes/s9/probe-ats.mjs`, draft mapping in `spikes/s9/companies.draft.yaml`). **15 of 24 have a working public board**: Ashby (nabla, doctolib, sorare, alan, back-market, pennylane, ledger, spendesk), Lever (pigment, contentsquare, swile, aircall, malt, brevo, blablacar, modjo), Greenhouse (doctolib, mirakl, algolia). Doctolib answers on both Greenhouse (154 jobs) and Ashby (151): check which is current. Empty or tiny boards (modjo 0, spendesk 0, sorare 4, ledger 5, mirakl 10) may be partial. **No public ATS found** for: bsport-1, payfit, leboncoin, ornikar, manomano, criteo (Workable widgets exist for some but return 0 jobs); they likely use Teamtailor, Personio, Welcome to the Jungle itself or a custom site. Verified endpoints: Greenhouse `/v1/boards/<token>/jobs`, Lever `/v0/postings/<token>?mode=json`, Ashby `/posting-api/job-board/<token>` (token may be case- or name-sensitive, e.g. `backmarket`, `Modjo`). SmartRecruiters and Recruitee were probed and matched nothing; Teamtailor was not probed.
Original patterns:
- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true`
- Lever: `https://api.lever.co/v0/postings/<company>?mode=json`
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/<name>`
- SmartRecruiters: `https://api.smartrecruiters.com/v1/companies/<id>/postings`
- Workable: public widget/API under `apply.workable.com`
- Teamtailor: per-company `/jobs.rss`
Plan: (1) `catalog/companies.yaml` maps each watched company to `{provider, token, careers_url}`; (2) a one-off discovery script probes each careers page for ATS links and fills the file; (3) the tool filters by title keywords and location and returns normalized cards with `source=<provider>`; (4) companies without a public ATS fall back to `careers_page` via the browser adapter (Phase 3+, only if worth it).
Large groups from the routine (Kering, Lefebvre Dalloz, TotalEnergies Digital Factory, Siemens, Disneyland Paris, Decathlon, SNCF Connect & Tech, BPCE SI, Crédit Agricole, Amundi, La Banque Postale, Bpifrance, Orange, L'Oréal, LVMH, AFP, FDJ United) often use SAP SuccessFactors/Workday/Taleo: usually no clean public API → low priority; LinkedIn already surfaces many of them.

## Adapter checklist (for any new platform)
1. Catalog entry (schemas, limits, hosts). 2. Adapter class (+ session check if logged-in). 3. Parser + fixtures. 4. Rate policy and budget. 5. Contract tests. 6. Docs: add a section here with URL patterns, DOM facts, pitfalls.
