# Phase 0 spike S1: the echo MCP server as a container (stand-in for the router behind the OAuth front).
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
USER node
ENV JW_PORT=8080
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/server.ts"]
