# Router-like test runner: Node 26 + the docker CLI + the repository WITH its dependencies installed, so it can run on the
# internal network (no internet) next to the browser container, like the real router. Build context: the repository root.
#   docker build -f tests/integration/Dockerfile -t jw-it-runner .
# The CLI is the static binary from download.docker.com: no second registry image to pull.
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim
ARG DOCKER_VERSION=27.5.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(uname -m)" \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && docker --version
WORKDIR /work
COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN npm ci --no-audit --no-fund
COPY images ./images
ENV NX_DAEMON=false
