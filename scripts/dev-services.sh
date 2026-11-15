#!/usr/bin/env bash
# Local dev data services WITHOUT containers (macOS 13 cannot run Docker Desktop/OrbStack).
# Runs a throwaway, project-local PostgreSQL cluster and Redis under .dev-data/ (gitignored).
# It never touches any system/Homebrew Postgres server. DEV ONLY: trust auth on 127.0.0.1.
set -euo pipefail
# macOS: postmaster aborts ("became multithreaded") without a valid locale in the environment.
export LC_ALL="${NUZM_LC_ALL:-en_US.UTF-8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.dev-data"
PGBIN="${NUZM_PGBIN:-/usr/local/opt/postgresql@16/bin}"
PGPORT="${NUZM_PGPORT:-54329}"
REDISPORT="${NUZM_REDISPORT:-6390}"
PGDIR="$DATA/pg"; RUNDIR="$DATA/run"; REDISDIR="$DATA/redis"

cmd="${1:-status}"
pg_running() { "$PGBIN/pg_ctl" -D "$PGDIR" status >/dev/null 2>&1; }

pg_start() {
  mkdir -p "$RUNDIR" "$DATA"
  if [ ! -d "$PGDIR" ]; then
    "$PGBIN/initdb" -D "$PGDIR" -U nuzm_admin --auth-local=trust --auth-host=trust -E UTF8 --locale=C >/dev/null
    echo "initialised cluster in $PGDIR"
  fi
  if pg_running; then echo "postgres already running on :$PGPORT"; return; fi
  "$PGBIN/pg_ctl" -D "$PGDIR" -l "$DATA/pg.log" -w \
    -o "-p $PGPORT -k $RUNDIR -c listen_addresses=127.0.0.1" start >/dev/null
  echo "postgres started on 127.0.0.1:$PGPORT"
}
pg_stop() { if pg_running; then "$PGBIN/pg_ctl" -D "$PGDIR" -m fast stop >/dev/null; echo "postgres stopped"; else echo "postgres not running"; fi; }
redis_start() {
  command -v redis-server >/dev/null || { echo "redis-server not installed (brew install redis)"; return 1; }
  mkdir -p "$REDISDIR"
  if redis-cli -p "$REDISPORT" ping >/dev/null 2>&1; then echo "redis already running on :$REDISPORT"; return; fi
  redis-server --port "$REDISPORT" --bind 127.0.0.1 --dir "$REDISDIR" --daemonize yes --save "" --appendonly no \
    --pidfile "$REDISDIR/redis.pid" --logfile "$REDISDIR/redis.log" >/dev/null
  echo "redis started on 127.0.0.1:$REDISPORT"
}
redis_stop() { redis-cli -p "$REDISPORT" shutdown nosave >/dev/null 2>&1 && echo "redis stopped" || echo "redis not running"; }

case "$cmd" in
  start) pg_start; redis_start ;;
  start-pg) pg_start ;;
  stop) pg_stop; redis_stop ;;
  status)
    pg_running && echo "postgres: running on :$PGPORT" || echo "postgres: stopped"
    redis-cli -p "$REDISPORT" ping >/dev/null 2>&1 && echo "redis: running on :$REDISPORT" || echo "redis: stopped"
    ;;
  reset) pg_stop; redis_stop || true; rm -rf "$DATA"; echo "removed $DATA" ;;
  *) echo "usage: $0 start|start-pg|stop|status|reset"; exit 2 ;;
esac
