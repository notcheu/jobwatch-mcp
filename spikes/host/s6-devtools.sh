#!/usr/bin/env bash
# Phase 0 (S6): can a separate container drive Chrome's DevTools over an internal Docker network? (V6, G2, G5, part of V7)
# Run as mcpuser against the rootless daemon. Creates and removes: network jw-spike-net (--internal), containers
# jw-spike-browser and jw-spike-router, volume jw-spike-profile6, images jw-spike-chrome and jw-spike-probe (kept).
# Env: SECCOMP (default: spikes/chrome/chrome-seccomp.json), NODE_VERSION (26)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECCOMP=${SECCOMP:-$ROOT/spikes/chrome/chrome-seccomp.json}; NODE_VERSION=${NODE_VERSION:-26}
NET=jw-spike-net; BR=jw-spike-browser; RT=jw-spike-router; VOL=jw-spike-profile6
if ! info=$(docker info 2>&1) || ! grep -qi rootless <<<"$info"; then echo "ERROR: not the rootless daemon (DOCKER_HOST=${DOCKER_HOST:-<unset>})"; exit 1; fi
cleanup() { docker rm -f "$BR" "$RT" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup

echo "== build"; docker build -q -t jw-spike-chrome "$ROOT/spikes/chrome" >/dev/null
docker build -q --build-arg NODE_VERSION="$NODE_VERSION" -t jw-spike-probe "$ROOT/spikes/s6" >/dev/null
docker network create --internal "$NET" >/dev/null
echo "== start browser (no published ports, internal network only)"
docker run -d --name "$BR" --init --network "$NET" --memory 1100m --memory-swap 1100m --pids-limit 512 --shm-size 256m --cpus 1.5 \
  --cap-drop ALL --security-opt no-new-privileges --security-opt "seccomp=$SECCOMP" --read-only \
  --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /home/chrome:rw,size=64m,uid=1000,gid=1000 -v "$VOL":/profile \
  jw-spike-chrome >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$BR")
echo "browser container IP on $NET: $IP"
echo "== run probe (stand-in for the router; no internet on this network)"
timeout 120 docker run --rm --init --name "$RT" --network "$NET" --read-only --tmpfs /tmp:rw,size=64m,uid=1000,gid=1000 --cap-drop ALL --security-opt no-new-privileges \
  -e BROWSER_IP="$IP" -e BROWSER_NAME="$BR" jw-spike-probe || echo "(probe exited non-zero or hit the 120 s limit)"
echo "== did Browser.close stop the container? (waiting up to 25 s)"
for _ in $(seq 1 25); do [ "$(docker inspect -f '{{.State.Running}}' "$BR")" = false ] && break; sleep 1; done
echo "running=$(docker inspect -f '{{.State.Running}}' "$BR") exitcode=$(docker inspect -f '{{.State.ExitCode}}' "$BR")"
echo "Paste this whole output back."
