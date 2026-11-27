#!/usr/bin/env bash
# Run as root with AGREE_LE_TOS=yes after reviewing Let's Encrypt's subscriber agreement.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
[ "${AGREE_LE_TOS:-}" = yes ] || { echo 'Set AGREE_LE_TOS=yes after reviewing https://letsencrypt.org/repository/'; exit 1; }
install -d /etc/systemd/system/nuzm-admin.service.d
cat > /etc/systemd/system/nuzm-admin.service.d/loopback.conf <<'UNIT'
[Service]
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
ExecStart=
ExecStart=/usr/bin/env pnpm exec next start -p 3001 -H localhost
UNIT
systemctl daemon-reload
systemctl restart nuzm-admin
ready=0
for attempt in $(seq 1 30); do
  if curl --noproxy '*' -fsS -o /dev/null http://127.0.0.1:3001/ar/login; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo 'Admin service did not start; inspect journalctl -u nuzm-admin'; exit 1; }
bash /srv/nuzm/current/infra/deploy/nginx-https.sh admin
