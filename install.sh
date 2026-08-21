#!/bin/sh
# Friday Next installer bootstrap.
#
# A bare `npx -y @syengup/friday-channel-next` fetches the installer from the
# user's npm registry (default: registry.npmjs.org). Mainland-China hosts
# typically cannot complete a TLS handshake to that Cloudflare-backed origin,
# so npx hangs for minutes and install.js never starts.
#
# This script probes the official registry and npmmirror in parallel, then runs
# npx from the faster one. `--beta` also pins the npx spec to the beta dist-tag
# so the installer itself is the preview line (not latest's installer plus a
# beta payload).
#
# Usage:
#   curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh
#   curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh -s -- --beta
set -eu

PKG="@syengup/friday-channel-next"
OFFICIAL="https://registry.npmjs.org"
MIRROR="https://registry.npmmirror.com"
PROBE_TIMEOUT=3

if ! command -v npx >/dev/null 2>&1; then
  echo "friday-next: npx not found — install Node.js first" >&2
  exit 1
fi

if [ -n "${FRIDAY_NPM_REGISTRY:-}" ]; then
  REGISTRY="$FRIDAY_NPM_REGISTRY"
else
  tmp=$(mktemp -d)
  curl -fsS -o /dev/null -w '%{time_total}' \
    --connect-timeout "$PROBE_TIMEOUT" --max-time "$PROBE_TIMEOUT" \
    "$OFFICIAL/-/ping" >"$tmp/official" 2>/dev/null &
  curl -fsS -o /dev/null -w '%{time_total}' \
    --connect-timeout "$PROBE_TIMEOUT" --max-time "$PROBE_TIMEOUT" \
    "$MIRROR/-/ping" >"$tmp/mirror" 2>/dev/null &
  wait
  official=$(cat "$tmp/official" 2>/dev/null || true)
  mirror=$(cat "$tmp/mirror" 2>/dev/null || true)
  rm -rf "$tmp"

  # Both unreachable → npmmirror. Typical China failure is official-dead /
  # mirror-fine; preferring official here would recreate the npx hang.
  if [ -z "$official" ] && [ -z "$mirror" ]; then
    REGISTRY="$MIRROR"
  elif [ -z "$official" ]; then
    REGISTRY="$MIRROR"
  elif [ -z "$mirror" ]; then
    REGISTRY="$OFFICIAL"
  elif awk -v o="$official" -v m="$mirror" 'BEGIN { exit !(m + 0.150 >= o) }'; then
    # Close race (150ms): prefer official. Otherwise the faster one.
    REGISTRY="$OFFICIAL"
  else
    REGISTRY="$MIRROR"
  fi
fi

export npm_config_registry="$REGISTRY"
echo "friday-next: using $REGISTRY" >&2

npx_spec="$PKG"
for arg in "$@"; do
  if [ "$arg" = "--beta" ]; then
    npx_spec="$PKG@beta"
    break
  fi
done

exec npx -y "$npx_spec" "$@"
