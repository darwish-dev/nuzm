#!/usr/bin/env bash
# The whole Nuzm platform on this machine, one command. DEVELOPMENT ONLY: dev identity provider, mock providers (SIMULATED), loopback addresses.
#   scripts/local-platform.sh start [--skip-build] [--seed-demo]
#                                                    database, build, migrations, API + dev IdP, worker, customer and admin consoles, health check.
#                                                    Demo data, dev staff accounts and development feature flags are added only to a database with no users,
#                                                    or when --seed-demo is given. Existing data is never reseeded. Pending migrations on a database with users
#                                                    are preceded by a dump into .dev-data/platform/backups/.
#   scripts/local-platform.sh stop                   stops only what this script started (processes and its own database cluster)
#   scripts/local-platform.sh status | health        what is running; every health check (exit 1 when one fails)
#   scripts/local-platform.sh logs [api|worker|web|admin|postgres]
#   scripts/local-platform.sh reset --yes            stop, then delete THIS platform's data only (.dev-data/platform), including its database
# Settings (environment): NUZM_PLATFORM_DB (database name, default nuzm_local), NUZM_PLATFORM_{WEB,ADMIN,API,IDP}_PORT, NUZM_PLATFORM_PGPORT.
#   NUZM_PLATFORM_LIVE_PROVIDERS  e.g. "claude": allows REAL, BILLED model calls with the stored key. Unset (the default) = no live call is possible, whatever the
#                                 shell environment holds. Each live call costs money; the owner's approvals (D2..D9) are not recorded by setting this.
# Limits for real model calls (read from the environment of `start`, default in brackets; each only lowers spending, a malformed value stops the API):
#   AI_MAX_OUTPUT_TOKENS        ceiling on the output tokens of every model call [none; a template adaptation asks for 16000]
#   AI_MAX_REPAIR_ATTEMPTS      extra requests when an answer is invalid, 0..2 [2]
#   AI_ATTEMPTS_PER_CANDIDATE   attempts per request on a provider error, >= 1 [2]
#   spending: the organization's AI budget (customer console, AI -> Budgets), its credit balance, and the vendor-side cap of the API key.
# Secrets: the API uses apps/api/.dev-vault of THIS checkout (sealed with its dev-seal-key). A wrong or missing key stops the start; no key is ever replaced.
# Dedicated default ports, so it can run beside other projects: customer 3300, admin 3301, API 4300, dev identity 4310, PostgreSQL 54390.
# Everything it creates lives in .dev-data/platform/ (gitignored). It has its OWN PostgreSQL cluster on its own port: the project's other development
# clusters (including :54329) are never started, stopped, migrated or deleted. It never stops a process it did not start: a busy port is reported.
# Redis is not started: no code in this repository connects to it (the outbox and operation queues are PostgreSQL tables).
set -euo pipefail
export LC_ALL="${NUZM_LC_ALL:-en_US.UTF-8}" # macOS: postmaster aborts without a valid locale

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HOME_DIR="$ROOT/.dev-data/platform"
RUN="$HOME_DIR/run"; LOGS="$HOME_DIR/logs"; PGDIR="$HOME_DIR/pg"; SECRETS="$HOME_DIR/secrets"
PGBIN="${NUZM_PGBIN:-/usr/local/opt/postgresql@16/bin}"
PGPORT="${NUZM_PLATFORM_PGPORT:-54390}"
WEB_PORT="${NUZM_PLATFORM_WEB_PORT:-3300}"
ADMIN_PORT="${NUZM_PLATFORM_ADMIN_PORT:-3301}"
API_PORT="${NUZM_PLATFORM_API_PORT:-4300}"
IDP_PORT="${NUZM_PLATFORM_IDP_PORT:-4310}"
DBNAME="${NUZM_PLATFORM_DB:-nuzm_local}"
[[ "$DBNAME" =~ ^[a-z][a-z0-9_]{0,40}$ ]] || { echo "local-platform: invalid database name" >&2; exit 2; }
WEB="http://127.0.0.1:$WEB_PORT"; ADMIN="http://127.0.0.1:$ADMIN_PORT"
API="http://127.0.0.1:$API_PORT"; IDP="http://127.0.0.1:$IDP_PORT"
ADMIN_DB_URL="postgres://nuzm_admin@127.0.0.1:$PGPORT/$DBNAME"
APP_DB_URL="postgres://nuzm_app:nuzm_dev_only@127.0.0.1:$PGPORT/$DBNAME"
WORKER_DB_URL="postgres://nuzm_worker:nuzm_dev_only@127.0.0.1:$PGPORT/$DBNAME"
SERVICES="api worker web admin"

