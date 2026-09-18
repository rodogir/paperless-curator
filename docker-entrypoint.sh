#!/bin/sh
# Drop privileges to PUID:PGID (Unraid defaults: 99 nobody, 100 users) and then
# run the worker. The image starts as root only for this step; the long-lived
# process is always non-root. /data is chowned only when the target user cannot
# already write it, so a correctly-owned appdata directory is never touched.
set -eu

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
