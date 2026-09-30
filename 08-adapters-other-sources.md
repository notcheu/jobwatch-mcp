# 08 — Other adapters (Phase 3)

All return the normalized card shape from `04-…`. Every adapter declares `allowed_hosts` and respects the platform's rate policy.

## WTTJ (Welcome to the Jungle) — browser-backed
Facts from the Chrome-extension era:
- The site is client-rendered: `fetch()` of the pages from another page (status 202, empty shell) and iframes (empty) do **not** work. Real navigation in a real browser tab is required.
- `https://www.welcometothejungle.com/fr/jobs-matches` (logged in) shows matches per the account's preferences (Lead Frontend Engineer; Senior/Expert; Maisons-Laffitte/Paris; CDI; 70K+). Pages 1–2. In the page text each card's **date appears after the card block** (after "Pas pour moi"); in the new adapter parse by DOM structure instead of text order.
- Links: `a[href*="/jobs/"]` → `/fr/companies/<slug>/jobs/<offer-slug>` (prefix the host).
- Company jobs: `https://www.welcometothejungle.com/fr/companies/<slug>/jobs?query=front` (also `design%20system`, `platform`, `staff`). It redirects to `/fr/companies-v1/<slug>/jobs?...`. Wrong slugs give a 404 page ("Erreur 404"): `contentsquare` and `alan` returned 404 on 2026-09-30 (real slugs to discover). Relative dates (`il y a X jours` / `X days ago`) depend on the UI language.
- Watch-list slugs from the routine: pigment, nabla, doctolib, bsport-1, ornikar, modjo, sorare, contentsquare, alan, payfit, swile, back-market, manomano, aircall, mirakl, algolia, criteo, spendesk, malt, leboncoin, brevo, pennylane, blablacar, ledger.
- Tools: `wttj_matches(page)`, `wttj_company_jobs(slug, query, max_age_days)`. Pace like LinkedIn (lower budget). Keep one tab, sequential companies.
- VERIFY: whether WTTJ exposes a stable public JSON/search API used by the site (would remove the browser need). Inspect network calls in spike S9.

## APEC — browser-backed (maybe plain HTTP later)
- URL: `https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=<kw>&lieux=75&typesContrat=101888&salaireMinimum=70&salaireMaximum=200&sortsType=DATE` (75 = Paris department; 101888 = CDI; salary in k€). Keywords used: `frontend`, `react`, `design system`, `tech lead front`.
- Results are cards with: company, title, snippet, salary (`70 - 92 k€ brut annuel`), contract, location (`Paris 08 - 75`), date `dd/mm/yyyy`. Anchors point to `/candidat/recherche-emploi.html/emploi/detail-offre/<id>` (the old extraction tool could not return hrefs; a server-side adapter can).
- The date sort does not guarantee relevance (sales/DevOps/SAP noise, many recruiters like Bluethink, Meteojob): the routine triages; the adapter only normalizes.
- VERIFY: public (no login) access works; APEC may serve partner offers ("Inclure les offres de nos partenaires").
- Tool: `apec_search(keywords, min_salary_k, page, max_age_days)`.

## Free-Work — low priority
Filters in the URL were ignored (mix of freelance/CDI/support). Skip in v1 unless an API/feed with contract filters is found (VERIFY).

## Indeed
An Indeed connector already exists on the Claude side (tools `search_jobs`, `get_job_details`, …). Keep using it directly; it is **not** part of the orchestrator. (It failed to connect on 2026-09-29/30 and appeared later: test it during Phase 5.)

## Company career pages / public ATS job boards — plain HTTP, no browser (high value)
Many watch-list companies host jobs on Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Teamtailor, etc., which expose public JSON/RSS endpoints. A `ats_jobs(provider, company, query)` tool calls them with `httpx` (no container, no semaphore).
Endpoint patterns to **VERIFY** at implementation time (not tested in the design session):
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
