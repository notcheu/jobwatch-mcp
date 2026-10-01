# syntax=docker/dockerfile:1
# Router image (Nx workspace). Build from the repo root:  docker build -t jobwatch-router:dev .
# UNTESTED until apps/mcp exists (Phase 1, step 4). Expects:
#   - `npx nx build mcp` bundles apps/mcp (and apps/cli as the `jobwatch` binary) to dist/apps/{mcp,cli}/main.js with esbuild,
#     keeping `better-sqlite3` and `playwright-core` external;
#   - the external package versions are pinned in the root package.json.
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS build
RUN npx nx build mcp && npx nx build cli

FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
# better-sqlite3 has a native addon: if no prebuilt binary exists for this Node/arch, add a build toolchain HERE only.
COPY apps/mcp/external-deps.package.json ./package.json
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# The router spawns browser containers through the host's rootless socket (see 10-deployment.md).
# Only the docker CLI is needed (no daemon): copy the static binary from the official CLI image (pin by digest later).
ARG DOCKER_CLI_VERSION=27
COPY --from=docker:${DOCKER_CLI_VERSION}-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    JW_PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/mcp ./dist/mcp
COPY --from=build /app/dist/apps/cli ./dist/cli
# `jobwatch` available inside the container: docker compose exec router jobwatch adapters list
RUN printf '#!/bin/sh\nexec node /app/dist/cli/main.js "$@"\n' > /usr/local/bin/jobwatch && chmod +x /usr/local/bin/jobwatch
# uid/gid 1000 ("node"); state lives in mounted volumes (/data), the rest is read-only.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.JW_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/mcp/main.js"]
