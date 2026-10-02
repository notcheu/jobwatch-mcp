## Description

<!--
One constructed sentence that starts with "This PR" followed by a verb (adds, implements, fixes, drops, replaces, ...)
and summarizes the main updates. Example: "This PR implements a new adapter for WTTJ which extends the browser tool."
Then add any specific direction taken while working on it: the decision and why. Example: "WTTJ relies on Algolia
Search, so some tools use the API directly while others rely on the browser."
Not a list of files. Title: semantic, "<type>(<optional scope>): <summary>" with type feat, fix, chore, docs, refactor, test, ci, build, perf, wip.
-->

## Verification

- [ ] `npm run ci` passes (format, lint including the architecture rules, typecheck, tests)
- Also run: <!-- e.g. real run on the reference host, manual test in Claude. Or "nothing beyond CI". -->
- Not tested: <!-- say plainly what this PR does not prove -->

## Project rules

<!-- Delete the lines that do not apply. -->

- [ ] No secrets, cookies, browser profiles, HAR files or logged-in HTML
- [ ] Still read-only: no tool writes to a third-party platform, nothing exposed beyond the catalog
- [ ] Docs updated in the same PR when behaviour or a decision changed (numbered doc, diagram, `VERIFY` tags)
- [ ] Catalog snapshots regenerated if a tool definition changed
- [ ] RAM impact considered if the browser runtime or its budgets changed

## Accepted risks and follow-ups

<!-- Known gaps, deferred work, risks consciously accepted (by whom, when). "None" if none. -->
