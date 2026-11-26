#!/usr/bin/env bash
# Runs ON the server as the `deploy` user, from the freshly uploaded release: infra/deploy/release.sh <sha>
# Installs dependencies, (optionally) migrates, flips /srv/nuzm/current, restarts the services, health-checks,
# and rolls back to the previous release if a service does not come up. Keeps the last 5 releases.
set -euo pipefail
SHA="${1:?usage: release.sh <sha>}"
ROOT=/srv/nuzm
REL="$ROOT/releases/$SHA"
PREV="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
API="${NUZM_DEPLOY_API:-0}"
SERVICES=(nuzm-web nuzm-admin)
[ "$API" = "1" ] && SERVICES+=(nuzm-api nuzm-worker)

cd "$REL"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

if [ "$API" = "1" ]; then
  # Forward-only migrations (docs/05). DATABASE_ADMIN_URL comes from the root-owned env file, never from the repo.
  set -a; . /etc/nuzm/migrate.env; set +a
  pnpm db:migrate
fi

ln -sfn "$REL" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"
sudo -n systemctl restart "${SERVICES[@]}"

ok=1
check() { for _ in $(seq 1 30); do curl -fsS -o /dev/null "$1" && return 0; sleep 2; done; return 1; }
check http://127.0.0.1:3000/ || ok=0
check http://127.0.0.1:3001/ || ok=0
[ "$API" = "1" ] && { check http://127.0.0.1:4000/healthz || ok=0; }

if [ "$ok" != "1" ]; then
  echo "health check failed" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"
    sudo -n systemctl restart "${SERVICES[@]}" || true
    echo "rolled back to $PREV" >&2
  fi
  exit 1
fi
ls -1dt "$ROOT"/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "deployed $SHA"
