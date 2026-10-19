# Hosted MCP server over Streamable HTTP (src/http/index.ts).
# Multi-stage: build with dev dependencies, run with production ones only.
# The build stage needs a full install: tsc (TS 7 native) and tsup (esbuild)
# ship their platform binaries as optional dependencies. Pruning with
# --omit=dev drops those along with the dev packages that own them, but keeps
# better-sqlite3 (an optional dependency of this package) for the persistent
# cache. The default is still the in-memory cache; see docs/hosting.md.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
# Home for the SQLite cache file. Owned by `node` so a named volume mounted here
# is writable; unused unless MED_RESEARCH_CACHE_BACKEND=sqlite is set.
RUN mkdir /data && chown node:node /data
# The default HOST (127.0.0.1) would not be reachable outside the container.
ENV HOST=0.0.0.0
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/http/index.js"]
