# Changelog

## [0.3.0](https://github.com/notcheu/jobwatch-mcp/compare/jobwatch-router-v0.2.0...jobwatch-router-v0.3.0) (2026-10-07)


### Features

* **bamboohr:** add the bamboohr_jobs tool to read the open jobs of a company on BambooHR ([#107](https://github.com/notcheu/jobwatch-mcp/issues/107)) ([98c0f78](https://github.com/notcheu/jobwatch-mcp/commit/98c0f78428b58f2c00149ac1bf95939d7aba1d0a))
* **breezy:** add the breezy_jobs tool to read the open jobs of a company on Breezy HR ([#106](https://github.com/notcheu/jobwatch-mcp/issues/106)) ([2eef211](https://github.com/notcheu/jobwatch-mcp/commit/2eef211035eb11b7c282e6fccde7121836664c65))
* **custom:** add custom adapters written on the dashboard, run in a sandbox with no network ([#109](https://github.com/notcheu/jobwatch-mcp/issues/109)) ([291d79b](https://github.com/notcheu/jobwatch-mcp/commit/291d79be5e645a3e1e8437fd99ced36726bda5fb))
* **dashboard:** add ATS discovery and LinkedIn places pages, a Tools menu and a Utility tab ([#99](https://github.com/notcheu/jobwatch-mcp/issues/99)) ([ec726ff](https://github.com/notcheu/jobwatch-mcp/commit/ec726ff88ff19c7e38a0a71b16a482185d6e6208))
* **dashboard:** drop the Board column and name the company of every ATS job ([#98](https://github.com/notcheu/jobwatch-mcp/issues/98)) ([558ad53](https://github.com/notcheu/jobwatch-mcp/commit/558ad53581c68003f4d50de8a15cbec4ee5f9399))
* **dashboard:** search detail and health, and keyword lists for every search ([#96](https://github.com/notcheu/jobwatch-mcp/issues/96)) ([18fe50c](https://github.com/notcheu/jobwatch-mcp/commit/18fe50c31682f7edf7057c23e3b90278c3c70fd6))
* **hibob:** add the hibob_jobs tool to read the open jobs of a company on HiBob ([#102](https://github.com/notcheu/jobwatch-mcp/issues/102)) ([2321e6c](https://github.com/notcheu/jobwatch-mcp/commit/2321e6ccb657e20e647e51e6599477780db15f28))
* keep the call log in the database, with a log rotation setting ([#97](https://github.com/notcheu/jobwatch-mcp/issues/97)) ([34bff3a](https://github.com/notcheu/jobwatch-mcp/commit/34bff3a3595abbac37cf2f5c3efd488c410dd3af))
* **personio:** add the personio_jobs tool to read the open jobs of a company on Personio ([#105](https://github.com/notcheu/jobwatch-mcp/issues/105)) ([e75f6ad](https://github.com/notcheu/jobwatch-mcp/commit/e75f6ad59e6c3ed0e6e5d011f5617f782e33a3c3))
* **recruitee:** add the recruitee_jobs tool to read the open jobs of a company on Recruitee ([#101](https://github.com/notcheu/jobwatch-mcp/issues/101)) ([992451b](https://github.com/notcheu/jobwatch-mcp/commit/992451b090f8ac7ba25e48b124742c03baaed7f1))
* **sdk:** let a board source read its board itself, with a limit on the postings read one by one ([#100](https://github.com/notcheu/jobwatch-mcp/issues/100)) ([23c4000](https://github.com/notcheu/jobwatch-mcp/commit/23c4000590e80b99cad23549b92679262ef1f4d3))
* **smartrecruiters:** add the smartrecruiters_jobs tool to read the open jobs of a company on SmartRecruiters ([#104](https://github.com/notcheu/jobwatch-mcp/issues/104)) ([0b7cb7d](https://github.com/notcheu/jobwatch-mcp/commit/0b7cb7d1db8ecea6d44447fdd615faa57983fa3e))
* **workable:** add the workable_jobs tool to read the open jobs of a company on Workable ([#103](https://github.com/notcheu/jobwatch-mcp/issues/103)) ([91d9fd4](https://github.com/notcheu/jobwatch-mcp/commit/91d9fd4266fb627a0d0eb30b71541f98405844d1))
* **workday:** add the workday_jobs tool to read the open jobs of a company on Workday ([#108](https://github.com/notcheu/jobwatch-mcp/issues/108)) ([f0346f3](https://github.com/notcheu/jobwatch-mcp/commit/f0346f37f99a9e4e5a9d2b5e218ad07b19e62a69))

## [0.2.0](https://github.com/notcheu/jobwatch-mcp/compare/jobwatch-router-v0.1.1...jobwatch-router-v0.2.0) (2026-10-06)


### Features

* clear the stored data of an adapter from the CLI and the dashboard ([#90](https://github.com/notcheu/jobwatch-mcp/issues/90)) ([1328b2a](https://github.com/notcheu/jobwatch-mcp/commit/1328b2a1d436230e6c8fb56e497d568044bb3bf9))
* **dashboard:** add a Docs page with the parameters and examples of every tool ([#92](https://github.com/notcheu/jobwatch-mcp/issues/92)) ([b736dc4](https://github.com/notcheu/jobwatch-mcp/commit/b736dc4a630160f3568bb0f3bb05d43f0c0ab85b))
* **dashboard:** add a settings menu per module and editable request budgets ([#93](https://github.com/notcheu/jobwatch-mcp/issues/93)) ([762bfc0](https://github.com/notcheu/jobwatch-mcp/commit/762bfc0592cf980c5866e051865fc6f6789d40d9))
* run and develop the dashboard locally ([#91](https://github.com/notcheu/jobwatch-mcp/issues/91)) ([9ed731c](https://github.com/notcheu/jobwatch-mcp/commit/9ed731c9c3f66c1cfb28ca31a80e51b1b4af88e9))


### Documentation

* document pulling the browser image and move the tool examples to docs/ ([#89](https://github.com/notcheu/jobwatch-mcp/issues/89)) ([09d9fbb](https://github.com/notcheu/jobwatch-mcp/commit/09d9fbb5c17d934505f3c0dd288dbbc7b58df35c))

## [0.1.1](https://github.com/notcheu/jobwatch-mcp/compare/jobwatch-router-v0.1.0...jobwatch-router-v0.1.1) (2026-10-06)


### Refactoring

* **deploy:** make rootless Docker and Watchtower compose add-ons ([#82](https://github.com/notcheu/jobwatch-mcp/issues/82)) ([bd82ce8](https://github.com/notcheu/jobwatch-mcp/commit/bd82ce83d58448ee6fddf18c981e4b3145086b2a))


### Documentation

* default BROWSER_IMAGE to the published browser image ([#86](https://github.com/notcheu/jobwatch-mcp/issues/86)) ([d4c6848](https://github.com/notcheu/jobwatch-mcp/commit/d4c68488bb1a906d7ff0dca49cad831762962b46))

## 0.1.0 (2026-10-06)


### Features

* **adapter-apec:** add the Apec adapter, read from a real browser page ([#35](https://github.com/notcheu/jobwatch-mcp/issues/35)) ([4afc818](https://github.com/notcheu/jobwatch-mcp/commit/4afc818aaba53b9a91e7e8c896f7ce986dbfb9e2))
* **adapter-ashby:** add the Ashby adapter, by job board name or page URL ([#32](https://github.com/notcheu/jobwatch-mcp/issues/32)) ([fde2cda](https://github.com/notcheu/jobwatch-mcp/commit/fde2cda486d96f2511f5b0dc9c5a1c3db8b1dbe9))
* **adapter-greenhouse:** add the Greenhouse adapter and share the board reading loop ([#30](https://github.com/notcheu/jobwatch-mcp/issues/30)) ([97518bf](https://github.com/notcheu/jobwatch-mcp/commit/97518bfc59fb2f44cb048b986f3fbe9e0ed79e80))
* **adapter-lever:** add the Lever adapter, by site name or page URL ([#31](https://github.com/notcheu/jobwatch-mcp/issues/31)) ([9789cd9](https://github.com/notcheu/jobwatch-mcp/commit/9789cd9c57dd08ccbfbfbe2fefd52c90dc9b8f09))
* **adapter-linkedin:** add the LinkedIn adapter ([#10](https://github.com/notcheu/jobwatch-mcp/issues/10)) ([5452b3c](https://github.com/notcheu/jobwatch-mcp/commit/5452b3cd779204297847ef2f8dc72a5555b960c7))
* **adapter-linkedin:** filter by date posted: last 24 hours, past week, past month or any ([#23](https://github.com/notcheu/jobwatch-mcp/issues/23)) ([3216915](https://github.com/notcheu/jobwatch-mcp/commit/32169153aa0d7281cd31cfb9f62941f65bd221fc))
* **adapter-linkedin:** scan max_results over several pages and settle the real cost ([#19](https://github.com/notcheu/jobwatch-mcp/issues/19)) ([040f59e](https://github.com/notcheu/jobwatch-mcp/commit/040f59eef7e354a61e6164444216aa5e19082c2e))
* **adapter-linkedin:** skip stored jobs, store accepted ones, take disallowed terms per call ([#18](https://github.com/notcheu/jobwatch-mcp/issues/18)) ([8b9d331](https://github.com/notcheu/jobwatch-mcp/commit/8b9d3313c0570c99b43e8afbd670335926557b72))
* **adapter-linkedin:** store a job once its page is read and judge stored jobs from the database ([#20](https://github.com/notcheu/jobwatch-mcp/issues/20)) ([b3d3df2](https://github.com/notcheu/jobwatch-mcp/commit/b3d3df2f5272f1930bab5b86438c6722c18520f9))
* **adapter-teamtailor:** add the Teamtailor adapter, by handle or careers-site URL ([#28](https://github.com/notcheu/jobwatch-mcp/issues/28)) ([a905a27](https://github.com/notcheu/jobwatch-mcp/commit/a905a278d0ed561f32a1a8e0bc6cfb5018135ba5))
* **adapter-teamtailor:** keep the careers path and discover the feed from any page of a site ([#37](https://github.com/notcheu/jobwatch-mcp/issues/37)) ([50f0934](https://github.com/notcheu/jobwatch-mcp/commit/50f0934800a2f5822d68833b6e164eb0ec9a575b))
* **adapter-wttj:** add the Welcome to the Jungle adapter for the signed-in matches ([#36](https://github.com/notcheu/jobwatch-mcp/issues/36)) ([00339f8](https://github.com/notcheu/jobwatch-mcp/commit/00339f8f386b2e71ae31bd32571147721f6fda7c))
* add a min_salary filter and ask LinkedIn for remote jobs ([4654202](https://github.com/notcheu/jobwatch-mcp/commit/46542026b79f5e796bd5cd8f70742b1e023643d4))
* add ats_find to discover which ATS hosts a company's careers board ([b92be0f](https://github.com/notcheu/jobwatch-mcp/commit/b92be0ff39c8489b8a245b7ee04aed119fdca60b))
* **cli:** add the login, catalog and doctor commands ([#11](https://github.com/notcheu/jobwatch-mcp/issues/11)) ([367985a](https://github.com/notcheu/jobwatch-mcp/commit/367985a06dacc067a576f0ce00f68d9940594919))
* **core:** add a job store for adapters with configurable retention ([#17](https://github.com/notcheu/jobwatch-mcp/issues/17)) ([7df8071](https://github.com/notcheu/jobwatch-mcp/commit/7df8071155e309d635d53807e2f5b85f9f0c27cc))
* **core:** add config, adapter registry and the adapter generator ([#4](https://github.com/notcheu/jobwatch-mcp/issues/4)) ([33b1c07](https://github.com/notcheu/jobwatch-mcp/commit/33b1c07c2f80864e8fd47a5d8613efecc3ae90ff))
* **core:** add stored_job_texts to read the text of already-read jobs without a browser ([#39](https://github.com/notcheu/jobwatch-mcp/issues/39)) ([7f8dd0d](https://github.com/notcheu/jobwatch-mcp/commit/7f8dd0d480151c89d3f82bd389ab25be2f6d0cb5))
* **core:** add stored_jobs to list the jobs stored in a date window with keyword statistics ([#46](https://github.com/notcheu/jobwatch-mcp/issues/46)) ([58aa885](https://github.com/notcheu/jobwatch-mcp/commit/58aa885747ff59110e7750c313ae57ab08a0dc89))
* **core:** add the browser layer, HTTP client and context provider ([#8](https://github.com/notcheu/jobwatch-mcp/issues/8)) ([2ea5be4](https://github.com/notcheu/jobwatch-mcp/commit/2ea5be4e6d2893a6a9cb6b3afc4f74601a310ec7))
* **core:** add the built-in session_status and memory_report tools ([#9](https://github.com/notcheu/jobwatch-mcp/issues/9)) ([467df6f](https://github.com/notcheu/jobwatch-mcp/commit/467df6ff0c7ace68346ca2ead9555bcd440b063d))
* **core:** add the runtime backend and the runtime manager ([#7](https://github.com/notcheu/jobwatch-mcp/issues/7)) ([abbda5d](https://github.com/notcheu/jobwatch-mcp/commit/abbda5d8b920d478281309fc48abb44f3e3ad697))
* **core:** add the SQLite store, rate limiter and circuit breaker ([#6](https://github.com/notcheu/jobwatch-mcp/issues/6)) ([a1d151b](https://github.com/notcheu/jobwatch-mcp/commit/a1d151ba90fa83b1957b73b38732de6d8197df55))
* **core:** give each company board of an ATS its own budget ([#41](https://github.com/notcheu/jobwatch-mcp/issues/41)) ([2a5af50](https://github.com/notcheu/jobwatch-mcp/commit/2a5af505bce77767fb407969d9f2f498f3ef3eac))
* **core:** keep a browser adapter's session cookies across a browser restart ([#42](https://github.com/notcheu/jobwatch-mcp/issues/42)) ([edbbd28](https://github.com/notcheu/jobwatch-mcp/commit/edbbd282c76c7cd85a779b3759d9aa07a244e76a))
* **core:** keep the last calls in memory with their parameters and estimated tokens ([#56](https://github.com/notcheu/jobwatch-mcp/issues/56)) ([732752a](https://github.com/notcheu/jobwatch-mcp/commit/732752afdbf4f9fba2967f6ba9cda1971156d2a3))
* **core:** let a browser call open extra tabs when JW_BROWSER_MULTITAB is on ([#50](https://github.com/notcheu/jobwatch-mcp/issues/50)) ([f94d2c8](https://github.com/notcheu/jobwatch-mcp/commit/f94d2c87f8402d817151be1b65b7c0fd7d141aa0))
* **core:** record the search keywords with the job ids each search listed ([#52](https://github.com/notcheu/jobwatch-mcp/issues/52)) ([cd4e385](https://github.com/notcheu/jobwatch-mcp/commit/cd4e385e8424c11a3d484bf8b83d5d5ec7debeb3))
* **core:** record the source and the company board of every stored job ([#26](https://github.com/notcheu/jobwatch-mcp/issues/26)) ([33ca35a](https://github.com/notcheu/jobwatch-mcp/commit/33ca35a7f9168c194d8382deb27a43201f856653))
* **core:** refresh a stored job's last seen time on every sighting and evict from it ([#21](https://github.com/notcheu/jobwatch-mcp/issues/21)) ([79103d3](https://github.com/notcheu/jobwatch-mcp/commit/79103d3d13865dee400e5c569a0d50bf39d65b9c))
* **core:** reload the enabled adapters in a running router without a restart ([#57](https://github.com/notcheu/jobwatch-mcp/issues/57)) ([546f5bc](https://github.com/notcheu/jobwatch-mcp/commit/546f5bc22bdbfc8cfc9f73dff749921b91566d98))
* **core:** reserve a call's cost from its arguments and charge what the engine measured ([#40](https://github.com/notcheu/jobwatch-mcp/issues/40)) ([cd2211c](https://github.com/notcheu/jobwatch-mcp/commit/cd2211c51382b56a4605a33536b740976afcde13))
* **dashboard:** add a salary column read from the job text, with any currency ([#66](https://github.com/notcheu/jobwatch-mcp/issues/66)) ([a3f6445](https://github.com/notcheu/jobwatch-mcp/commit/a3f6445ada1b27b8b3faed0ae3d8e2b0f322039f))
* **dashboard:** add settings, an audit and build step in CI, a smoke script and the checklist run ([#64](https://github.com/notcheu/jobwatch-mcp/issues/64)) ([e254f5e](https://github.com/notcheu/jobwatch-mcp/commit/e254f5e4de7ae0939dec9696a72760afa7924fec))
* **dashboard:** add the analytics page and persisted daily totals ([#63](https://github.com/notcheu/jobwatch-mcp/issues/63)) ([de19245](https://github.com/notcheu/jobwatch-mcp/commit/de192455469356a6e06a3d3d64834cdde60a76d8))
* **dashboard:** add the jobs table with a detail panel, and the searches page ([#61](https://github.com/notcheu/jobwatch-mcp/issues/61)) ([bab08cb](https://github.com/notcheu/jobwatch-mcp/commit/bab08cbd9f0f8973f38ef02242f7eb6bc18e92d7))
* **dashboard:** add the React interface shell, overview and runs ([#60](https://github.com/notcheu/jobwatch-mcp/issues/60)) ([1f53715](https://github.com/notcheu/jobwatch-mcp/commit/1f537158f7611428c28cf4896acb7fea12513295))
* **dashboard:** add tools and status with enable, disable and restart ([#62](https://github.com/notcheu/jobwatch-mcp/issues/62)) ([1ddb007](https://github.com/notcheu/jobwatch-mcp/commit/1ddb007a2acd4b0be18512d46d66e33536c96fde))
* find the LinkedIn geoId of a place, resolve place names by themselves and manage names from the CLI ([#69](https://github.com/notcheu/jobwatch-mcp/issues/69)) ([936f661](https://github.com/notcheu/jobwatch-mcp/commit/936f6613d614f64c25b51e2a302ddc94faa5b6ad))
* **mcp:** add the dashboard API with its own Google sign-in ([#58](https://github.com/notcheu/jobwatch-mcp/issues/58)) ([37fe418](https://github.com/notcheu/jobwatch-mcp/commit/37fe4183f88f0d11fcc98d25bb12fabe31f5f1bd))
* **mcp:** add the MCP server, the jobwatch CLI and the call pipeline ([#5](https://github.com/notcheu/jobwatch-mcp/issues/5)) ([b09b96d](https://github.com/notcheu/jobwatch-mcp/commit/b09b96d5c186380045d0a7d4d69491adb188dc1d))
* **mcp:** open and close the dashboard on demand from the host ([#59](https://github.com/notcheu/jobwatch-mcp/issues/59)) ([4266c29](https://github.com/notcheu/jobwatch-mcp/commit/4266c29b277e58b4f591c0298513d59b054f16b3))
* pull initial plans ([c2ab620](https://github.com/notcheu/jobwatch-mcp/commit/c2ab6201bc957050a6f7fe8c3314d1b330846c1d))
* **sdk:** add the adapter contract package ([#3](https://github.com/notcheu/jobwatch-mcp/issues/3)) ([3cff99e](https://github.com/notcheu/jobwatch-mcp/commit/3cff99ed075d2e7287386c794c31352f81e65a7b))
* **sdk:** add wildcard hosts and a guarded openHttps mode for ATS boards on custom domains ([#27](https://github.com/notcheu/jobwatch-mcp/issues/27)) ([6ea7194](https://github.com/notcheu/jobwatch-mcp/commit/6ea71945ca50f35f5fa6100e50b3d67f17376e35))
* **sdk:** return a rule-based summary by default and make max_results the cap on what is shown ([#38](https://github.com/notcheu/jobwatch-mcp/issues/38)) ([3da847d](https://github.com/notcheu/jobwatch-mcp/commit/3da847db9e9d7b9a8af13c7be1da3c6aa490a7a9))


### Bug fixes

* **adapter-linkedin:** scroll the virtualized result list and wait for the lazy description ([#22](https://github.com/notcheu/jobwatch-mcp/issues/22)) ([343d88b](https://github.com/notcheu/jobwatch-mcp/commit/343d88b568f641db1da1d90d4e75b5f248d02b8c))
* **deploy:** run the router as uid 0 so it can write /data under rootless Docker ([#16](https://github.com/notcheu/jobwatch-mcp/issues/16)) ([d42e2c1](https://github.com/notcheu/jobwatch-mcp/commit/d42e2c15b1d1bd914a6a1de636a3da012d4fe048))
* **sdk:** export the ExcludedBy type that the LinkedIn adapter imports ([#34](https://github.com/notcheu/jobwatch-mcp/issues/34)) ([4531050](https://github.com/notcheu/jobwatch-mcp/commit/45310509777589b570b85e8a05eb6e5a83669efd))
* **sdk:** prefer a salary next to a salary word to an amount that only has the shape ([#67](https://github.com/notcheu/jobwatch-mcp/issues/67)) ([aa520f5](https://github.com/notcheu/jobwatch-mcp/commit/aa520f50456ecea5cd98ecb4d1b9538b66cd0547))
* **sdk:** read salary, years and remote days from job texts without false positives ([#65](https://github.com/notcheu/jobwatch-mcp/issues/65)) ([6ed2aba](https://github.com/notcheu/jobwatch-mcp/commit/6ed2ababb215a050ee5d7057ffd81b876ad6b293))


### Refactoring

* **adapters:** merge the list-only search tools into the search-and-read tools ([#45](https://github.com/notcheu/jobwatch-mcp/issues/45)) ([a20507e](https://github.com/notcheu/jobwatch-mcp/commit/a20507e9e22853e12a3f4a3d388838412b993c8f))
* **cli:** fold catalog into adapters list --tools ([#47](https://github.com/notcheu/jobwatch-mcp/issues/47)) ([c430e33](https://github.com/notcheu/jobwatch-mcp/commit/c430e33bbc4419ba92f89fd19180474d72f07e32))
* **cli:** rename the geo command to linkedin-geo ([#70](https://github.com/notcheu/jobwatch-mcp/issues/70)) ([82dd535](https://github.com/notcheu/jobwatch-mcp/commit/82dd5355b30284569de8ef0267fa56aaefbf9916))
* **cli:** split login into login start and login stop ([#44](https://github.com/notcheu/jobwatch-mcp/issues/44)) ([9f606c4](https://github.com/notcheu/jobwatch-mcp/commit/9f606c41fd3efdeb7abd5617a323a5a2607281a5))
* **core:** control multi-tab with JW_BROWSER_MAX_TABS alone ([#51](https://github.com/notcheu/jobwatch-mcp/issues/51)) ([845fd52](https://github.com/notcheu/jobwatch-mcp/commit/845fd52d7b73d614e7a6257dc09d0ffeee9fe727))
* make the generic adapters market, country and job agnostic ([#68](https://github.com/notcheu/jobwatch-mcp/issues/68)) ([40a2a03](https://github.com/notcheu/jobwatch-mcp/commit/40a2a0308be04acd40b5564ff5abc5f61c360f06))
* rename packages/adapters to mcp-modules, split adapter and utility maps, add new:utility ([fa5152d](https://github.com/notcheu/jobwatch-mcp/commit/fa5152db2d3db4c48d3f453b1df19768e87fcad2))
* **sdk:** share the card-visiting strategy between LinkedIn and the next platforms ([#33](https://github.com/notcheu/jobwatch-mcp/issues/33)) ([42d07fa](https://github.com/notcheu/jobwatch-mcp/commit/42d07fa1667e502ea408c9dd60fce5df3e496daf))
* **sdk:** share the company-board filters and judging between ATS adapters ([#29](https://github.com/notcheu/jobwatch-mcp/issues/29)) ([336e31c](https://github.com/notcheu/jobwatch-mcp/commit/336e31c7f3900bc582f39b72c3ba611b4fb34cd8))
* **sdk:** share the term matcher and job hints between adapters, raise the HTTP body cap to 8 MB ([#24](https://github.com/notcheu/jobwatch-mcp/issues/24)) ([0dfc792](https://github.com/notcheu/jobwatch-mcp/commit/0dfc7924aedaf021064e949ddc945a1705c559db))
* simplify the install and the configuration ([#75](https://github.com/notcheu/jobwatch-mcp/issues/75)) ([580aa35](https://github.com/notcheu/jobwatch-mcp/commit/580aa35ade8495a2f89eb95811e9982d40ada75c))
* split utilities from adapters under one module interface ([216525d](https://github.com/notcheu/jobwatch-mcp/commit/216525ddca71b701911fa574c8b73a94860f34f5))


### Documentation

* dedicated stack user is mcpuser; record its host-check results ([59c5d2f](https://github.com/notcheu/jobwatch-mcp/commit/59c5d2f9471fb5b115a0167523dc78a1683cce34))
* exactly one tab always; record no-hardware-upgrade / zram decision ([2b63e7d](https://github.com/notcheu/jobwatch-mcp/commit/2b63e7dfe14bed4f479d2cbd1d02fc1ac6f71cb1))
* finish renaming stack user to mcpuser ([f0216ee](https://github.com/notcheu/jobwatch-mcp/commit/f0216ee3662144e9be8b0740fd5b9bd256e6b05a))
* fold the owner's answers into the dashboard plan ([#54](https://github.com/notcheu/jobwatch-mcp/issues/54)) ([f6343b2](https://github.com/notcheu/jobwatch-mcp/commit/f6343b28b928b345c7206e1c2c1a8c3a2ce840d5))
* LinkedIn classic /jobs/search/ is primary; keep AI search-results as layout B ([ea7e115](https://github.com/notcheu/jobwatch-mcp/commit/ea7e1151115c5ecb4158df4e58d8e96f46cf7ba6))
* list the relevant ATS and plan one adapter per ATS taking a handle or a board URL ([#25](https://github.com/notcheu/jobwatch-mcp/issues/25)) ([b3d3852](https://github.com/notcheu/jobwatch-mcp/commit/b3d38528fac36f69bb95b7f5b3341beb61f3f4c5))
* move the numbered design docs to docs/plans ([#43](https://github.com/notcheu/jobwatch-mcp/issues/43)) ([eb79dc7](https://github.com/notcheu/jobwatch-mcp/commit/eb79dc731771bfc8eb69ff3c7fd600c3c441455b))
* plan the operator dashboard ([#53](https://github.com/notcheu/jobwatch-mcp/issues/53)) ([e5ad618](https://github.com/notcheu/jobwatch-mcp/commit/e5ad618a9fdf73c8b41664f1b0487598d7a4d9f0))
* point the repository references to the notcheu organization ([#79](https://github.com/notcheu/jobwatch-mcp/issues/79)) ([033c295](https://github.com/notcheu/jobwatch-mcp/commit/033c295cc71b56700addd12c40743d4394d83e8b))
* record what of the OAuth setup the dashboard can reuse ([#55](https://github.com/notcheu/jobwatch-mcp/issues/55)) ([7a7e646](https://github.com/notcheu/jobwatch-mcp/commit/7a7e646bf8ea76e65914b9bab24d8299f66d7769))
* remove the references to the maintainer's own setup ([#77](https://github.com/notcheu/jobwatch-mcp/issues/77)) ([8f600f4](https://github.com/notcheu/jobwatch-mcp/commit/8f600f495331d46967ff0d4c11fdee7d1fa5c702))
* rewrite the README as an install, run and usage guide ([#48](https://github.com/notcheu/jobwatch-mcp/issues/48)) ([ec1d6e8](https://github.com/notcheu/jobwatch-mcp/commit/ec1d6e8e5b7149bae203f0370a41d95e88f88a84))
* update the CLAUDE.md status after Phase 1 ([#15](https://github.com/notcheu/jobwatch-mcp/issues/15)) ([184088a](https://github.com/notcheu/jobwatch-mcp/commit/184088a10496e945760a7333f3c8920f3aefa4bd))
