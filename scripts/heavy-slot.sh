#!/usr/bin/env bash
# Resource-aware, fair concurrency limiter for HEAVY commands (tsc over a package, vitest integration, turbo/next builds, Playwright, Flutter/Gradle).
#   scripts/heavy-slot.sh [--weight N] <command> [args...]
# Why: the machine has 4 CPUs and 8 GB; eight parallel sessions drove the load average past 600 and swap to 5 of 6 GB, which made a regression time out.
# Rules (all values overridable by environment):
#   * at most HEAVY_SLOTS weighted units run at once machine-wide (default 4; a command's weight defaults to 1: typecheck and single spec runs; builds, Playwright and Flutter pass --weight 2,
#     so two builds, or one build plus two light jobs, run together; the memory gate below still holds everything back when the machine is short of RAM);
#   * FIFO fairness: callers take a numbered ticket and run in ticket order;
#   * admission also waits while the machine is under pressure: swap used > HEAVY_MAX_SWAP_PCT (default 95: macOS keeps stale swap pages for a long time, so the free+inactive memory test is the main gate) or free+inactive memory < HEAVY_MIN_FREE_MB (default 1200);
#     it never waits forever for pressure caused by something else: after HEAVY_MAX_WAIT_S (default 5400) it runs anyway and says so;
#   * stale slots and tickets (dead pid) are reclaimed; the slot is released on exit, Ctrl-C or failure; TMPDIR is untouched.
# State: /private/tmp/nuzm-sched (slot files "slot.<n>" hold "<pid> <weight>", tickets "q.<seq>.<pid>"). Inspect with scripts/resource-status.sh.
set -uo pipefail
DIR="${HEAVY_DIR:-/private/tmp/nuzm-sched}"
SLOTS="${HEAVY_SLOTS:-4}"
MAX_SWAP="${HEAVY_MAX_SWAP_PCT:-95}"
MIN_FREE="${HEAVY_MIN_FREE_MB:-1200}"
MAX_WAIT="${HEAVY_MAX_WAIT_S:-5400}"
WEIGHT=1
if [ "${1:-}" = "--weight" ]; then WEIGHT="${2:-1}"; shift 2; fi
[ "$#" -gt 0 ] || { echo "usage: heavy-slot.sh [--weight N] <command> [args...]"; exit 2; }
[ "$WEIGHT" -le "$SLOTS" ] 2>/dev/null || WEIGHT="$SLOTS"
mkdir -p "$DIR"

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
reap() { # drop slots and tickets of dead processes
  local f p
  for f in "$DIR"/slot.*; do [ -e "$f" ] || continue; p="$(cut -d' ' -f1 "$f" 2>/dev/null)"; alive "$p" || rm -f "$f"; done
  for f in "$DIR"/q.*; do [ -e "$f" ] || continue; p="${f##*.}"; alive "$p" || rm -f "$f"; done
}
used() { local f s=0 w; for f in "$DIR"/slot.*; do [ -e "$f" ] || continue; w="$(cut -d' ' -f2 "$f" 2>/dev/null)"; s=$((s + ${w:-1})); done; echo "$s"; }
pressure() { # prints a reason when the machine is under pressure, nothing otherwise (macOS; silently passes elsewhere)
  [ "$(uname -s)" = "Darwin" ] || return 0
  local swap total used pct free ps
  swap="$(sysctl -n vm.swapusage 2>/dev/null)"
  total="$(echo "$swap" | sed -E 's/.*total = ([0-9.]+)M.*/\1/')"; used="$(echo "$swap" | sed -E 's/.*used = ([0-9.]+)M.*/\1/')"
  if [ -n "$total" ] && [ "${total%.*}" -gt 0 ] 2>/dev/null; then pct=$(( ${used%.*} * 100 / ${total%.*} )); [ "$pct" -gt "$MAX_SWAP" ] && echo "swap ${pct}% > ${MAX_SWAP}%" && return 0; fi
  ps="$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')"
  free="$(vm_stat 2>/dev/null | awk -v ps="${ps:-4096}" '/Pages free|Pages inactive|Pages speculative/ {gsub("\\.","",$NF); s+=$NF} END {print int(s*ps/1048576)}')"
  [ -n "$free" ] && [ "$free" -lt "$MIN_FREE" ] && echo "free+inactive memory ${free} MB < ${MIN_FREE} MB" && return 0
  return 0
}

SEQ="$(printf '%012d' "$(date +%s)")$(printf '%05d' $((RANDOM % 100000)))"
TICKET="$DIR/q.$SEQ.$$"
: > "$TICKET"
SLOT=""
cleanup() { rm -f "$TICKET"; [ -n "$SLOT" ] && rm -f "$SLOT"; }
trap cleanup EXIT INT TERM
START="$(date +%s)"
while :; do
  reap
  first="$(ls "$DIR"/q.* 2>/dev/null | sort | head -n1)"
  if [ "$first" = "$TICKET" ]; then
    if [ $(( $(used) + WEIGHT )) -le "$SLOTS" ] || { [ "$(used)" -eq 0 ] && [ "$WEIGHT" -le "$SLOTS" ]; }; then
      why="$(pressure)"
      if [ -z "$why" ] || [ $(( $(date +%s) - START )) -ge "$MAX_WAIT" ]; then
        [ -n "$why" ] && echo "[heavy-slot] pressure persisted ($why) for ${MAX_WAIT}s: running anyway" >&2
        SLOT="$DIR/slot.$$"; echo "$$ $WEIGHT" > "$SLOT"; rm -f "$TICKET"; break
      fi
    fi
  fi
  sleep 5
done
echo "[heavy-slot] running (weight $WEIGHT): $*" >&2
"$@"
