// Phase 0 spike S4 (V5, V7, V14): ONE read-only load of https://www.linkedin.com/feed/ through the logged-in profile.
// Prints only booleans, the URL path (no query), and cookie name/expiry facts. Never prints cookie values, page text or HTML.
import http from "node:http";
import { chromium } from "playwright-core";

const IP = process.env.BROWSER_IP;
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const ready = () => new Promise((res) => http.get({ host: IP, port: 9222, path: "/json/version" }, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)));
for (let i = 0; i < 80 && !(await ready()); i++) await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.connectOverCDP(`http://${IP}:9222`, { timeout: 15000 });
const ctx = browser.contexts()[0];
const before = (await ctx.cookies("https://www.linkedin.com")).filter((c) => c.name === "li_at");
out("li_at before load", { present: before.length > 0, sessionCookie: before[0] ? before[0].expires === -1 : null });

const page = await ctx.newPage();
const t0 = Date.now();
let gotoError = null;
await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => { gotoError = String(e.message).split("\n")[0]; });
await page.waitForTimeout(4000);
const path = new URL(page.url()).pathname;
const marks = await page.evaluate(() => ({
  loginForm: !!document.querySelector('input[name="session_key"], #username'),
  nav: !!document.querySelector("nav, header"),
  jobsLink: !!document.querySelector('a[href*="/jobs/"]'),
  networkLink: !!document.querySelector('a[href*="/mynetwork/"]'),
  htmlLang: document.documentElement.lang,
  title: document.title.replace(/\d+/g, "#").slice(0, 40),
  webdriver: navigator.webdriver, languages: navigator.languages, plugins: navigator.plugins.length,
  ua: navigator.userAgent, chromeObj: typeof window.chrome,
  globals: Object.keys(window).filter((k) => /playwright|^__pw|__playwright/i.test(k)),
}));
let state = "unknown";
if (/^\/(checkpoint|uas\/consumer-email-challenge)/.test(path)) state = "checkpoint";
else if (/^\/(login|authwall|uas\/login|signup)/.test(path) || marks.loginForm) state = "needs_login";
else if (path.startsWith("/feed") && marks.nav) state = "ok";
out("STATE", state);
out("final path", path);
out("goto", { ms: Date.now() - t0, error: gotoError });
out("markers", { loginForm: marks.loginForm, nav: marks.nav, jobsLink: marks.jobsLink, networkLink: marks.networkLink, htmlLang: marks.htmlLang, title: marks.title });
out("fingerprint", { webdriver: marks.webdriver, languages: marks.languages, plugins: marks.plugins, chromeObj: marks.chromeObj, headless: /HeadlessChrome/.test(marks.ua), playwrightGlobals: marks.globals });
const after = (await ctx.cookies("https://www.linkedin.com")).filter((c) => ["li_at", "JSESSIONID", "bcookie", "lidc", "li_rm"].includes(c.name));
out("cookies after load (names only)", after.map((c) => ({ name: c.name, session: c.expires === -1 })));
await page.close();

const s = await browser.newBrowserCDPSession();
await s.send("Browser.close").catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
process.exit(state === "ok" ? 0 : 2);
