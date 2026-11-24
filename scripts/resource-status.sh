#!/usr/bin/env bash
# Read-only snapshot of the local machine and the scheduler (scripts/heavy-slot.sh). Changes nothing.
DIR="${HEAVY_DIR:-/private/tmp/nuzm-sched}"
echo "== load / memory"
uptime
[ "$(uname -s)" = "Darwin" ] && { sysctl vm.swapusage; vm_stat | sed -n '1,5p'; }
echo "== scheduler ($DIR)"
ls "$DIR" 2>/dev/null | sed 's/^/  /' || echo "  (empty)"
for f in "$DIR"/slot.*; do [ -e "$f" ] && echo "  $(basename "$f"): pid/weight $(cat "$f")"; done
echo "== per-session Postgres (54341 master, 54351-54359 sessions, 54329 owner dev: never touched by sessions)"
for p in 54329 54341 54351 54352 54353 54354 54355 54356 54357 54358 54359; do
  pg_isready -h 127.0.0.1 -p "$p" >/dev/null 2>&1 && echo "  :$p accepting connections"
done
echo "== heaviest processes"
ps -Ao pid,pcpu,rss,etime,command -r | head -8 | cut -c1-150
