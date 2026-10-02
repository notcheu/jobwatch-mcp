# 05 — Browser runtime (the shared image) and how it is driven

> **Related docs:** Load for the Chrome image, CDP and login mode. Also load: `06` (limits, watchdog, state machine), `09` (container hardening), `10` (host and Docker setup), `07` (fingerprint and LinkedIn needs), `15` (sources). Follow a link only if the task needs it.

One image, used by every browser-backed platform. It contains **no adapter code**: it is Chrome + a virtual display + a few helper processes. Behaviour differs only by environment variables and the mounted profile volume.

## Image contents
- Base: Debian 12 (bookworm-slim) or an Ubuntu LTS minimal image (NOT the snap `chromium` package).
- **Multi-architecture (decided 2026-10-01: the images may run on something other than the reference Ubuntu host, e.g. an arm64 Mac).** amd64: `google-chrome-stable` from Google's apt repository (confirmed on the reference host). arm64: **Google publishes no Linux arm64 Chrome**, so the arm64 variant uses Debian `chromium` (see the build arg below). Chromium reports a different brand list (`navigator.userAgentData`) and may differ in other signals, so **treat the arm64 image as development only, not for the LinkedIn session**; the logged-in profile belongs on the amd64 reference host. (Emulating amd64 Chrome on Apple Silicon works through Docker Desktop but is slow and crash-prone; not a supported path.) **Verified 2026-10-01 on an arm64 Mac:** the arm64 image builds natively and Chromium 154 starts with its sandbox on under the custom seccomp profile; DevTools answers. Original note: (VERIFY availability for the host CPU architecture with `uname -m`; fallback: Debian `chromium`).
- `xvfb` (virtual display), `fonts-liberation` + a CJK/emoji font if needed, `tini` (PID 1 / zombie reaping), `socat` (DevTools port forward, see G2), `ca-certificates`, `tzdata`.
- Login mode helpers: `x11vnc`, `novnc`/`websockify` (only started when `MODE=login`).
- Non-root user `chrome` (uid 1000), home `/home/chrome`, profile mount `/profile`.
- No adapters, no Playwright, no Node/npm.

## Dockerfile sketch (browser image)
```dockerfile
FROM debian:bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH   # set by BuildKit: amd64 -> Google Chrome stable, arm64 -> Debian Chromium (development only)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb socat tzdata fonts-liberation procps x11vnc novnc websockify jq \
 && if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
      && ln -s /usr/bin/google-chrome-stable /usr/local/bin/chrome-bin; \
    else \
      apt-get install -y --no-install-recommends chromium && ln -s /usr/bin/chromium /usr/local/bin/chrome-bin; \
    fi \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 chrome && mkdir /profile && chown chrome:chrome /profile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER chrome
ENV DISPLAY=:99 TZ=Europe/Paris MODE=run SCREEN=1366x800x24
# tini is not needed in the image: the runtime starts the container with --init.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```
Pin the Chrome major version per image tag (`jobwatch-browser:<chrome-major>-<n>`) and rebuild deliberately: site behaviour and fingerprints depend on it. Keep the image small: `--no-install-recommends`, no dev tools, one layer for apt.

## entrypoint.sh (behaviour)
1. `mkdir -p /tmp/.X11-unix && chmod 1777` it (non-root Xvfb cannot create it on a fresh tmpfs), then start `Xvfb :99 -screen 0 $SCREEN -nolisten tcp &`; wait until the display answers.
2. Remove stale `/profile/SingletonLock`, `SingletonCookie`, `SingletonSocket` (left by a killed Chrome).
3. If `MODE=login`: start `x11vnc -display :99 -localhost -forever -passwd "$VNC_PASSWORD"` (a password is mandatory; the container port is published only on the host's `127.0.0.1` and reached through an SSH tunnel) and `websockify --web /usr/share/novnc 6080 localhost:5900` (published only on the host's loopback / private overlay, see `10-deployment.md`).
4. Start Chrome (flags below) with `--user-data-dir=/profile`, DevTools on `127.0.0.1:9223`.
5. Start `socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223` so the router can reach DevTools from another container (G2).
6. Trap SIGTERM: ask Chrome to quit gracefully (kill -TERM chrome, wait up to 8 s), then exit. The router normally quits Chrome itself through DevTools first.

