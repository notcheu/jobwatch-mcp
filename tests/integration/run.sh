#!/usr/bin/env bash
# Integration test of the browser layer against a REAL browser container (Phase 1, steps 5b and 6).
# Needs docker. Not part of `npm test` (CI): it builds the browser image and takes a few minutes on a cold cache.
#   Mac (Docker Desktop):     tests/integration/run.sh
#   Linux, rootless Docker:           DOCKER_SOCKET=$XDG_RUNTIME_DIR/docker.sock tests/integration/run.sh
# On arm64 the image uses Chromium (development only); on amd64 it uses Google Chrome, like production.
# It creates and removes: network jw-it-net, image jobwatch-browser:it, image jw-it-runner, containers jw-it-*, volumes jw-it-*.
set -euo pipefail
cd "$(dirname "$0")/../.."
SOCK=${DOCKER_SOCKET:-/var/run/docker.sock}
NET=jw-it-net
cleanup() {
  docker ps -aq --filter label=jobwatch.managed=true --filter name=jw-it | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker ps -aq --filter label=jobwatch.login=true --filter name=jw-login-it | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume ls -q --filter name=jw-it- | xargs -r docker volume rm >/dev/null 2>&1 || true
}
trap cleanup EXIT; cleanup
# IT_PREBUILT=<image> reuses an image you already have (no registry access needed); otherwise the image is built.
if [ -n "${IT_PREBUILT:-}" ]; then
  echo "== using the prebuilt browser image $IT_PREBUILT"; docker tag "$IT_PREBUILT" jobwatch-browser:it
else
  echo "== building the browser image"; docker build -q -t jobwatch-browser:it images/browser >/dev/null
fi
echo "== building the test runner (installs dependencies; the test network has no internet)"; docker build -q -t jw-it-runner -f tests/integration/Dockerfile . >/dev/null
docker network create --internal "$NET" >/dev/null
echo "== running the integration test"
docker run --rm --network "$NET" -v "$SOCK:/var/run/docker.sock" \
  -e IT_IMAGE=jobwatch-browser:it -e IT_NETWORK="$NET" jw-it-runner \
  bash -c 'cd packages/core && npx vitest run --config vitest.integration.config.ts'
