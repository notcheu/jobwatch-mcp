// Phase 0 spike S9: which watch-list companies expose a public ATS job board (plain HTTP, no browser)?
// Read-only, sequential, ~200 ms between requests. Output: JSON on stdout, summary on stderr.
const UA = "jobwatch-mcp-spike/0.0 (personal read-only job search; contact: matthieu.nogueron@gmail.com)";
const COMPANIES = ["pigment","nabla","doctolib","bsport-1","ornikar","modjo","sorare","contentsquare","alan","payfit","swile","back-market","manomano","aircall","mirakl","algolia","criteo","spendesk","malt","leboncoin","brevo","pennylane","blablacar","ledger"];
const TITLE_RE = /front|react|design system|typescript|staff|platform|lead/i;

const providers = {
  greenhouse: { url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`, jobs: (j) => j.jobs, title: (x) => x.title },
  lever: { url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`, jobs: (j) => (Array.isArray(j) ? j : null), title: (x) => x.text },
  ashby: { url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`, jobs: (j) => j.jobs, title: (x) => x.title },
  smartrecruiters: { url: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`, jobs: (j) => (j.totalFound > 0 ? j.content : null), title: (x) => x.name },
  workable: { url: (t) => `https://apply.workable.com/api/v1/widget/accounts/${t}`, jobs: (j) => j.jobs, title: (x) => x.title },
  recruitee: { url: (t) => `https://${t}.recruitee.com/api/offers/`, jobs: (j) => j.offers, title: (x) => x.title },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const variants = (slug) => [...new Set([slug, slug.replace(/-\d+$/, ""), slug.replace(/-/g, ""), slug.charAt(0).toUpperCase() + slug.slice(1)])];

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10000), redirect: "manual" });
    if (!res.ok) return { status: res.status };
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status }; }
  } catch (e) { return { status: 0, error: String(e.cause?.code ?? e.message) }; }
}

const out = {};
for (const slug of COMPANIES) {
  const hits = [];
  for (const [name, p] of Object.entries(providers)) {
    for (const token of variants(slug)) {
      const r = await get(p.url(token));
      await sleep(200);
      if (r.json) {
        const jobs = p.jobs(r.json);
        if (Array.isArray(jobs)) {
          hits.push({ provider: name, token, total: jobs.length, frontendLike: jobs.filter((x) => TITLE_RE.test(p.title(x) ?? "")).length, sample: jobs.slice(0, 2).map((x) => p.title(x)) });
          break;
        }
      }
    }
  }
  out[slug] = hits;
  console.error(`${slug.padEnd(14)} ${hits.length ? hits.map((h) => `${h.provider}:${h.token} (${h.total} jobs, ${h.frontendLike} frontend-like)`).join("; ") : "-"}`);
}
console.log(JSON.stringify(out, null, 2));
