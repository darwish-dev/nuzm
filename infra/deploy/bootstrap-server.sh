#!/usr/bin/env bash
# One-time server preparation. Run AS ROOT on the server by the owner, after reading it:
#   sudo bash bootstrap-server.sh
# Creates the unprivileged `deploy` user, the release directories, the systemd units and a sudoers rule that lets
# `deploy` restart ONLY the nuzm-* services. It installs no packages and touches no nginx config.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "Nuzm deploy" deploy
install -d -o deploy -g deploy -m 755 /srv/nuzm /srv/nuzm/releases
install -d -m 750 -o root -g deploy /etc/nuzm
for f in web admin; do [ -e /etc/nuzm/$f.env ] || install -m 640 -o root -g deploy /dev/null /etc/nuzm/$f.env; done
install -m 644 "$here"/systemd/nuzm-*.service /etc/systemd/system/
cat > /etc/sudoers.d/nuzm-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nuzm-web nuzm-admin, /usr/bin/systemctl restart nuzm-web nuzm-admin nuzm-api nuzm-worker
SUDO
chmod 440 /etc/sudoers.d/nuzm-deploy; visudo -cf /etc/sudoers.d/nuzm-deploy
systemctl daemon-reload
systemctl enable nuzm-web nuzm-admin
echo "Next: add the deploy public key to /home/deploy/.ssh/authorized_keys (see docs/runbooks/deploy-production.md)."