say() { printf '%s\n' "$*"; }
die() { printf 'local-platform: %s\n' "$*" >&2; exit 1; }
pidfile() { echo "$RUN/$1.pid"; }
alive() { local f; f="$(pidfile "$1")"; [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; }
holder() { { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR==2 {print $1" pid "$2}'; } # lsof exits 1 for a free port: not an error
require_free() { local h; h="$(holder "$1")"; [ -z "$h" ] || die "port $1 ($2) is already used by $h. Stop it yourself, or choose another port with $3=<port>."; }
pg_running() { "$PGBIN/pg_ctl" -D "$PGDIR" status >/dev/null 2>&1; }

preflight() {
  [ "${NODE_ENV:-}" != "production" ] || die "refused: NODE_ENV=production"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)' || die "Node 22 is required (found $(node -v))"
  command -v pnpm >/dev/null || die "pnpm is required"
  [ -x "$PGBIN/pg_ctl" ] || die "PostgreSQL 16 not found in $PGBIN (set NUZM_PGBIN)"
}

secret() { # a random local-only value, created once, readable by this user only; never printed
  local f="$SECRETS/$1"
  [ -f "$f" ] || ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > "$f" )
  cat "$f"
}

start_db() {
  if [ ! -d "$PGDIR" ]; then
    "$PGBIN/initdb" -D "$PGDIR" -U nuzm_admin --auth-local=trust --auth-host=trust -E UTF8 --locale=C >/dev/null
    say "database: new cluster in $PGDIR"
  fi
  if ! pg_running; then
    require_free "$PGPORT" PostgreSQL NUZM_PLATFORM_PGPORT
    "$PGBIN/pg_ctl" -D "$PGDIR" -l "$LOGS/postgres.log" -w -o "-p $PGPORT -k '' -c listen_addresses=127.0.0.1" start >/dev/null
  fi
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DBNAME'" | grep -q 1 \
    || "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin "$DBNAME"
  say "database: PostgreSQL on 127.0.0.1:$PGPORT, database $DBNAME"
}

psql_db() { "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin -d "$DBNAME" -At -c "$1"; }
user_count() { [ "$(psql_db "SELECT to_regclass('identity.users') IS NOT NULL")" = t ] && psql_db "SELECT count(*) FROM identity.users" || echo 0; }

backup_before_migrate() { # only when the database holds users and at least one migration is not applied yet
  [ "$(user_count)" -gt 0 ] || return 0
  local applied pending=0 f ord
  applied=" $(psql_db "SELECT ordinal FROM public.nuzm_migrations" | tr '\n' ' ') "
  while IFS= read -r f; do
    ord="$(basename "$f")"; ord="${ord%%__*}"
    case "$applied" in *" $((10#$ord)) "*) ;; *) pending=$((pending + 1)) ;; esac
  done < <(find packages/db/migrations -name '*.sql' ! -name '*.down.sql')
  [ "$pending" -gt 0 ] || return 0
  local out="$HOME_DIR/backups/$DBNAME-$(date +%Y%m%d-%H%M%S).dump"
  ( umask 077; mkdir -p "$HOME_DIR/backups"; "$PGBIN/pg_dump" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin -d "$DBNAME" -Fc -f "$out" ) || die "backup failed; nothing was migrated"
  "$PGBIN/pg_restore" --list "$out" >/dev/null || die "the backup is not readable; nothing was migrated"
  say "database: $pending pending migration(s); backup written first: $out"
}

prepare_db() {
  backup_before_migrate
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" pnpm --filter @nuzm/db run migrate > "$LOGS/migrate.log" 2>&1 || die "migration failed: see $LOGS/migrate.log"
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" pnpm --filter @nuzm/db exec tsx src/cli.ts dev-logins >> "$LOGS/migrate.log" 2>&1 || die "dev logins failed: see $LOGS/migrate.log"
  say "database: migrated, dev logins set ($(user_count) users present)"
}

build() {
  say "build: all packages and both consoles (a few minutes; log: $LOGS/build.log)"
  # The consoles bake the API origin and the preview frame origin (with its port, or the browser blocks the preview frame) into the build.
  API_ORIGIN="$API" ADMIN_ORIGIN="$ADMIN" BUILDER_PREVIEW_DOMAIN="preview.localhost:$API_PORT" BUILDER_PREVIEW_SCHEME=http \
    pnpm exec turbo run build --force --env-mode=loose --concurrency="${NUZM_BUILD_CONCURRENCY:-2}" > "$LOGS/build.log" 2>&1 || die "build failed: see $LOGS/build.log"
  # turbo's default (strict) mode hides undeclared variables from the build: the consoles would point at the default API (:4000), which may be another project's server
  for app in web admin; do
    grep -qF "\"$API/v1/:path*\"" "apps/$app/.next/routes-manifest.json" || die "the $app console was built for another API address (expected $API): see $LOGS/build.log"
  done
  printf '%s %s %s\n' "$(git rev-parse HEAD)" "$API_PORT" "$ADMIN_PORT" > "$RUN/build.stamp"
  say "build: done"
}

