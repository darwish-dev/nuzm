#!/usr/bin/env bash
# Self-contained server installer for the GitHub deploy (docs/runbooks/deploy-production.md). Run once, as root, FROM YOUR MAC:
#   ssh root@89.116.29.136 'bash -s' < infra/deploy/install-on-server.sh
# (you type the server password at the ssh prompt; it never goes anywhere else). Idempotent. It: installs Node 22 + rsync (apt),
# creates the unprivileged `deploy` user, /srv/nuzm, the nuzm-* systemd units, a sudo rule that only allows restarting nuzm-*,
# and authorizes the GitHub deploy public key for `deploy`. It does NOT touch nginx, certificates or any existing site.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "apt-get not found: this script targets Ubuntu/Debian" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync curl ca-certificates
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
corepack enable
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "Nuzm deploy" deploy
install -d -o deploy -g deploy -m 755 /srv/nuzm /srv/nuzm/releases
install -d -m 750 -o root -g deploy /etc/nuzm
for f in web admin; do [ -e /etc/nuzm/$f.env ] || install -m 640 -o root -g deploy /dev/null /etc/nuzm/$f.env; done
cat > /etc/systemd/system/nuzm-admin.service <<'UNIT'
[Unit]
Description=Nuzm admin (Next.js)
After=network.target

[Service]
User=deploy
WorkingDirectory=/srv/nuzm/current/apps/admin
EnvironmentFile=/etc/nuzm/admin.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm exec next start -p 3001 -H 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/nuzm-api.service <<'UNIT'
# Enabled only when DEPLOY_API=true (needs a production API entrypoint and production config, D-42).
[Unit]
Description=Nuzm API (NestJS)
After=network.target postgresql.service

[Service]
User=deploy
WorkingDirectory=/srv/nuzm/current/apps/api
EnvironmentFile=/etc/nuzm/api.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/nuzm-web.service <<'UNIT'
[Unit]
Description=Nuzm web (Next.js)
After=network.target

[Service]
User=deploy
WorkingDirectory=/srv/nuzm/current/apps/web
EnvironmentFile=/etc/nuzm/web.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm exec next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/nuzm-worker.service <<'UNIT'
[Unit]
Description=Nuzm Worker
After=network.target postgresql.service

[Service]
User=deploy
WorkingDirectory=/srv/nuzm/current/apps/worker
EnvironmentFile=/etc/nuzm/worker.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/sudoers.d/nuzm-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nuzm-web nuzm-admin, /usr/bin/systemctl restart nuzm-web nuzm-admin nuzm-api nuzm-worker
SUDO
chmod 440 /etc/sudoers.d/nuzm-deploy; visudo -cf /etc/sudoers.d/nuzm-deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qF 'AAAAC3NzaC1lZDI1NTE5AAAAINekM8YYyj8hRO61n67orXK9iWTSflXm68fpjHpBtsY9' /home/deploy/.ssh/authorized_keys || echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINekM8YYyj8hRO61n67orXK9iWTSflXm68fpjHpBtsY9 nuzm-github-deploy' >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys
systemctl daemon-reload
systemctl enable nuzm-web nuzm-admin >/dev/null 2>&1
echo "OK: server ready for GitHub deploys. nginx was not changed."
node -v; id deploy; ls /srv/nuzm
