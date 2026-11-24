#!/usr/bin/env bash
# Browser E2E on ports and a database of its own, so it can run beside a dev stack (or another session's servers) without touching any of it.
#  - picks four free ports (web, admin, API, identity provider);
#  - creates a throw-away database on the project-local Postgres cluster and migrates it (Playwright starts the API before its own global setup, so it must exist);
#  - rebuilds both consoles for those ports (the API origin is baked into the build; set E2E_SKIP_BUILD=1 to reuse a build made for the same ports);
#  - runs Playwright (extra arguments are passed on, e.g. `pnpm test:e2e:isolated tests/17-ai-generation.spec.ts`);
#  - drops the database and the object-store directory on exit, whatever the result.
# It never stops or reuses a process it did not start, and it never touches a database it did not create. NOTE: the rebuild replaces `.next` in apps/web and apps/admin
# of THIS checkout: do not run it while a `next dev` of this same checkout is serving from there.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${NUZM_PGBIN:-/usr/local/opt/postgresql@16/bin}"
PGPORT="${E2E_PG_PORT:-${NUZM_PGPORT:-}}"
cd "$ROOT"
[ -n "$PGPORT" ] || { echo "e2e-isolated: E2E_PG_PORT (or NUZM_PGPORT) is mandatory: acquire an isolated test environment (node scripts/testenv/testenv.mjs acquire); there is no default database"; exit 2; }
node "$ROOT/scripts/testenv/testenv.mjs" check-url "postgres://nuzm_admin@127.0.0.1:$PGPORT/postgres" || exit $?

[ -x "$PGBIN/createdb" ] || { echo "e2e-isolated: no createdb in $PGBIN (set NUZM_PGBIN)"; exit 2; }
"$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 || { echo "e2e-isolated: no Postgres on 127.0.0.1:$PGPORT (pnpm services:start, or set E2E_PG_PORT)"; exit 2; }

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
pick() { local p; while :; do p="$(free_port)"; case " $* " in *" $p "*) ;; *) echo "$p"; return;; esac; done; }
# ports: free ones unless E2E_*_PORT are given (then they must be free: the preflight checks); a reused build (E2E_SKIP_BUILD=1) is valid only for the same ports
WEB="${E2E_WEB_PORT:-$(pick)}"; ADMIN="${E2E_ADMIN_PORT:-$(pick "$WEB")}"; API="${E2E_API_PORT:-$(pick "$WEB" "$ADMIN")}"; IDP="${E2E_IDP_PORT:-$(pick "$WEB" "$ADMIN" "$API")}"
DB="nuzm_e2e_iso_$$"
STORE="$(node -e "console.log(require('os').tmpdir())")/nuzm-e2e-knowledge-$DB"

cleanup() {
  "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin --if-exists --force "$DB" >/dev/null 2>&1 || true
  "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin --if-exists --force "${DB}_tpl" >/dev/null 2>&1 || true
  rm -rf "$STORE"
}
trap cleanup EXIT

echo "e2e-isolated: web :$WEB admin :$ADMIN api :$API idp :$IDP database $DB (Postgres :$PGPORT)"
"$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U nuzm_admin "$DB"
DATABASE_ADMIN_URL="postgres://nuzm_admin@127.0.0.1:$PGPORT/$DB" pnpm --filter @nuzm/db exec tsx src/cli.ts migrate >/dev/null

if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
  API_ORIGIN="http://127.0.0.1:$API" pnpm --filter @nuzm/web build >/dev/null
  API_ORIGIN="http://127.0.0.1:$API" pnpm --filter @nuzm/admin build >/dev/null
fi

E2E_WEB_PORT="$WEB" E2E_ADMIN_PORT="$ADMIN" E2E_API_PORT="$API" E2E_IDP_PORT="$IDP" \
E2E_DB="$DB" E2E_PG_PORT="$PGPORT" E2E_STORE_DIR="$STORE" \
  pnpm --filter @nuzm/e2e run e2e "$@"
