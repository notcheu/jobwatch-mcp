#!/usr/bin/env bash
# Phase 0 (S4, V5, V7, V14): log in to LinkedIn ONCE through noVNC, then check that the session survives restarts.
#   ./s4-linkedin.sh login     start Chrome in login mode, print how to reach it, wait for you, then stop it gracefully
#   ./s4-linkedin.sh check     one cycle: start Chrome -> load /feed/ once -> report state/fingerprint/memory -> Browser.close
#   ./s4-linkedin.sh persist   three `check` cycles with pauses (login persistence across restarts, V5)
#   ./s4-linkedin.sh reset     delete the saved profile (asks first)
# Run as mcpuser against the rootless daemon. You type your credentials yourself in the noVNC window; nothing here sees them.
# The profile lives in the Docker volume jw-profile-linkedin (outside the repo). Never commit, copy or share it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECCOMP=${SECCOMP:-$ROOT/spikes/chrome/chrome-seccomp.json}; NODE_VERSION=${NODE_VERSION:-26}
CHROME_LANG=${CHROME_LANG:-fr-FR}; MEM_MAX=${MEM_MAX:-1100m}
NET=jw-s4-net; BR=jw-s4-browser; PR=jw-s4-probe; PROFILE=jw-profile-linkedin
cmd=${1:-}
if ! info=$(docker info 2>&1) || ! grep -qi rootless <<<"$info"; then echo "ERROR: not the rootless daemon (DOCKER_HOST=${DOCKER_HOST:-<unset>})"; exit 1; fi
# Graceful stop first (SIGTERM, 25 s) so Chrome flushes cookies, e.g. when you press Ctrl+C during login.
cleanup() { docker stop -t 25 "$BR" >/dev/null 2>&1 || true; docker rm -f "$BR" "$PR" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap 'cleanup' EXIT

prepare() {
  echo "[1/3] cleaning up leftovers"; cleanup
  echo "[2/3] building the Chrome image (a few minutes the first time, cached afterwards)..."
  docker build -q -t jw-spike-chrome "$ROOT/spikes/chrome" >/dev/null
  echo "[3/3] creating network $NET"; docker network create "$NET" >/dev/null
}
start_browser() { # $1 = mode, rest = extra docker args
  local mode=$1; shift
  docker run -d --name "$BR" --init --network "$NET" --memory "$MEM_MAX" --memory-swap "$MEM_MAX" --pids-limit 512 --shm-size 256m --cpus 1.5 \
    --cap-drop ALL --security-opt no-new-privileges --security-opt "seccomp=$SECCOMP" --read-only \
    --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /home/chrome:rw,size=64m,uid=1000,gid=1000 \
    -v "$PROFILE":/profile -e MODE="$mode" -e CHROME_LANG="$CHROME_LANG" "$@" jw-spike-chrome >/dev/null
}
browser_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$BR"; }
stop_graceful() { docker stop -t 25 "$BR" >/dev/null 2>&1 || true; echo "browser stopped, exit code $(docker inspect -f '{{.State.ExitCode}}' "$BR" 2>/dev/null || echo '?')"; }

case "$cmd" in
login)
  prepare
  VNC_PASSWORD=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 10)
  echo "starting Chrome in login mode..."
  start_browser login -p 127.0.0.1:6080:6080 -e VNC_PASSWORD="$VNC_PASSWORD" -e START_URL=https://www.linkedin.com/login
  HOST_IP=$(hostname -I | awk '{print $1}')
  cat <<MSG
Chrome is up in login mode (profile volume: $PROFILE, UI language: $CHROME_LANG).
1. On your Mac, open a tunnel:   ssh -N -L 6080:127.0.0.1:6080 $(id -un)@$HOST_IP
2. Open in your Mac browser:     http://localhost:6080/vnc.html?autoconnect=1
3. VNC password (shown once):    $VNC_PASSWORD
4. Log in to LinkedIn yourself in that window. Solve any verification yourself. Wait until you see your feed.
   Do not browse around; one login is enough.
MSG
  read -r -p "Press Enter here when you are on the feed to stop Chrome gracefully and save the session... " _
  stop_graceful ;;
check|persist)
  prepare
  echo "building the probe image (a few minutes the first time)..."
  docker build -q --build-arg NODE_VERSION="$NODE_VERSION" -t jw-spike-s4-probe "$ROOT/spikes/s4" >/dev/null
  cycles=1; [ "$cmd" = persist ] && cycles=3
  for n in $(seq 1 "$cycles"); do
    echo "=== cycle $n/$cycles"
    docker rm -f "$BR" >/dev/null 2>&1 || true
    start_browser run
    IP=$(browser_ip); peakfile=$(mktemp); : >"$peakfile"
    ( while docker exec "$BR" cat /sys/fs/cgroup/memory.peak >>"$peakfile" 2>/dev/null; do sleep 2; done ) &
    sampler=$!
    timeout 150 docker run --rm --init --name "$PR" --network "$NET" --read-only --tmpfs /tmp:rw,size=64m,uid=1000,gid=1000 \
      --cap-drop ALL --security-opt no-new-privileges -e BROWSER_IP="$IP" jw-spike-s4-probe || echo "(probe exit $? : 2 means not logged in / unknown state)"
    for _ in $(seq 1 25); do [ "$(docker inspect -f '{{.State.Running}}' "$BR")" = false ] && break; sleep 1; done
    kill "$sampler" 2>/dev/null || true
    echo "browser running=$(docker inspect -f '{{.State.Running}}' "$BR") exit=$(docker inspect -f '{{.State.ExitCode}}' "$BR"); peak memory seen: $(( $(sort -n "$peakfile" | tail -1 | grep -E '^[0-9]+$' || echo 0) / 1024 / 1024 )) MB"
    rm -f "$peakfile"
    if [ "$n" -lt "$cycles" ]; then echo "pausing 20 s before the next restart"; sleep 20; fi
  done ;;
reset)
  read -r -p "Delete the saved LinkedIn profile volume $PROFILE? You will have to log in again. Type yes: " a
  [ "$a" = yes ] && docker volume rm "$PROFILE" && echo removed || echo "kept" ;;
*) echo "usage: $0 login|check|persist|reset"; exit 1 ;;
esac
