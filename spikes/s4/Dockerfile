# Phase 0 spike S4: stand-in for the router. Needs only to reach Chrome's DevTools, not the internet.
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
RUN npm init -y >/dev/null && npm install --save-exact playwright-core@1.63.0 --no-audit --no-fund
COPY check-linkedin.mjs ./
USER node
CMD ["node", "check-linkedin.mjs"]