# launch <name> <working dir> <command...>: its own process group (so stop() can end the whole tree), output to logs/<name>.log
launch() {
  local name="$1" dir="$2"; shift 2
  set -m
  ( cd "$dir" && exec nohup "$@" > "$LOGS/$name.log" 2>&1 < /dev/null ) &
  echo $! > "$(pidfile "$name")"
  set +m
}

wait_http() { # <name> <url> <seconds>
  local i
  for i in $(seq 1 "$3"); do
    curl -fsS -o /dev/null --max-time 5 "$2" 2>/dev/null && return 0
    alive "$1" || die "$1 stopped while starting: see $LOGS/$1.log"
    sleep 1
  done
  die "$1 did not answer $2 within $3 s: see $LOGS/$1.log"
}

start_api() {
  alive api && { say "api: already running"; return; }
  require_free "$API_PORT" API NUZM_PLATFORM_API_PORT
  require_free "$IDP_PORT" "dev identity provider" NUZM_PLATFORM_IDP_PORT
  launch api "$ROOT/apps/api" env \
    -u AI_LIVE_PROVIDERS -u AI_PROBE_APPROVALS -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u SESSION_SEAL_KEY \
    AI_LIVE_PROVIDERS="${NUZM_PLATFORM_LIVE_PROVIDERS:-}" \
    NUZM_FORBID_DEFAULT_DB=1 DATABASE_URL="$APP_DB_URL" WORKER_DATABASE_URL="$WORKER_DB_URL" \
    PORT="$API_PORT" DEV_IDP_PORT="$IDP_PORT" WEB_ORIGIN="$WEB" ADMIN_ORIGIN="$ADMIN" \
    PAYMENT_RETURN_URL_ALLOWLIST="$WEB" BUILDER_CONSOLE_ORIGIN="$WEB http://localhost:$WEB_PORT" BUILDER_PREVIEW_PORT="$API_PORT" \
    DEV_IDP_USERS="$DEV_USERS" \
    KNOWLEDGE_STORE_DRIVER=fs KNOWLEDGE_STORE_DIR="$HOME_DIR/knowledge-store" \
    APPBUILDER_GIT_ROOT="$HOME_DIR/appbuilder-git" MOBILE_ARTIFACT_DIR="$HOME_DIR/mobile-artifacts" EXPORT_LOCAL_DIR="$HOME_DIR/exports" \
    AUDIT_CHECKPOINT_KEY="$(secret audit-checkpoint-key)" AUDIT_HASH_KEY="$(secret audit-hash-key)" \
    AI_LOCAL_REFERENCE=true DATA_LOCAL_REFERENCE=true \
    DOMAINS_DEV_MOCKS=true DOMAINS_ENABLED=true DOMAINS_ALLOW_NON_LIVE_REGISTRARS=true DOMAINS_FX_JSON='{"SAR":"1","USD":"3.75","EUR":"4.10"}' \
    ZATCA_MODE=simulation ZATCA_DEV_VAULT_DIR="$HOME_DIR/zatca-vault" ZATCA_ARCHIVE_DIR="$HOME_DIR/zatca-archive" \
    AI_SCHEDULER_INTERVAL_SECONDS=15 DEPLOY_SCHEDULER_INTERVAL_SECONDS=15 HOSTING_SCHEDULER_INTERVAL_SECONDS=30 DATA_SCHEDULER_INTERVAL_SECONDS=30 \
    AUTOMATION_SCHEDULER_INTERVAL_SECONDS=30 DSR_SCHEDULER_INTERVAL_SECONDS=60 OPS_SCHEDULER_INTERVAL_SECONDS=60 BILLING_SCHEDULER_INTERVAL_SECONDS=60 \
    node dist/dev/dev-stack.js
  wait_http api "$API/healthz" "${NUZM_START_TIMEOUT:-240}"
  say "api: $API (dev identity provider: $IDP)"
  if [ -n "${NUZM_PLATFORM_LIVE_PROVIDERS:-}" ]; then say "api: LIVE model calls are ALLOWED for: $NUZM_PLATFORM_LIVE_PROVIDERS (billed)"; else say "api: live model calls are OFF"; fi
}

