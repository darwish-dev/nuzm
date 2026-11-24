#!/usr/bin/env bash
# Per-session isolation of databases, ports, workspaces and build caches. SOURCE it from inside a session worktree:
#   source scripts/session-env.sh <n>        # n = 1..9 (Phase 3 session number), 0 = the Master (uses 54341)
# It exports variables only; it starts nothing and never points at the owner's dev stack (:54329, 3000, 3001, 4000).
#   NUZM_PGPORT / DATABASE_ADMIN_URL / NUZM_TEST_ADMIN_URL   own Postgres (54350+n; Master 54341)
#   E2E_PG_PORT                                              same cluster for the isolated E2E (its ports are picked free by e2e-isolated.sh)
#   TURBO_CACHE_DIR, XDG_CACHE_HOME, PNPM_HOME is untouched  build caches under ~/.cache/nuzm-sessions/s<n> (no cross-session cache poisoning)
#   TMPDIR, APPBUILDER_GIT_ROOT, NUZM_SESSION                scratch space under /private/tmp/nuzm-s<n>
n="${1:-}"
case "$n" in ''|*[!0-9]*) echo "usage: source scripts/session-env.sh <0-9>"; return 2 2>/dev/null || exit 2;; esac
if [ "$n" -eq 0 ]; then PORT=54341; else PORT=$((54350 + n)); fi
export NUZM_SESSION="s$n"
export NUZM_PGPORT="$PORT"
export E2E_PG_PORT="$PORT"
export DATABASE_ADMIN_URL="postgres://nuzm_admin@127.0.0.1:$PORT/nuzm_dev"
export NUZM_TEST_ADMIN_URL="postgres://nuzm_admin@127.0.0.1:$PORT/postgres"
export TURBO_CACHE_DIR="$HOME/.cache/nuzm-sessions/s$n/turbo"
export XDG_CACHE_HOME="$HOME/.cache/nuzm-sessions/s$n/xdg"
export TMPDIR="/private/tmp/nuzm-s$n/"
export APPBUILDER_GIT_ROOT="/private/tmp/nuzm-s$n/appbuilder-git"
mkdir -p "$TURBO_CACHE_DIR" "$XDG_CACHE_HOME" "$TMPDIR" "$APPBUILDER_GIT_ROOT"
echo "session $NUZM_SESSION: Postgres :$PORT, caches ~/.cache/nuzm-sessions/s$n, tmp $TMPDIR"
