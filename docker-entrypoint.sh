#!/bin/sh
# Drop privileges to PUID:PGID (Unraid defaults: 99 nobody, 100 users) and then
# run the worker. The image starts as root only for this step; the long-lived
# process is always non-root. /data is chowned only when the target user cannot
# already write it, so a correctly-owned appdata directory is never touched.
#
# Arguments are forwarded to the worker, so `docker run <image> --help` and
# `docker run <image> --once` work while `docker run <image> sh` still opens a
# shell. This mirrors the pinned base image's entrypoint heuristic.
set -eu

first="${1:-}"
if [ -z "$first" ] || [ "${first#-}" != "$first" ] || ! command -v "$first" >/dev/null 2>&1; then
  set -- bun /app/dist/index.js "$@"
fi

PUID="${PUID:-99}"
PGID="${PGID:-100}"

case "$PUID:$PGID" in
  *[!0-9:]*) echo "PUID and PGID must be numeric" >&2; exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ] && ! su-exec "$PUID:$PGID" sh -c 'test -w /data'; then
    chown -R "$PUID:$PGID" /data 2>/dev/null || true
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Started with an explicit --user; already non-root, so run as-is.
exec "$@"