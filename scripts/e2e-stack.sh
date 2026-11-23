#!/usr/bin/env bash
# A long-lived isolated E2E stack for iterating on specs: `start` once, then `run <playwright args>` as often as needed, then `stop`.
#   scripts/e2e-stack.sh start     free ports, a database of its own, a build for those ports, the three servers in the background
#   scripts/e2e-stack.sh run ...   Playwright against that stack (each run still recreates and migrates the database, like a normal run); e.g. `run --project=ar tests/01-customer.spec.ts`
#   scripts/e2e-stack.sh restart   restarts the servers with the same ports and build, on a fresh migrated database (after a change of e2e/playwright.config.ts environment)
#   scripts/e2e-stack.sh status    ports, database, pid
#   scripts/e2e-stack.sh stop      stops the servers it started, drops the database
# State lives in .dev-data/e2e-stack/ (gitignored). It never touches a process or database it did not create. E2E_PG_PORT selects the cluster (default 54329).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${NUZM_PGBIN:-/usr/local/opt/postgresql@16/bin}"
PGPORT="${E2E_PG_PORT:-${NUZM_PGPORT:-54329}}"
STATE="$ROOT/.dev-data/e2e-stack"; ENVF="$STATE/env"; PIDF="$STATE/pid"
cd "$ROOT"

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
pick() { local p; while :; do p="$(free_port)"; case " $* " in *" $p "*) ;; *) echo "$p"; return;; esac; done; }
alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "${1:-status}" in
  start)
    alive && { echo "e2e-stack: already running"; cat "$ENVF"; exit 0; }
    mkdir -p "$STATE"
    WEB="$(pick)"; ADMIN="$(pick "$WEB")"; API="$(pick "$WEB" "$ADMIN")"; IDP="$(pick "$WEB" "$ADMIN" "$API")"
    DB="nuzm_e2e_stack_$$"
    cat > "$ENVF" <<EOT
E2E_WEB_PORT=$WEB
E2E_ADMIN_PORT=$ADMIN
E2E_API_PORT=$API
E2E_IDP_PORT=$IDP
E2E_DB=$DB
E2E_PG_PORT=$PGPORT
E2E_STORE_DIR=$STATE/store
E2E_REUSE_SERVERS=1
EOT
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin "$DB"
    DATABASE_ADMIN_URL="postgres://nuzm_admin@127.0.0.1:$PGPORT/$DB" pnpm --filter @nuzm/db exec tsx src/cli.ts migrate >/dev/null
    API_ORIGIN="http://127.0.0.1:$API" pnpm --filter @nuzm/web build >/dev/null
    API_ORIGIN="http://127.0.0.1:$API" pnpm --filter @nuzm/admin build >/dev/null
    set -a; . "$ENVF"; set +a
    ( cd e2e && nohup pnpm exec tsx dev-stack.ts > "$STATE/stack.log" 2>&1 & echo $! > "$PIDF" )
    for _ in $(seq 1 600); do grep -q "all servers are up" "$STATE/stack.log" 2>/dev/null && break; sleep 1; done
    grep -q "all servers are up" "$STATE/stack.log" && { echo "e2e-stack: up"; cat "$ENVF"; } || { echo "e2e-stack: did not come up; see $STATE/stack.log"; exit 1; }
    ;;
  run)
    shift; alive || { echo "e2e-stack: not running (start it first)"; exit 2; }
    set -a; . "$ENVF"; set +a
    ( cd e2e && pnpm exec playwright test "$@" )
    ;;
  restart)
    alive || { echo "e2e-stack: not running (start it first)"; exit 2; }
    set -a; . "$ENVF"; set +a
    pkill -TERM -P "$(cat "$PIDF")" 2>/dev/null || true; kill -TERM "$(cat "$PIDF")" 2>/dev/null || true; sleep 3
    for p in "$E2E_WEB_PORT" "$E2E_ADMIN_PORT" "$E2E_API_PORT" "$E2E_IDP_PORT"; do lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true; done
    sleep 2; : > "$STATE/stack.log"
    # a fresh database BEFORE the servers start, so what their start-up writes (dev-mock registrar accounts, ...) is part of the pristine state the specs reset to
    "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin --if-exists --force "${E2E_DB}_tpl" >/dev/null 2>&1 || true
    "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin --if-exists --force "$E2E_DB" >/dev/null 2>&1 || true
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin "$E2E_DB"
    DATABASE_ADMIN_URL="postgres://nuzm_admin@127.0.0.1:$PGPORT/$E2E_DB" pnpm --filter @nuzm/db exec tsx src/cli.ts migrate >/dev/null
    ( cd e2e && nohup pnpm exec tsx dev-stack.ts > "$STATE/stack.log" 2>&1 & echo $! > "$PIDF" )
    for _ in $(seq 1 600); do grep -q "all servers are up" "$STATE/stack.log" 2>/dev/null && break; sleep 1; done
    grep -q "all servers are up" "$STATE/stack.log" && echo "e2e-stack: restarted" || { echo "e2e-stack: did not come up; see $STATE/stack.log"; exit 1; }
    ;;
  status) alive && { echo "running (pid $(cat "$PIDF"))"; cat "$ENVF"; } || echo "not running";;
  stop)
    if [ -f "$ENVF" ]; then set -a; . "$ENVF"; set +a; fi
    if alive; then
      pkill -TERM -P "$(cat "$PIDF")" 2>/dev/null || true; kill -TERM "$(cat "$PIDF")" 2>/dev/null || true; sleep 3
    fi
    # the servers' own children (next, tsx) die with their parent; anything still bound to our ports is ours by construction
    for p in "${E2E_WEB_PORT:-}" "${E2E_ADMIN_PORT:-}" "${E2E_API_PORT:-}" "${E2E_IDP_PORT:-}"; do
      [ -n "$p" ] && lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
    done
    for d in "${E2E_DB:-}" "${E2E_DB:-}_tpl"; do
      [ -n "${E2E_DB:-}" ] && "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin --if-exists --force "$d" >/dev/null 2>&1 || true
    done
    rm -rf "$STATE"; echo "e2e-stack: stopped"
    ;;
  *) echo "usage: $0 start|run|restart|status|stop"; exit 2;;
esac
