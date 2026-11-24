#!/usr/bin/env bash
# Phase 3 worktree bootstrap (Master-owned). Run INSIDE a fresh worktree: it copies (copy-on-write, no network) the installed dependencies
# from the Master's worktree so the session can typecheck and run targeted tests without `pnpm install`.
#   scripts/p3-worktree-bootstrap.sh            # copy node_modules (root, apps/*, packages/*, packages/adapters/*)
# Then: pnpm --filter @nuzm/domain build  (and the other dists your tests import; see docs/phase3/PHASE-3-PLAN.md section 4)
# Own Postgres (never 54329 or 54341): NUZM_PGPORT=<your port> scripts/dev-services.sh start
set -euo pipefail
SRC="${P3_SRC:-/Users/elaf/Projects/nuzm/.claude/worktrees/ai-integration}"
DST="$(cd "$(dirname "$0")/.." && pwd)"
[ "$SRC" != "$DST" ] || { echo "run this in the new worktree, not in the source"; exit 2; }
copy() { # $1 = relative dir that holds a node_modules
  local d="$1"
  [ -d "$SRC/$d/node_modules" ] || return 0
  [ -e "$DST/$d/node_modules" ] && { echo "skip $d (exists)"; return 0; }
  [ -d "$DST/$d" ] || return 0
  cp -cR "$SRC/$d/node_modules" "$DST/$d/node_modules"
  echo "cloned $d/node_modules"
}
copy .
for p in apps/*; do [ -d "$SRC/$p" ] && copy "$p"; done
for p in packages/*; do [ -d "$SRC/$p" ] && copy "$p"; done
for p in packages/adapters/*; do [ -d "$SRC/$p" ] && copy "$p"; done
echo "done. Build the dists your tests import, e.g.: pnpm exec turbo run build --filter='@nuzm/api^...' --concurrency=2"
