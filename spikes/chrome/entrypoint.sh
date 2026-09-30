#!/usr/bin/env bash
set -eu
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix 2>/dev/null || true
Xvfb :99 -screen 0 "${SCREEN}" -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
SANDBOX_FLAG=""; [ "${NO_SANDBOX:-0}" = "1" ] && SANDBOX_FLAG="--no-sandbox"
google-chrome-stable ${SANDBOX_FLAG} \
  --user-data-dir=/profile --remote-debugging-port=9223 --remote-allow-origins=* \
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
  --disable-gpu --disable-dev-shm-usage --disable-background-networking --disable-extensions \
  --disable-sync --mute-audio --js-flags=--max-old-space-size=512 --renderer-process-limit=2 \
  --window-size=1366,800 --window-position=0,0 --password-store=basic about:blank &
CHROME=$!
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &
trap 'kill -TERM $CHROME 2>/dev/null; wait $CHROME 2>/dev/null; exit 0' TERM INT
wait $CHROME
