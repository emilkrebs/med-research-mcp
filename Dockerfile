# Hosted MCP server over Streamable HTTP (src/http/index.ts).
# Multi-stage: build with dev dependencies, run with production ones only.
# The build stage needs a full install: tsc (TS 7 native) and tsup (esbuild)
# ship their platform binaries as optional dependencies. Optional packages are
# pruned afterwards, which also drops better-sqlite3 — the hosted instance
# uses the default in-memory cache.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-slim
ENV NODE_ENV=production
# wget is only needed for the HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The default HOST (127.0.0.1) would not be reachable outside the container.
ENV HOST=0.0.0.0
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/http/index.js"]
