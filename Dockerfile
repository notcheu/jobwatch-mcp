# syntax=docker/dockerfile:1
# Router image. Build from the repo root:  docker build -t jobwatch-router:dev .
# Expects package.json scripts: "build" (tsc + copy non-TS assets such as adapters/**/extract.js into dist/).
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

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
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY catalog ./catalog
# uid/gid 1000 ("node"); state lives in mounted volumes (/data), the rest is read-only.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.JW_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/app.js"]