start_worker() {
  alive worker && { say "worker: already running"; return; }
  launch worker "$ROOT/apps/worker" env \
    NODE_ENV=development WORKER_DATABASE_URL="$WORKER_DB_URL" AUDIT_CHECKPOINT_KEY="$(secret audit-checkpoint-key)" \
    KNOWLEDGE_INGEST_ENABLED=true KNOWLEDGE_DETECT_ENABLED=true KNOWLEDGE_COMPONENTS_ENABLED=true KNOWLEDGE_DESIGN_ENABLED=true KNOWLEDGE_INDEX_ENABLED=true \
    KNOWLEDGE_STORE_DRIVER=fs KNOWLEDGE_STORE_DIR="$HOME_DIR/knowledge-store" \
    node dist/main.js
  local i
  for i in $(seq 1 90); do
    grep -q '"worker":"started"' "$LOGS/worker.log" 2>/dev/null && { say "worker: running"; return; }
    alive worker || die "worker stopped while starting: see $LOGS/worker.log"
    sleep 1
  done
  die "worker did not report started: see $LOGS/worker.log"
}

start_console() { # <web|admin> <port>
  local name="$1" port="$2"
  alive "$name" && { say "$name: already running"; return; }
  require_free "$port" "$name console" "NUZM_PLATFORM_$(echo "$name" | tr '[:lower:]' '[:upper:]')_PORT"
  launch "$name" "$ROOT/apps/$name" env \
    API_ORIGIN="$API" WEB_ORIGIN="$WEB" ADMIN_ORIGIN="$ADMIN" PSP_SANDBOX_UI=true \
    node_modules/.bin/next start -p "$port" -H 127.0.0.1
  wait_http "$name" "http://127.0.0.1:$port/login" "${NUZM_START_TIMEOUT:-240}"
  say "$name: http://127.0.0.1:$port"
}

seed() {
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" pnpm --filter @nuzm/db exec tsx src/cli.ts dev-enable-features >> "$LOGS/migrate.log" 2>&1 || die "feature flags failed: see $LOGS/migrate.log"
  NUZM_SEED_ADMIN_URL="$ADMIN_DB_URL" NUZM_SEED_WEB_ORIGIN="$WEB" NUZM_SEED_IDP_ORIGIN="$IDP" NUZM_SEED_STAFF="$STAFF" \
    node scripts/local-platform-seed.mjs || die "seed failed"
  local org='Nuzm Local Demo'
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" pnpm --filter @nuzm/db exec tsx src/cli.ts dev-seed "$org" > "$LOGS/seed.log" 2>&1 || die "demo data failed: see $LOGS/seed.log"
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" pnpm --filter @nuzm/db exec tsx src/cli.ts dev-seed-cloud "$org" >> "$LOGS/seed.log" 2>&1 || die "cloud catalog seed failed: see $LOGS/seed.log"
  DATABASE_ADMIN_URL="$ADMIN_DB_URL" DATABASE_URL="$APP_DB_URL" pnpm --filter @nuzm/api run grant-ai-credits 500000 "$org" >> "$LOGS/seed.log" 2>&1 || die "AI credits failed: see $LOGS/seed.log"
  say "seed: demo data and AI test credits ready"
}

# The dev identity provider's user picker. These are not real accounts; they have no password.
DEV_USERS='[{"sub":"dev-owner","email":"owner@example.test","name":"Layla Owner (customer)"},{"sub":"dev-viewer","email":"viewer@example.test","name":"Omar Viewer (customer)"},{"sub":"dev-staff","email":"staff@example.test","name":"Sara Staff (admin)"},{"sub":"dev-approver1","email":"approver1@example.test","name":"Huda Security (second approver)"},{"sub":"dev-approver2","email":"approver2@example.test","name":"Faisal Admin (third approver)"},{"sub":"dev-reviewer","email":"reviewer@example.test","name":"Local Reviewer (security role, local testing only)"}]'
STAFF='[{"sub":"dev-staff","email":"staff@example.test","role":"platform_admin"},{"sub":"dev-approver1","email":"approver1@example.test","role":"security"},{"sub":"dev-approver2","email":"approver2@example.test","role":"platform_admin"}]'

