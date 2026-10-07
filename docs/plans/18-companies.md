# 18 — Companies (link jobs to companies, enrich them, show them on a map)

> **Related docs:** Load for anything about companies. Also load: `03` (store, SDK contexts, the utility rules), `08` (the modules that return a company), `17` (the dashboard pages and API), `09` (third-party requests, content policy), `14` (VERIFY items).

**Status: planned, nothing is built (2026-10-07).** Four PRs, in order; each is one branch and one pull request.

## Goal

Jobs are stored with a free-text `company` and, for the company-board tools, a `board` handle (`jobs` table, `packages/core/src/store/store.ts`). Nothing ties two jobs of the same company together and nothing is known about the company itself. In order:

1. every stored job points to a **company**, and the dashboard lists companies with their jobs;
2. a dedicated MCP tool fills a company in (presentation, headcount, location, website, careers page, logo) from **public sources only**, and what it finds is reused by other tools;
3. the dashboard shows companies **on a map** with their job offers attached.

## Decisions (the maintainer, 2026-10-07)

| # | Decision |
|---|---|
| C1 | **Public sources only**: the company's own site (title, meta description, icon, JSON-LD `Organization`) and Wikidata (website, headquarters and its coordinates, employees, inception). No LinkedIn: that would need the signed-in browser and the strict LinkedIn budget (`09-security.md`). |
| C2 | **Coordinates**: Wikidata when the item has them, **Nominatim** as the fallback, results cached for good so a place is looked up once. |
| C3 | **Map**: Leaflet with OSM tiles; the dashboard's content policy is opened for the tile host and only for it. |
| C4 | **First step**: the companies table, the linking of jobs and a Companies page. No MCP tool and no enrichment in the first PR. |

Constraints from `CLAUDE.md` that apply: generic code assumes no country, language, currency or job family (the legal-form list below is data, not code); every tool stays read-only on third parties; the dashboard never calls a third party; a new module gets an entry in `packages/mcp-modules/src/budgets.json`; a database row never leaves the router as it is (a private row and a public response type in `packages/dashboard-api`).

## Data model (migrations 9 and 10 in `store.ts`; a released migration is never edited)

- **`companies`**: `key` (unique, the normalised name), `name`, `website`, `careers_url`, `description`, `headcount_min`, `headcount_max`, `headcount_text`, `hq_label`, `country` (ISO 3166-1 alpha-2), `lat`, `lon`, `wikidata_id`, `logo` (BLOB, at most 64 KB) and `logo_type`, `sources` (JSON: which source gave which field), `first_seen`, `updated_at`, `enriched_at` (null until the tool ran). The integer id never leaves the database: the dashboard and the tools see `key`.
- **`jobs.company_key`** (nullable, indexed), set from `jobs.company` in `putJob`. A job without a company stays null.
- **`geocode_cache`** (`place_key`, `lat`, `lon`, `label`, `country`, `source`, `ts`).
- Companies are **not** evicted with jobs (they are few and small) and are **not** touched by "Clear stored data" of an adapter: a company is shared by platforms. A company with no job and no enrichment older than a year is removed by `Store.prune`.

**Normalised key** (`packages/core/src/companies/key.ts`, a pure function): fold accents and case, drop punctuation, collapse spaces, strip a trailing legal form taken from a small JSON file (`SA`, `SAS`, `GmbH`, `Inc`, `Ltd`, `LLC`, `AB`, `BV`...), so the same firm written two ways lands on one row. Known risk: two different firms with the same name merge. A manual merge or split is a later step, not in PR 1.

## PR 1: companies table, linking, dashboard list

- `store.ts`: migration 9 (`companies`, `jobs.company_key`, index). `putJob` upserts the company and sets `company_key`. A one-time **backfill** of existing jobs when the database opens, in code (the key needs the JS normaliser) and in batches so a large database does not delay the start. New: `listCompanies({ q, sort, offset, limit, hasLocation, enriched })` with job counts, `getCompany(key)`, `companyJobs(key)`.
- `packages/dashboard-api`: `companyRowSchema` (key, name, website, hqLabel, country, headcountText, jobCount, enriched) and `companyDetailSchema` (adds description, careersUrl, sources and its jobs: id, title, location, source, last seen), all `.strict()`, with a contract test that nothing private leaks.
- `apps/mcp/src/dashboard/api.ts` and `app.ts`: `GET /companies` and `GET /companies/:key`, search and paging in SQL like `listJobs`.
- `apps/dashboard`: a **Companies** page and sidebar entry (TanStack Table as in `Runs.tsx`, `DetailPanel` as in `Jobs.tsx`); the Jobs table links the company name to it.
- No MCP tool output changes, so the catalog snapshots stay as they are.
- Reuse: the `Store.listJobs` patterns, `DetailPanel` and `Field`, the typed-response and `checked()` helpers of `api.ts`.
- Docs: `17-dashboard.md` (page, endpoints), `03-router-spec.md` (store tables).

## PR 2: the enrichment tool

