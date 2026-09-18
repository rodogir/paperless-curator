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
# Runtime stage: only the bundle. Configuration, the whitelist, and the review
# artifacts are mounted at /data; secrets arrive only through environment
# variables. No port is exposed.
#
# The entrypoint starts as root only to drop privileges to PUID:PGID (Unraid
# defaults: 99 nobody, 100 users) and then execs the worker; the long-lived
# process is always non-root.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="paperless-curator" \
      org.opencontainers.image.description="Paperless-ngx metadata worker using an OpenAI-compatible LLM" \
      org.opencontainers.image.source="https://github.com/rodogir/paperless-curator" \
      org.opencontainers.image.licenses="MIT"

ENV CONFIG_PATH=/data/config.json \
    DATA_DIR=/data

COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/paperless-curator-entrypoint.sh

# /data is a mount point for the host data directory (Unraid appdata). Own it by
# the default PUID:PGID so a fresh named volume is writable out of the box.
RUN apk add --no-cache su-exec \
 && mkdir -p /data \
 && chown 99:100 /data \
 && chmod 0775 /data \
 && chmod 0755 /usr/local/bin/paperless-curator-entrypoint.sh
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/paperless-curator-entrypoint.sh"]
CMD ["bun", "/app/dist/index.js"]