health() {
  local bad=0
  check() { # <label> <command...>
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then say "  OK    $label"; else say "  FAIL  $label"; bad=1; fi
  }
  check "PostgreSQL        127.0.0.1:$PGPORT" "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -d "$DBNAME"
  check "API               $API/healthz" curl -fsS --max-time 10 "$API/healthz"
  check "sign-in service   $IDP (issuer, keys, and the API's redirect to it)" node scripts/service-health.mjs signin "$API" "$IDP" "$WEB"
  check "customer console  $WEB/login -> 200 sign-in page" node scripts/service-health.mjs console web "$WEB"
  check "admin console     $ADMIN/login -> /ar/login -> 200 sign-in page" node scripts/service-health.mjs console admin "$ADMIN"
  check "console -> API    $WEB/v1/me answers 401 without a session" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$WEB/v1/me')\" = 401 ]"
  check "console -> API    $ADMIN/v1/me answers 401 without a session" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$ADMIN/v1/me')\" = 401 ]"
  check "worker            process and database session" bash -c "kill -0 \"\$(cat '$(pidfile worker)')\" && [ \"\$('$PGBIN/psql' -h 127.0.0.1 -p $PGPORT -U nuzm_admin -d $DBNAME -Atc \"SELECT count(*)>0 FROM pg_stat_activity WHERE usename='nuzm_worker'\")\" = t ]"
  return $bad
}

urls() {
  cat <<EOT

  Customer console   $WEB/login   (Arabic by default; add ?lang=en for English)
  Admin console      $ADMIN/login
  API                $API      health: $API/healthz
  Dev identity       $IDP

  Sign in: your own accounts (email and password) work as they did in the database they came from.
  Development accounts exist only in a database seeded by this script: choose the identity-provider link on a login page, then pick a user.
    customer  owner@example.test      (organization "Nuzm Local Demo")
    admin     staff@example.test      (platform_admin; the admin console asks you to set up two-factor on first use)
  Stop: scripts/local-platform.sh stop
EOT
}

stop() {
  local name pid i
  for name in admin web worker api; do
    if alive "$name"; then
      pid="$(cat "$(pidfile "$name")")"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for i in $(seq 1 20); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
      kill -KILL -- "-$pid" 2>/dev/null || true
      say "$name: stopped"
    else
      say "$name: not running"
    fi
    rm -f "$(pidfile "$name")"
  done
  if pg_running; then "$PGBIN/pg_ctl" -D "$PGDIR" -m fast stop >/dev/null; say "database: stopped"; else say "database: not running"; fi
}

case "${1:-}" in
  start)
    shift
    skip_build=0; seed_demo=0
    for a in "$@"; do case "$a" in --skip-build) skip_build=1 ;; --seed-demo) seed_demo=1 ;; *) die "unknown option $a" ;; esac; done
    preflight
    mkdir -p "$RUN" "$LOGS" "$SECRETS"; chmod 700 "$HOME_DIR" "$SECRETS"
    for s in $SERVICES; do if alive "$s"; then die "already running: use 'status', or 'stop' first"; fi; done
    require_free "$API_PORT" API NUZM_PLATFORM_API_PORT
    require_free "$IDP_PORT" "dev identity provider" NUZM_PLATFORM_IDP_PORT
    require_free "$WEB_PORT" "customer console" NUZM_PLATFORM_WEB_PORT
    require_free "$ADMIN_PORT" "admin console" NUZM_PLATFORM_ADMIN_PORT
    # every start: a checkout that was updated since the last install may lack new workspace packages (a no-op when up to date)
    pnpm install --frozen-lockfile --prefer-offline > "$LOGS/install.log" 2>&1 || die "dependency install failed: see $LOGS/install.log"
    start_db
    [ "$(user_count)" -gt 0 ] || seed_demo=1
    if [ "$skip_build" = 1 ]; then
      [ "$(cat "$RUN/build.stamp" 2>/dev/null)" = "$(git rev-parse HEAD) $API_PORT $ADMIN_PORT" ] || die "--skip-build refused: the last build was not made for this commit and these ports"
    else build; fi
    prepare_db
    start_api
    start_worker
    start_console web "$WEB_PORT"
    start_console admin "$ADMIN_PORT"
    if [ "$seed_demo" = 1 ]; then seed; else say "seed: skipped (existing data is left as it is)"; fi
    say ""; say "health:"; health || die "a health check failed"
    urls
    ;;
  stop) stop ;;
  status)
    pg_running && say "database: running on :$PGPORT" || say "database: stopped"
    for s in $SERVICES; do alive "$s" && say "$s: running (pid $(cat "$(pidfile "$s")"))" || say "$s: stopped"; done
    ;;
  health) health ;;
  logs)
    f="$LOGS/${2:-api}.log"; [ -f "$f" ] || die "no log $f"; tail -n "${NUZM_LOG_LINES:-100}" "$f" ;;
  reset)
    [ "${2:-}" = "--yes" ] || die "reset deletes this local platform's database and files ($HOME_DIR). Run: $0 reset --yes"
    stop; rm -rf "$HOME_DIR"; say "removed $HOME_DIR" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
