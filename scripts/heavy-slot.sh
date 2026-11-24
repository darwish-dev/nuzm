#!/usr/bin/env bash
# Machine-wide concurrency limiter for heavy commands (tsc over a whole package, vitest integration, turbo builds, next build, E2E).
# The machine has 4 CPUs and 8 GB; eight parallel sessions pushed the load average past 600 and made a regression time out.
#   /Users/elaf/Projects/nuzm/.claude/worktrees/ai-integration/scripts/heavy-slot.sh <command> [args...]
# waits for a free slot (HEAVY_SLOTS, default 2), runs the command, frees the slot (also on Ctrl-C / failure). Stale slots (dead pid) are reclaimed.
# Light commands (eslint on a file, vitest on one unit file, git) do not need it. The Master's full regression uses /private/tmp/nuzm-heavy.lock instead.
set -uo pipefail
SLOTS="${HEAVY_SLOTS:-2}"
DIR=/private/tmp/nuzm-slots
mkdir -p "$DIR"
[ "$#" -gt 0 ] || { echo "usage: heavy-slot.sh <command> [args...]"; exit 2; }
acquire() {
  local i
  for i in $(seq 1 "$SLOTS"); do
    if mkdir "$DIR/$i" 2>/dev/null; then echo $$ > "$DIR/$i/pid"; echo "$i"; return 0; fi
    local p; p="$(cat "$DIR/$i/pid" 2>/dev/null || true)"
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$DIR/$i"; fi
  done
  return 1
}
MY=""
until MY="$(acquire)"; do sleep 5; done
trap 'rm -rf "$DIR/$MY"' EXIT INT TERM
echo "[heavy-slot] slot $MY acquired; running: $*" >&2
"$@"
