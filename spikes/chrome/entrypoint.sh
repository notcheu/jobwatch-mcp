#!/usr/bin/env bash
# Spike entrypoint. MODE=run (default): Chrome + DevTools. MODE=login: also x11vnc + noVNC on :6080 (password required).
set -eu
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix 2>/dev/null || true
Xvfb :99 -screen 0 "${SCREEN}" -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket

# navigator.languages comes from profile preferences, not from --lang (G8). Recent Chrome reads intl.selected_languages;
# intl.accept_languages is the legacy key. Set both.
mkdir -p /profile/Default
[ -s /profile/Default/Preferences ] || echo '{}' > /profile/Default/Preferences
jq --arg l "${ACCEPT_LANGS}" '.intl.accept_languages = $l | .intl.selected_languages = $l' /profile/Default/Preferences > /profile/Default/Preferences.tmp \
  && mv /profile/Default/Preferences.tmp /profile/Default/Preferences
echo "accept languages applied: $(jq -c '.intl | {accept_languages, selected_languages}' /profile/Default/Preferences)"

EXTRA=()
[ -n "${CHROME_EXTRA:-}" ] && { read -ra _X <<<"$CHROME_EXTRA"; EXTRA+=("${_X[@]}"); }   # experiments only, e.g. memory-saving flags
[ "${NO_SANDBOX:-0}" = "1" ] && EXTRA+=(--no-sandbox)
[ "${MODE}" = "run" ] && EXTRA+=(--restore-last-session)   # keep session cookies across restarts (G4)
if [ "${MODE}" = "login" ]; then
  x11vnc -display :99 -localhost -forever -shared -rfbport 5900 -passwd "${VNC_PASSWORD:?VNC_PASSWORD required in login mode}" -quiet &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
fi

chrome-bin "${EXTRA[@]}" \
  --user-data-dir=/profile --remote-debugging-port=9223 --remote-allow-origins=* \
  --lang="${CHROME_LANG}" --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
  --disable-gpu --disable-dev-shm-usage --disable-background-networking --disable-extensions \
  --disable-sync --mute-audio --js-flags=--max-old-space-size=512 --renderer-process-limit=2 \
  --window-size=1366,800 --window-position=0,0 --password-store=basic "${START_URL:-about:blank}" &
CHROME=$!
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &
trap 'kill -TERM $CHROME 2>/dev/null; wait $CHROME 2>/dev/null; exit 0' TERM INT
wait $CHROME