## Chrome flags (starting point)
```
--user-data-dir=/profile                    # MUST be non-default (see G1)
--remote-debugging-port=9223
--remote-allow-origins=*                    # only reachable on the private container network
--no-first-run --no-default-browser-check --disable-session-crashed-bubble
--disable-gpu --disable-dev-shm-usage       # /dev/shm sized explicitly by the runtime (--shm-size)
--disable-background-networking --disable-extensions --disable-sync --mute-audio
--js-flags=--max-old-space-size=512
--renderer-process-limit=2
--window-size=1366,800 --window-position=0,0
--lang=<ACCOUNT_UI_LANG>                     # keep consistent with the LinkedIn UI language (see 07)
--restore-last-session                       # keep session cookies across restarts (G4)
--password-store=basic                       # no keyring in a container
```
Do NOT use `--single-process` (unstable), `--headless`, `--enable-automation`, or `--disable-web-security`. `--no-sandbox` only if the sandbox cannot start under the chosen seccomp/userns setup (see `09-security.md` for the trade-off). Block `media`/`font` requests at the CDP level only after measuring; blocking images makes the session look unlike a normal user (see `06-…`).

## Gotchas (each one needs a Phase 0/1 check)
- **G1 — Non-default profile dir.** Recent Chrome versions ignore `--remote-debugging-port` when launched with the default user-data directory. We always pass `--user-data-dir=/profile`. VERIFY on the pinned Chrome major.
- **G2 — DevTools reachability. CONFIRMED (spike S6, Chrome 154, rootless Docker, 2026-10-01):** from another container on an internal network, `GET http://<container IP>:9222/json/version` returns 200, while the same request by container DNS name returns **500 "Host header is specified and is not an IP address or localhost"** (so does Playwright `connectOverCDP` by name). Sending `Host: localhost` with the DNS name works. Chrome's own port 9223 is refused from other containers (loopback only), so the `socat` forward is required. The advertised `webSocketDebuggerUrl` already uses the container IP. The WebSocket handshake succeeds even with `Origin: http://evil.example` because of `--remote-allow-origins=*`: anything that can reach port 9222 controls the browser, so the internal network (and never publishing the port) is the only protection. The router must connect by IP (looked up with `docker inspect`). Original notes: Chrome may bind DevTools to 127.0.0.1 only and ignore `--remote-debugging-address`. Hence the `socat` forward. Also the DevTools HTTP endpoint rejects requests whose `Host` header is not `localhost` or an IP address: connect to the container's **IP**, not its DNS name (or add a fixed `Host` header). Keep `--remote-allow-origins=*` for the WebSocket handshake. VERIFY.
- **G3 — Automation signals.** Connecting with Playwright over CDP can leave traces (Playwright globals, CDP side effects). Keep Playwright usage minimal (`connectOverCDP`, reuse the single existing page, `page.goto`, `page.evaluate`). The startup fingerprint self-check (below) must pass. Fallbacks: Patchright, or a tiny raw-CDP client.
- **G4 — Session cookies vs restarts.** When Chrome quits, cookies without an expiry are dropped unless session restore is on ("Continue where you left off"); Chromium persists session cookies on restart only in that mode (source in `15-sources.md`). Use `--restore-last-session` and/or set `session.restore_on_startup=1` in the profile's `Preferences`. VERIFY: log in, stop the runtime gracefully twice, start again: still logged in. If not, keep one long-lived Chrome per platform with longer TTL instead. **Observed (WTTJ, 2026-10-02):** the login was lost repeatedly; its sign-in cookies (`wttj_api_session_key`, `csrf-token`) have no expiry. Fix: an adapter may set `keepSessionCookies`; at the end of each call the engine re-sets the no-expiry cookies of its `allowedHosts` with a 30 day expiry (`BrowserConnection.keepSessionCookies`, in `core/src/browser/session.ts`), before the tab is parked. Cookie values are never logged. VERIFY on the reference host: after a loss, if the cookies are still present the server expired the session instead and this does not help.
- **G5 — Graceful quit. CONFIRMED (spike S6):** `Browser.close` sent through `browser.newBrowserCDPSession()` makes Chrome exit and the container stop with exit code 0 (entrypoint waits on Chrome). The SIGTERM/SIGKILL steps remain the fallback. Original notes: Quit through the DevTools command `Browser.close` (flushes the cookie DB), then SIGTERM after ~10 s, SIGKILL after ~20 s. A SIGKILL can lose recent cookie writes and leaves lock files (cleaned at next start).
- **G6 — Sandbox in containers. DECIDED (spike S7, 2026-10-01): keep Chrome's sandbox ON.** Under `--cap-drop ALL` + `no-new-privileges` + default Docker seccomp the sandbox fails (namespace creation, then `chroot`, are denied). With a custom seccomp profile = Docker's default plus `unshare`, `setns`, `clone`, `chroot` (`spikes/chrome/chrome-seccomp.json`, to be copied to `images/browser/chrome-seccomp.json` and pinned), Chrome starts with its sandbox and all other hardening unchanged, in rootless Docker on Ubuntu 24.04 (AppArmor userns restriction did not interfere). Never use `seccomp=unconfined` outside diagnostics. Trade-off: the container may create user namespaces, which slightly widens kernel attack surface; `--no-sandbox` remains the documented fallback only if a future Chrome/kernel update breaks the profile. Re-verify after each Chrome major bump.
- **G7 — Display size / window.** Use a realistic viewport (1366×800 or the Mac's real size). Do not use tiny or odd sizes.
- **G8 — Language/timezone/UA consistency.** `--lang` only sets the UI locale; `navigator.languages` comes from the profile preference `intl.accept_languages`, which the entrypoint seeds from the `ACCEPT_LANGS` env var (list copied from the everyday Chrome, kept out of git: local `.env.local` in the spikes, a secret-free deploy env file later). Spike S4 showed the default `["en-US","en"]` does not match a real user's list. **Confirmed (S4):** seeding both `intl.accept_languages` and `intl.selected_languages` makes `navigator.languages` equal the configured list (seeding only `accept_languages` did not). Copy the real values from the owner's everyday Chrome (`navigator.languages`, timezone, UA major version, screen size) into the image env so the profile looks consistent. Do not spoof the UA string manually unless the self-check shows a mismatch.

## How the router drives it
```ts
import { chromium } from "playwright-core";

// containerIp from `docker inspect` (connect by IP, never by name: G2). Verified in spike S6 (playwright-core 1.63.0, Chrome 154).
const browser = await chromium.connectOverCDP(`http://${containerIp}:9222`);
const ctx = browser.contexts()[0];             // the profile's default context (persistent profile)
const page = ctx.pages()[0];                   // the primary tab; extra tabs only through session.openTab(), up to JW_BROWSER_MAX_TABS
await page.route("**/*", allowlistRouter);     // abort requests to non-allowlisted hosts
// ...                                         // adapter: goto + evaluate
await page.goto("about:blank");                // always; park the tab, never close it (frees renderer memory)
// runtime stop:
const cdp = await browser.newBrowserCDPSession(); await cdp.send("Browser.close");
```
Rules: never call `browser.close()` expecting it to quit Chrome; one primary tab (see `06-…` Tab policy and Multi-tab): never `newPage` except through the guarded `session.openTab()`, up to `JW_BROWSER_MAX_TABS`, never close the primary tab; the watchdog closes any stray page (popups, `target=_blank`) and, at the end of a call, every tab but the primary. Navigation only to URLs built by the adapter from validated arguments (host allowlist from the catalog).

## Navigation policy and fingerprint implementation (step 6, decided 2026-10-01)
The adapter's `allowedHosts` are enforced on `BrowserSession.goto` and again on every document or frame navigation the page makes by itself; sub-resources are not filtered (see `03-router-spec.md`, step 6). The startup self-check is implemented in `packages/core/src/browser/fingerprint.ts` and is `enforce` by default (`JW_FINGERPRINT`).

## Startup fingerprint self-check (`packages/core/src/browser/fingerprint.ts`)
After a runtime becomes ready, on `about:blank` evaluate and compare to a baseline JSON captured from the real Mac Chrome:
`navigator.webdriver` (must be false/undefined), `navigator.userAgent` (no `HeadlessChrome`), `navigator.languages`, `navigator.plugins.length`, `window.chrome` present, `Notification.permission`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, screen size, presence of `__playwright*`/`__pw*` globals (must be absent). On failure: log `fingerprint_mismatch` with the diff, return `adapter_broken`-like warning, and refuse LinkedIn calls until fixed (configurable).

## Login procedure (MODE=login)
1. `docker compose exec router jobwatch login start linkedin` starts a `jw-login-linkedin` container in `login` mode on the platform profile, with a random 8-character VNC password (x11vnc reads only 8), on Docker's default `bridge` network (an internal network cannot publish ports and the person signing in needs the internet), noVNC published on the host's `127.0.0.1:6080` only (`--port` changes it), label `jobwatch.login` so the orphan reaper leaves it alone. It refuses while the router's own browser is running on the same profile. It prints the SSH-tunnel command, the URL and the password.
2. From the laptop: `ssh -L 6080:localhost:6080 <home-host>`, open `http://localhost:6080/vnc.html`, log in to LinkedIn manually (handle captcha/phone confirmation), browse once to a jobs page.
3. `jobwatch login stop linkedin` stops it gracefully; the router runs `session_status` in `run` mode to confirm.
The login viewer is never exposed publicly and never started by a tool call.

## Image and profile maintenance
- Rebuild monthly or on Chrome security releases; keep the previous tag for rollback.
- Profiles are sensitive (cookies): mode 0700, excluded from git, backups encrypted or skipped.
- After a Chrome major upgrade run the fingerprint check and `session_status` before trusting runs.
