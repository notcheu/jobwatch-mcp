// Phase 0 spike S5 (V8, V14, part of V4): 5 read-only navigations (no clicks) through the logged-in profile:
//   1 /jobs/ (candidate light page for session_status)  2 one search-results page  3-4 two /jobs/view/<id>  5 search-results?currentJobId=<id> (split view)
// Prints counts, booleans, URL paths and ONLY the first lines of 3 public job cards (title/company/location). No descriptions, no HTML, no cookies.
// Stops immediately if LinkedIn shows a login or checkpoint page.
import http from "node:http";
import { chromium } from "playwright-core";

const IP = process.env.BROWSER_IP;
// Default: the routine's /jobs/search-results/ URL (Wednesday-sweep form, no time filter, so results exist). On 2026-10-01 it answered "No results found" twice
// (container and Matthieu's Chrome); override with SEARCH_URL (e.g. the classic /jobs/search/?keywords=…&geoId=…&distance=0) to compare. Both layouts are detected.
const SEARCH = process.env.SEARCH_URL ?? "https://www.linkedin.com/jobs/search-results/?keywords=Staff%20Frontend%20Engineer%20OR%20Lead%20Frontend%20OR%20Frontend%20Tech%20Lead&geoId=104246759&distance=0.0";
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = () => sleep(6000 + Math.floor(Math.random() * 5000)); // human-like gap between page loads

