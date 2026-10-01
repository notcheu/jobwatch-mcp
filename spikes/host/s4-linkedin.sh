#!/usr/bin/env bash
# Phase 0 (S4, V5, V7, V14): log in to LinkedIn ONCE through noVNC, then check that the session survives restarts.
#   ./s4-linkedin.sh login     start Chrome in login mode, print how to reach it, wait for you, then stop it gracefully
#   ./s4-linkedin.sh check     one cycle: start Chrome -> load /feed/ once -> report state/fingerprint/memory -> Browser.close
#   ./s4-linkedin.sh persist   three `check` cycles with pauses (login persistence across restarts, V5)
#   ./s4-linkedin.sh pages     S5: 5 read-only navigations (/jobs/, one search page, 2 job pages, 1 split view), memory per stage
#   ./s4-linkedin.sh reset     delete the saved profile (asks first)
# Run as mcpuser against the rootless daemon. You type your credentials yourself in the noVNC window; nothing here sees them.
# The profile lives in the Docker volume jw-profile-linkedin (outside the repo). Never commit, copy or share it.
set -euo pipefail
# Local, gitignored settings (e.g. ACCEPT_LANGS='fr-FR,en-GB,...' copied from navigator.languages of your everyday Chrome).
[ -f "$(dirname "$0")/.env.local" ] && . "$(dirname "$0")/.env.local"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECCOMP=${SECCOMP:-$ROOT/spikes/chrome/chrome-seccomp.json}; NODE_VERSION=${NODE_VERSION:-26}
CHROME_LANG=${CHROME_LANG:-fr-FR}; MEM_MAX=${MEM_MAX:-1100m}
NET=jw-s4-net; BR=jw-s4-browser; PR=jw-s4-probe; PROFILE=jw-profile-linkedin
cmd=${1:-}
echo "ACCEPT_LANGS: ${ACCEPT_LANGS:-<not set: .env.local missing or empty, image default is used>}"
echo "MEM_MAX=$MEM_MAX CHROME_EXTRA=${CHROME_EXTRA:-<none>} STAGES=${STAGES:-<all>} BLOCK=${BLOCK:-<none>} SEARCH_URL=${SEARCH_URL:-<classic /jobs/search/ URL>}"
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
    --cap-drop ALL --security-opt no-new-privileges --security-opt "seccomp=$SECCOMP" --read-only --oom-score-adj 500 \
    --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /home/chrome:rw,size=64m,uid=1000,gid=1000 \
    -v "$PROFILE":/profile -e MODE="$mode" -e CHROME_LANG="$CHROME_LANG" ${ACCEPT_LANGS:+-e ACCEPT_LANGS="$ACCEPT_LANGS"} ${CHROME_EXTRA:+-e CHROME_EXTRA="$CHROME_EXTRA"} "$@" jw-spike-chrome >/dev/null
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
check|persist|pages)
  prepare
  case "$cmd" in pages) PROBE_DIR=s5; PROBE_IMG=jw-spike-s5-probe ;; *) PROBE_DIR=s4; PROBE_IMG=jw-spike-s4-probe ;; esac
  echo "building the probe image (a few minutes the first time)..."
  docker build -q --build-arg NODE_VERSION="$NODE_VERSION" -t "$PROBE_IMG" "$ROOT/spikes/$PROBE_DIR" >/dev/null
  cycles=1; [ "$cmd" = persist ] && cycles=3
  for n in $(seq 1 "$cycles"); do
    echo "=== cycle $n/$cycles"
    docker rm -f "$BR" >/dev/null 2>&1 || true
    start_browser run
    IP=$(browser_ip); samples=$(mktemp); probeout=$(mktemp); : >"$samples"
    # One sample every 2 s: "<epoch ms> <memory.peak> <working set> <oom_kill> <anon+shmem>". Working set = memory.current - inactive_file (what `docker stats` shows).
    ( while line=$(docker exec "$BR" sh -c 'p=$(cat /sys/fs/cgroup/memory.peak); c=$(cat /sys/fs/cgroup/memory.current); i=$(awk "/^inactive_file /{print \$2}" /sys/fs/cgroup/memory.stat); o=$(awk "/^oom_kill /{print \$2}" /sys/fs/cgroup/memory.events); a=$(awk "/^(anon|shmem) /{s+=\$2} END{print s}" /sys/fs/cgroup/memory.stat); echo "$p $((c-i)) $o $a"' 2>/dev/null); do
        echo "$(date +%s%3N) $line" >>"$samples"; sleep 2; done ) &
    sampler=$!
    timeout 240 docker run --rm --init --name "$PR" --network "$NET" --read-only --tmpfs /tmp:rw,size=64m,uid=1000,gid=1000 \
      --cap-drop ALL --security-opt no-new-privileges -e BROWSER_IP="$IP" ${STAGES:+-e STAGES="$STAGES"} ${BLOCK:+-e BLOCK="$BLOCK"} ${SEARCH_URL:+-e SEARCH_URL="$SEARCH_URL"} "$PROBE_IMG" | tee "$probeout" | grep -v '^@@' || echo "(probe exit ${PIPESTATUS[0]} : 2 means not logged in / checkpoint / unknown state)"
    for _ in $(seq 1 25); do [ "$(docker inspect -f '{{.State.Running}}' "$BR")" = false ] && break; sleep 1; done
    kill "$sampler" 2>/dev/null || true
    echo "browser running=$(docker inspect -f '{{.State.Running}}' "$BR") exit=$(docker inspect -f '{{.State.ExitCode}}' "$BR")"
    mb() { echo $(( $1 / 1024 / 1024 )); }
    echo "memory (cap $MEM_MAX): memory.peak=$(mb "$(awk 'BEGIN{m=0} $2>m{m=$2} END{print m}' "$samples")") MB, max working set=$(mb "$(awk 'BEGIN{m=0} $3>m{m=$3} END{print m}' "$samples")") MB, max anon+shmem (process memory without file cache)=$(mb "$(awk 'BEGIN{m=0} $5>m{m=$5} END{print m}' "$samples")") MB, kernel oom_kill events=$(awk 'BEGIN{m=0} $4>m{m=$4} END{print m}' "$samples")"
    if grep -q '^@@STAGE' "$probeout"; then
      echo "memory per stage (max working set / memory.peak at end, MB):"
      awk -v S="$samples" '
        BEGIN { while ((getline l < S) > 0) { split(l, a, " "); n++; ts[n]=a[1]; pk[n]=a[2]; ws[n]=a[3]; an[n]=a[5] } }
        /^@@STAGE/ { st[$2]=$3 }
        /^@@END/   { en[$2]=$3; order[++k]=$2 }
        END { for (i=1;i<=k;i++) { name=order[i]; mw=0; mp=0; ma=0
                for (j=1;j<=n;j++) if (ts[j]>=st[name]-1000 && ts[j]<=en[name]+2000) { if (ws[j]>mw) mw=ws[j]; if (pk[j]>mp) mp=pk[j]; if (an[j]>ma) ma=an[j] }
                printf "  %-14s working set %5d MB   anon+shmem %5d MB   peak %5d MB\n", name, mw/1048576, ma/1048576, mp/1048576 } }' "$probeout"
    fi
    rm -f "$samples" "$probeout"
    if [ "$n" -lt "$cycles" ]; then echo "pausing 20 s before the next restart"; sleep 20; fi
  done ;;
reset)
  read -r -p "Delete the saved LinkedIn profile volume $PROFILE? You will have to log in again. Type yes: " a
  [ "$a" = yes ] && docker volume rm "$PROFILE" && echo removed || echo "kept" ;;
*) echo "usage: $0 login|check|persist|pages|reset"; exit 1 ;;
esac
