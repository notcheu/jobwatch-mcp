#!/usr/bin/env bash
# Phase 0 (S3/S7): run a headful Chrome in a memory-capped rootless container, load pages, record memory.
# Run as mcpuser with DOCKER_HOST pointing at the rootless socket. Creates/removes only the container "jw-spike-chrome".
# Env: MEM_MAX (1100m) MEM_RES (900m) NO_SANDBOX (0|1) SETTLE_S (10) URLS (space-separated)
set -euo pipefail
cd "$(dirname "$0")/../chrome"
MEM_MAX=${MEM_MAX:-1100m}; MEM_RES=${MEM_RES:-900m}; NO_SANDBOX=${NO_SANDBOX:-0}; SETTLE_S=${SETTLE_S:-10}
URLS=${URLS:-"https://en.wikipedia.org/wiki/Main_Page https://www.lemonde.fr https://www.welcometothejungle.com/fr https://www.apec.fr"}
NAME=jw-spike-chrome; PORT=19222
docker info 2>/dev/null | grep -qi rootless || { echo "ERROR: not talking to the rootless daemon (check DOCKER_HOST)"; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT; cleanup

echo "== host before"; free -m | sed -n 1,3p
echo "== build"; docker build -q -t jw-spike-chrome .
cg() { docker exec "$NAME" cat "/sys/fs/cgroup/$1" 2>/dev/null || echo 0; }
mb() { echo $(( $1 / 1024 / 1024 )); }

echo "== run (memory=$MEM_MAX reservation=$MEM_RES no_sandbox=$NO_SANDBOX)"
t0=$(date +%s.%N)
docker run -d --name "$NAME" --init --memory "$MEM_MAX" --memory-swap "$MEM_MAX" --memory-reservation "$MEM_RES" \
  --pids-limit 512 --shm-size 256m --cpus 1.5 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,size=256m --tmpfs /run:rw,size=16m --tmpfs /profile:rw,size=512m,uid=1000,gid=1000 \
  -e NO_SANDBOX="$NO_SANDBOX" -p 127.0.0.1:$PORT:9222 jw-spike-chrome >/dev/null
for i in $(seq 1 120); do
  curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || { echo "FAIL: container exited"; docker logs "$NAME" 2>&1 | tail -15; exit 1; }
  sleep 0.5
done
curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "FAIL: DevTools not reachable"; docker logs "$NAME" 2>&1 | tail -15; exit 1; }
echo "cold start to DevTools ready: $(echo "$(date +%s.%N) - $t0" | bc) s"
sleep 3
echo "idle: current=$(mb "$(cg memory.current)") MB peak=$(mb "$(cg memory.peak)") MB"
echo "effective limits: memory.max=$(cg memory.max) memory.high=$(cg memory.high) swap.max=$(cg memory.swap.max)"

for u in $URLS; do
  id=$(curl -fs -X PUT "http://127.0.0.1:$PORT/json/new?$u" | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1)
  sleep "$SETTLE_S"
  running=$(docker inspect -f '{{.State.Running}}' "$NAME")
  echo "$u -> current=$(mb "$(cg memory.current)") MB peak=$(mb "$(cg memory.peak)") MB running=$running"
  [ "$running" = true ] || break
  [ -n "$id" ] && curl -fs "http://127.0.0.1:$PORT/json/close/$id" >/dev/null || true
done
sleep 3
echo "after closing tabs: current=$(mb "$(cg memory.current)") MB peak=$(mb "$(cg memory.peak)") MB"
echo "processes: $(docker exec "$NAME" ps -eo rss,comm --sort=-rss 2>/dev/null | head -6 | tr '\n' ';')"
echo "OOMKilled=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME") ExitCode=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
echo "== host after"; free -m | sed -n 1,3p
echo "Paste this whole output back. Re-run 2-3 times and once with NO_SANDBOX=1 if the default run fails."
