// Phase 0 spike S6 (V6, G2, G5, part of V7): drive Chrome's DevTools from ANOTHER container, like the router will.
// Env: BROWSER_IP, BROWSER_NAME (container DNS name on the shared internal network). Prints one line per check.
import http from "node:http";
import { chromium } from "playwright-core";

const IP = process.env.BROWSER_IP, NAME = process.env.BROWSER_NAME;
const out = (ok, what, detail = "") => console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"}  ${what}${detail ? "  -> " + detail : ""}`);

function get(host, port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, headers, timeout: 5000 }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b.trim() }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.end();
  });
}
function wsHandshake(host, port, path, origin) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, timeout: 5000, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": Buffer.from("jobwatch-spike-s6").toString("base64"), ...(origin ? { Origin: origin } : {}) } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", (e) => resolve(e.code ?? e.message));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.end();
  });
}

// Wait until DevTools answers on the IP (up to 40 s).
let a; for (let i = 0; i < 80; i++) { a = await get(IP, 9222, "/json/version"); if (a.status === 200) break; await new Promise((r) => setTimeout(r, 500)); }
out(a.status === 200, "A. GET http://<container IP>:9222/json/version", `${a.status} ${a.error ?? ""}`);
if (a.status !== 200) process.exit(1);
const version = JSON.parse(a.body);
out(null, "Chrome version / UA", `${version.Browser} | ${version["User-Agent"]}`);
out(null, "webSocketDebuggerUrl host as advertised", String(version.webSocketDebuggerUrl).replace(/\/browser\/.*/, "/browser/…"));

const b = await get(NAME, 9222, "/json/version");
out(null, "B. GET by DNS name (Host header = container name)", `${b.status} ${(b.body || b.error || "").slice(0, 100)}   (G2: expected non-200, Chrome rejects non-IP Host)`);
const c = await get(NAME, 9222, "/json/version", { Host: "localhost" });
out(c.status === 200, "C. by DNS name with Host: localhost", `${c.status}`);
const d = await get(IP, 9223, "/json/version");
out(d.status === 0, "D. direct to Chrome's own port 9223 from another container (must be refused: loopback only)", `${d.status} ${d.error ?? ""}`);

const wsPath = new URL(version.webSocketDebuggerUrl).pathname;
out(null, "E1. WebSocket handshake, no Origin", String(await wsHandshake(IP, 9222, wsPath)));
out(null, "E2. WebSocket handshake, Origin: http://evil.example (101 = --remote-allow-origins=* lets any origin in)", String(await wsHandshake(IP, 9222, wsPath, "http://evil.example")));

// F. The real router path: Playwright connectOverCDP by IP.
let browser;
try {
  browser = await chromium.connectOverCDP(`http://${IP}:9222`, { timeout: 15000 });
  out(true, "F1. chromium.connectOverCDP(http://<IP>:9222)", `contexts=${browser.contexts().length} pages=${browser.contexts()[0]?.pages().length}`);
  const ctx = browser.contexts()[0];
  const before = ctx.pages().length;
  const page = await ctx.newPage();
  await page.goto("data:text/html,<title>s6</title><p>ok</p>");
  const sig = await page.evaluate(() => ({
    webdriver: navigator.webdriver, ua: navigator.userAgent, languages: navigator.languages, plugins: navigator.plugins.length,
    chromeObj: typeof window.chrome, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: `${screen.width}x${screen.height}`,
    globals: Object.keys(window).filter((k) => /playwright|^__pw|__playwright/i.test(k)),
  }));
  out(null, "F2. fingerprint signals over connectOverCDP (V7 input)", JSON.stringify(sig));
  out(sig.webdriver !== true && !/HeadlessChrome/.test(sig.ua) && sig.globals.length === 0, "F3. webdriver not true, no HeadlessChrome, no __playwright globals");
  await page.close();
  out(ctx.pages().length === before, "F4. working tab closed, original tab kept", `pages ${before} -> ${ctx.pages().length}`);
} catch (e) { out(false, "F. connectOverCDP by IP", String(e.message).split("\n")[0]); }

// G. Same by DNS name: expected to fail because of the Host check (G2).
try {
  const b2 = await chromium.connectOverCDP(`http://${NAME}:9222`, { timeout: 8000 });
  out(null, "G. connectOverCDP by DNS name", "connected (Host check did not block)"); await b2.close().catch(() => {});
} catch (e) { out(null, "G. connectOverCDP by DNS name", "failed as G2 predicts: " + String(e.message).split("\n")[0]); }

// H. Graceful quit through DevTools (G5): the container's entrypoint exits when Chrome exits.
try {
  const s = await browser.newBrowserCDPSession();
  const closed = new Promise((res) => browser.once("disconnected", res));
  await s.send("Browser.close").catch(() => {});
  await Promise.race([closed, new Promise((r) => setTimeout(r, 10000))]);
  out(true, "H. Browser.close sent over CDP; the script will now check the container stopped");
} catch (e) { out(false, "H. Browser.close", String(e.message).split("\n")[0]); }