- A new utility package `packages/utility-company-info` (`npm run new:utility -- company-info`; the scaffolder adds its `budgets.json` entry). One tool, **`company_info`**: `companies` (names or website URLs, up to 8), `refresh` (default false: a company already enriched is answered from the database with no request, as `linkedin_job` does), `fields`. Read-only, annotated like the other utilities, with `examples` for the Docs page.
- Sources, public HTTP only through the existing `HttpClient` (it already refuses private and loopback addresses, checks every redirect, caps size and paces per host). The module sets `openHttps` (as Teamtailor does) for arbitrary company sites, and lists `www.wikidata.org`.
  - the company's own site: title, meta description, `og:image` and icon, JSON-LD `Organization` (address, `numberOfEmployees`, `sameAs`);
  - Wikidata: `wbsearchentities`, then the entity (official website P856, headquarters P159 and its coordinates P625, employees P1128, inception P571).
- **Matching without false links**: an entity or a page counts only when its website domain matches one we already know or the name matches exactly. An ambiguous result is returned as `candidates` and stores nothing. `sources` records where each field came from.
- SDK: a `ctx.companies` capability, like `ctx.jobs` and `ctx.memory`: scoped by the engine, so a module cannot touch other tables (`packages/sdk/src/context.ts`, implemented in `packages/core/src/contexts.ts`).
- **Logo**: fetched server side, content type checked (PNG, JPEG, WebP, ICO; **no SVG**, it can carry scripts), at most 64 KB, stored in the row and served by `GET /companies/:key/logo` under the existing strict content policy. Hot-linking a third party's logo would need `img-src *`, so it is not done.
- **Reuse by other tools**: the stored job shape of the board and search tools gains an optional `company_key`, and a built-in `stored_companies` (next to `stored_jobs` in `packages/core/src/ops/ops.ts`) lists and reads what is known. The catalog snapshots regenerate (`npm run catalog:gen`).
- The dashboard has **no "enrich" button**: it never calls a third party. A row says "not enriched" and shows the prompt to give Claude.
- Docs: `08-adapters-other-sources.md`, `04-catalog-and-tool-schemas.md`, the README module table; the Wikidata matching result goes to `14-risks-and-open-questions.md`.

## PR 3: geocoding

- A core service `geocode(place)`: the cache first (`geocode_cache`), then Nominatim (`nominatim.openstreetmap.org`), one request per second, with a `User-Agent` and a contact taken from settings (`GEOCODER_URL`, `GEOCODER_USER_AGENT`): the OSM usage policy forbids an anonymous agent. It runs inside `company_info` for a company whose Wikidata item has no coordinates, so the tool's own budget covers it; the Nominatim host is added to that module's allowed hosts.
- The country code comes from the result, not from a configured default.
- A job's own location text is **not** geocoded here (many jobs, many lookups): the map of PR 4 places jobs at their company's headquarters. Per-job places are a follow-up if wanted.
- Tests use a fake HTTP route, never the network.

## PR 4: the map

- `GET /companies/map` returns only `{ key, name, lat, lon, jobCount }`, grouped on a coarse grid server side when there are many points; the detail comes from `GET /companies/:key`.
- A **Map** page (or a tab of Companies) with **Leaflet**, the one new dependency (justified: there is no map in the repo): circle markers sized by job count, a popup with the first jobs linking to the Jobs page. No marker-cluster plugin.
- The dashboard's content policy gains `img-src 'self' data: <tile host>` and nothing else, from a setting `MAP_TILE_URL` (default OSM's; a self-hosted tile server is then one line). The attribution is shown. The tile server sees the area the operator looks at: noted in `09-security.md`.
- `VERIFY:` OSM's tile policy asks for a valid Referer and the dashboard sends `Referrer-Policy: no-referrer`. Set Leaflet's tile `referrerPolicy` to `origin` and check that tiles load.

## Risks and open items (record in `14-risks-and-open-questions.md` when work starts)

- Name collisions on the normalised key, and wrong Wikidata matches: reduced by domain matching and `candidates`, not removed.
- Third-party terms: company sites and Wikidata are public; Nominatim and OSM tiles have usage policies (rate, agent, attribution). `VERIFY:` each one when it is first used.
- Stored third-party text (descriptions) is untrusted: rendered as text only, never as HTML, like job text today.
- The LinkedIn budget is untouched: LinkedIn is not a source.

## Verification (per PR)

- `npm run ci` passes. No test uses the network (`FakeHttpClient` routes from `packages/sdk/src/testkit`).
- PR 1: store tests for the key function, the backfill and the linking in `putJob`; an API test on a real dashboard app; component tests for the Companies page; then `npm run dev` and `npm run dev:dashboard`, store jobs through a board tool, open the page.
- PR 2: the contract test (`validateAdapter` accepts the examples); matching tests with canned Wikidata and HTML fixtures, including an ambiguous one; logo tests (oversized, SVG and wrong type refused); a real call from Claude on a real company, then a look at the row.
- PR 3: a cache test (the second lookup sends no request) and a pacing test (two lookups at least one second apart).
- PR 4: a content-policy test (the tile host only), a map endpoint test, and a look in the browser with tiles loaded.
