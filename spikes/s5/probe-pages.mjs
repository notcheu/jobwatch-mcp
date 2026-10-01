// Phase 0 spike S5 (V8, V14, part of V4): 5 read-only navigations (no clicks) through the logged-in profile:
//   1 /jobs/ (candidate light page for session_status)  2 one search-results page  3-4 two /jobs/view/<id>  5 search-results?currentJobId=<id> (split view)
// Prints counts, booleans, URL paths and ONLY the first lines of 3 public job cards (title/company/location). No descriptions, no HTML, no cookies.
// Stops immediately if LinkedIn shows a login or checkpoint page.
import http from "node:http";
import { chromium } from "playwright-core";

const IP = process.env.BROWSER_IP;
const SEARCH = "https://www.linkedin.com/jobs/search-results/?keywords=Staff%20Frontend%20Engineer%20OR%20Lead%20Frontend%20OR%20Frontend%20Tech%20Lead&geoId=104246759&distance=0.0&f_TPR=r86400";
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = () => sleep(6000 + Math.floor(Math.random() * 5000)); // human-like gap between page loads

const ready = () => new Promise((res) => http.get({ host: IP, port: 9222, path: "/json/version" }, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)));
for (let i = 0; i < 80 && !(await ready()); i++) await sleep(500);
const browser = await chromium.connectOverCDP(`http://${IP}:9222`, { timeout: 15000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

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
    legacyDesc: len(".jobs-description__content"),
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
  await page.waitForSelector("[componentKey=SearchResultsMainContent]", { timeout: 15000 }).catch(() => {});
  await sleep(2000);
  const r = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[componentKey^="job-card-component-ref-"]')];
    const seen = new Set(), cards = [];
    for (const e of els) { const id = e.getAttribute("componentKey").split("-").pop(); if (!seen.has(id)) { seen.add(id); cards.push({ id, lines: e.innerText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3) }); } }
    return { container: !!document.querySelector("[componentKey=SearchResultsMainContent]"), cardCount: cards.length, ids: cards.map((c) => c.id).slice(0, 5), sample: cards.slice(0, 3),
      detailPane: !!document.querySelector("[componentKey^=JobDetails_AboutTheJob_]"),
      noResultsText: /No matching jobs|Aucun/i.test(document.body.innerText.slice(0, 3000)) };
  });
  ids = r.ids;
  out("  search", r);
  out("  detail pane on the search page itself", await detailProbe());
});
if (!aborted && WANT.includes("view_1") && ids.length < 2) { out("!!! only " + ids.length + " card ids found; cannot run detail stages", "adapter_broken-like (V8)"); aborted = true; }
await stage("view_1", `https://www.linkedin.com/jobs/view/${ids[0]}`, async () => { await page.waitForSelector("h1, [componentKey^=JobDetails_AboutTheJob_]", { timeout: 12000 }).catch(() => {}); out("  detail", await detailProbe()); });
await stage("view_2", `https://www.linkedin.com/jobs/view/${ids[1]}`, async () => { await page.waitForSelector("h1, [componentKey^=JobDetails_AboutTheJob_]", { timeout: 12000 }).catch(() => {}); out("  detail", await detailProbe()); });
await stage("split_view_1", `${SEARCH}&currentJobId=${ids[0]}`, async () => { await page.waitForSelector("[componentKey^=JobDetails_AboutTheJob_]", { timeout: 15000 }).catch(() => {}); out("  detail", await detailProbe()); });

await page.close().catch(() => {});
const s = await browser.newBrowserCDPSession();
await s.send("Browser.close").catch(() => {});
await sleep(3000);
process.exit(aborted ? 2 : 0);
