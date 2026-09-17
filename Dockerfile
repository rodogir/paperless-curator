# syntax=docker/dockerfile:1

# Pinned Bun release. Keep in sync with `engines.bun` in package.json and the
# bun-version used by CI.
ARG BUN_VERSION=1.3.13

# ---------------------------------------------------------------------------
# Build stage: bundle the worker. There are no runtime dependencies, so this
# stage needs only the sources and a pinned Bun image.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target bun --outdir dist --minify

# ---------------------------------------------------------------------------
# Runtime stage: only the bundle, running as the image's non-root `bun` user.
# Configuration, the whitelist, and the review artifacts are mounted at /data;
# secrets arrive only through environment variables. No port is exposed.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="paperless-curator" \
      org.opencontainers.image.description="Paperless-ngx metadata worker using an OpenAI-compatible LLM" \
      org.opencontainers.image.source="https://github.com/rodogir/paperless-curator" \
      org.opencontainers.image.licenses="MIT"

ENV CONFIG_PATH=/data/config.json \
    DATA_DIR=/data

COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./

# /data is a mount point for the host data directory (Unraid appdata). Create
# and own it here so a bare `docker run` with a fresh empty volume works.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

USER bun
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/app/dist/index.js"]
