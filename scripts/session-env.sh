#!/usr/bin/env bash
# Per-session isolation of database, ports, credentials, caches and scratch space through the central allocator (scripts/testenv). SOURCE it:
#   source scripts/session-env.sh <label>        # label = your session name (any short text); re-sourcing in a shell that already has a live lease reuses it
# It acquires (or reuses) a LEASE: a unique atomically reserved port, your own PostgreSQL cluster in your own data directory, a random per-lease password
# (exported as PGPASSWORD), and exports NUZM_TEST_ADMIN_URL / DATABASE_ADMIN_URL / E2E_PG_PORT / NUZM_LEASE_ID / NUZM_FORBID_DEFAULT_DB=1.
# There is no default database after this: integration and E2E runs preflight the URL against your lease and refuse anything else (the owner's dev cluster
# :54329 included). Release when done: node scripts/testenv/testenv.mjs release "$NUZM_LEASE_ID".
_label="${1:-session}"
_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
if [ -n "${NUZM_LEASE_ID:-}" ] && node "$_root/scripts/testenv/testenv.mjs" status 2>/dev/null | grep -q "^$NUZM_LEASE_ID"; then
  echo "session-env: reusing lease $NUZM_LEASE_ID (port $NUZM_LEASE_PORT)"
else
  _f="$(node "$_root/scripts/testenv/testenv.mjs" acquire --owner "$_label")" || { echo "session-env: no lease acquired" >&2; return 2 2>/dev/null || exit 2; }
  # shellcheck disable=SC1090
  . "$_f"
fi
export NUZM_SESSION="$_label"
export TURBO_CACHE_DIR="$HOME/.cache/nuzm-sessions/$NUZM_LEASE_ID/turbo"
export XDG_CACHE_HOME="$HOME/.cache/nuzm-sessions/$NUZM_LEASE_ID/xdg"
export TMPDIR="/private/tmp/nuzm-$NUZM_LEASE_ID/"
export APPBUILDER_GIT_ROOT="/private/tmp/nuzm-$NUZM_LEASE_ID/appbuilder-git"
mkdir -p "$TURBO_CACHE_DIR" "$XDG_CACHE_HOME" "$TMPDIR" "$APPBUILDER_GIT_ROOT"
echo "session $NUZM_SESSION: lease $NUZM_LEASE_ID, Postgres :$NUZM_LEASE_PORT (own cluster, own password), caches ~/.cache/nuzm-sessions/$NUZM_LEASE_ID"
