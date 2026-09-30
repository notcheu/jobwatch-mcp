# Phase 0 spike S6: stand-in for the router container. Built WITH network access, run on an INTERNAL network (no egress).
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
RUN npm init -y >/dev/null && npm install --save-exact playwright-core@1.63.0 --no-audit --no-fund
COPY probe.mjs ./
USER node
CMD ["node", "probe.mjs"]
