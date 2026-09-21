#!/bin/sh
# Starts Beebo as an unprivileged user.
#   - Started as a normal user (image default uid 1000, or `user:` / `--user`): just runs.
#   - Started as root (`--user 0`): drops to PUID:PGID (default 1000:1000) after making
#     /config writable for that user. Root is never used to run the server unless
#     BEEBO_ALLOW_ROOT=1.
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ "${BEEBO_ALLOW_ROOT:-0}" = "1" ]; then
    echo "[entrypoint] WARNING: running the Beebo server as root (BEEBO_ALLOW_ROOT=1)" >&2
    exec "$@"
  fi
  puid="${PUID:-1000}"
  pgid="${PGID:-1000}"
  case "$puid$pgid" in
    ''|*[!0-9]*) echo "[entrypoint] PUID and PGID must be plain numbers (got PUID='$puid' PGID='$pgid')" >&2; exit 64 ;;
  esac
  if [ "$puid" = "0" ] || [ "$pgid" = "0" ]; then
    echo "[entrypoint] PUID/PGID 0 means root; set BEEBO_ALLOW_ROOT=1 if you really want that" >&2
    exit 64
  fi
  data="${BEEBO_DATA_DIR:-/config}"
  mkdir -p "$data"
  if [ "$(stat -c %u:%g "$data")" != "$puid:$pgid" ]; then
    echo "[entrypoint] giving $data to $puid:$pgid"
    chown -R "$puid:$pgid" "$data"
  fi
  extra=""
  if [ -n "${PGID_EXTRA:-}" ]; then extra="--groups=${PGID_EXTRA}"; else extra="--clear-groups"; fi
  exec setpriv --reuid="$puid" --regid="$pgid" $extra "$@"
fi

exec "$@"