const ready = () => new Promise((res) => http.get({ host: IP, port: 9222, path: "/json/version" }, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)));
for (let i = 0; i < 80 && !(await ready()); i++) await sleep(500);
const browser = await chromium.connectOverCDP(`http://${IP}:9222`, { timeout: 15000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
// Optional experiment (BLOCK=image,media,font): abort heavy resource types. Changes the page-load profile; measure, do not assume.
const BLOCK = (process.env.BLOCK ?? "").split(",").filter(Boolean);
if (BLOCK.length) { await page.route("**/*", (r) => (BLOCK.includes(r.request().resourceType()) ? r.abort() : r.continue())); out("blocking resource types", BLOCK); }

const classify = async () => {
  const path = new URL(page.url()).pathname;
  const loginForm = await page.evaluate(() => !!document.querySelector('input[name="session_key"], #username')).catch(() => false);
  if (/^\/(checkpoint|uas\/consumer-email-challenge)/.test(path)) return { path, state: "checkpoint" };
  if (/^\/(login|authwall|uas\/login|signup)/.test(path) || loginForm) return { path, state: "needs_login" };
  return { path, state: "ok" };
};
const WANT = (process.env.STAGES ?? "jobs_home,search,view_1,view_2,split_view_1").split(",");
let aborted = false;
async function stage(name, url, fn) {
  if (aborted || !WANT.includes(name)) return;
  console.log(`@@STAGE ${name} ${Date.now()}`);
  const t0 = Date.now(); let err = null;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => { err = String(e.message).split("\n")[0]; });
  await sleep(5000);
  const c = await classify();
  out(`[${name}]`, { ...c, gotoMs: Date.now() - t0, error: err, hadCurrentJobId: page.url().includes("currentJobId") });
  if (c.state !== "ok") { aborted = true; out("!!! STOPPING", `LinkedIn showed ${c.state} at ${c.path}. Do not retry; wait 24 h if this was a checkpoint.`); }
  else if (fn) { try { await fn(); } catch (e) { out(`[${name}] probe error`, String(e.message).split("\n")[0]); } }
  console.log(`@@END ${name} ${Date.now()}`);
  await pace();
}

const detailProbe = () => page.evaluate(() => {
  const len = (sel) => { const e = document.querySelector(sel); return e ? (e.textContent || "").trim().length : null; };
  return {
    splitDesc: len("[componentKey^=JobDetails_AboutTheJob_] [data-testid=expandable-text-box]"),
    legacyDesc: len(".jobs-description__content"), descText: len(".jobs-description-content__text"), boxHtml: len(".jobs-box__html-content"), jobDetailsId: len("#job-details"),
    aboutHeading: !![...document.querySelectorAll("h2")].find((h) => /about the job/i.test(h.textContent || "")),
    detailWrapper: !!document.querySelector(".jobs-search__job-details--wrapper, .jobs-details"), unifiedTopCard: !!document.querySelector("[class*=job-details-jobs-unified-top-card]"),
    publicDesc: len(".show-more-less-html__markup"),
    anyAboutBox: !!document.querySelector("[componentKey^=JobDetails_AboutTheJob_]"),
    h1: !!document.querySelector("h1"), applyButtonsPresent: !!document.querySelector("[componentKey*=Apply], button[aria-label*=Apply]"),
    promotedMarker: /Promoted|Sponsoris/i.test(document.body.innerText.slice(0, 4000)),
  };
});

let ids = [];
await stage("jobs_home", "https://www.linkedin.com/jobs/", async () => {
  out("  markers", await page.evaluate(() => ({ nav: !!document.querySelector("nav, header"), htmlLang: document.documentElement.lang, title: document.title.replace(/\d+/g, "#").slice(0, 40) })));
});
await stage("search", SEARCH, async () => {
  await page.waitForSelector("li[data-occludable-job-id], [componentKey^=job-card-component-ref-]", { timeout: 15000 }).catch(() => {});
  const collect = () => page.evaluate(() => {
    const seen = new Map();
    for (const e of document.querySelectorAll("li[data-occludable-job-id]")) { const id = e.getAttribute("data-occludable-job-id"); if (id && !seen.has(id)) seen.set(id, e.innerText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3)); }
    for (const e of document.querySelectorAll('[componentKey^="job-card-component-ref-"]')) { const id = e.getAttribute("componentKey").split("-").pop(); if (!seen.has(id)) seen.set(id, e.innerText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3)); }
    return { ids: [...seen.keys()], sample: [...seen.entries()].slice(0, 3).map(([id, lines]) => ({ id, lines })),
      legacy: document.querySelectorAll("li[data-occludable-job-id]").length, newLayout: document.querySelectorAll("[componentKey^=job-card-component-ref-]").length,
      container: { newMain: !!document.querySelector("[componentKey=SearchResultsMainContent]"), scaffoldList: !!document.querySelector(".scaffold-layout__list") },
      viewAnchors: document.querySelectorAll('a[href*="/jobs/view/"]').length, pagination: !!document.querySelector(".jobs-search-pagination"),
      noResults: /no results found/i.test(document.body.innerText.slice(0, 3000)) };
  });
  const first = await collect();
  out("  search before scrolling", { cards: first.ids.length, legacy: first.legacy, newLayout: first.newLayout, container: first.container, viewAnchors: first.viewAnchors, pagination: first.pagination, noResults: first.noResults });
  out("  first 3 cards (public job info)", first.sample);
  // Gentle, human-like scrolling of the results list (lazy loading), 3 steps.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { const el = document.querySelector(".scaffold-layout__list") ?? document.scrollingElement; (el.scrollBy ? el : window).scrollBy(0, 900); });
    await sleep(1800);
  }
  const after = await collect();
  ids = after.ids;
  out("  search after 3 scroll steps", { cards: after.ids.length });
  out("  detail pane on the search page itself", await detailProbe());
});
if (!aborted && WANT.includes("view_1") && ids.length < 2) { out("!!! only " + ids.length + " card ids found; cannot run detail stages", "adapter_broken-like (V8)"); aborted = true; }
await stage("view_1", `https://www.linkedin.com/jobs/view/${ids[0]}`, async () => { await page.waitForSelector("h1, #job-details, .jobs-description__content, [componentKey^=JobDetails_AboutTheJob_]", { timeout: 12000 }).catch(() => {}); out("  detail", await detailProbe()); });
await stage("view_2", `https://www.linkedin.com/jobs/view/${ids[1]}`, async () => { await page.waitForSelector("h1, #job-details, .jobs-description__content, [componentKey^=JobDetails_AboutTheJob_]", { timeout: 12000 }).catch(() => {}); out("  detail", await detailProbe()); });
await stage("split_view_1", `${SEARCH}&currentJobId=${ids[0]}`, async () => { await page.waitForSelector("#job-details, .jobs-description__content, [componentKey^=JobDetails_AboutTheJob_]", { timeout: 15000 }).catch(() => {}); out("  detail", await detailProbe()); });

await page.close().catch(() => {});
const s = await browser.newBrowserCDPSession();
await s.send("Browser.close").catch(() => {});
await sleep(3000);
process.exit(aborted ? 2 : 0);
