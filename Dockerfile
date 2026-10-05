# Router image (Nx workspace). Build from the repo root:  docker build -t jobwatch-router:dev .
# No `# syntax` directive on purpose: the BuildKit built-in frontend supports everything used here (cache mounts, named
# stages), and the directive costs an extra Docker Hub round-trip (and dependency) on every build.
# `nx run-many -t build` bundles apps/mcp and apps/cli to dist/apps/{mcp,cli}/main.js with esbuild. Packages that must stay
# out of the bundle (the browser driver `playwright-core`, step 6) are listed, pinned, in apps/mcp/external-deps.package.json
# and installed in the prod-deps stage. The SQLite store uses Node's built-in `node:sqlite`: nothing native to build or ship.
ARG NODE_VERSION=26
ARG DOCKER_CLI_VERSION=27

# Docker does not expand variables in `COPY --from=...`, so the CLI image is a named stage.
FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NX_DAEMON=false NX_NO_CLOUD=true
COPY package.json package-lock.json nx.json tsconfig.base.json ./
# npm ci needs every workspace member (packages, apps, tools) to match the lockfile.
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS build
# The dashboard is built to static files; only those reach the image, never the front end's node_modules.
RUN npx nx run-many -t build -p @jobwatch/mcp @jobwatch/cli @jobwatch/dashboard

FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY apps/mcp/external-deps.package.json ./package.json
# `mkdir`: with an empty dependency list npm creates no node_modules, and the runtime stage copies the folder.
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund && mkdir -p node_modules

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# The router spawns browser containers through the host's rootless socket (see docs/plans/10-deployment.md).
# Only the docker CLI is needed (no daemon): copy the static binary from the official CLI image (pin by digest later).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    DASHBOARD_STATIC_DIR=/app/dashboard \
    BROWSER_SECCOMP=/etc/jobwatch/chrome-seccomp.json
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/mcp ./dist/mcp
COPY --from=build /app/dist/apps/cli ./dist/cli
COPY --from=build /app/dist/apps/dashboard ./dashboard
# The Chrome seccomp profile is read by the docker CLI in THIS container when it starts a browser (docs/plans/05-browser-runtime.md, G6).
COPY images/browser/chrome-seccomp.json /etc/jobwatch/chrome-seccomp.json
# `jobwatch` available inside the container: docker compose exec router jobwatch adapters list
RUN printf '#!/bin/sh\nexec node /app/dist/cli/main.js "$@"\n' > /usr/local/bin/jobwatch && chmod +x /usr/local/bin/jobwatch
# State lives in /data (mounted volume). Create it owned by the runtime user: a named volume copies this ownership on first use,
# so `jobwatch adapters enable` can write adapters.json. (A bind mount keeps the host owner: see deploy/compose.yml, VERIFY on the reference host.)
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
# uid/gid 1000 ("node"); the rest of the filesystem is read-only at run time.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/mcp/main.js"]
