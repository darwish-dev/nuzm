#!/usr/bin/env bash
# nginx + HTTPS for the Nuzm GitHub deploy. Run as root ON THE SERVER (the VPS web console). It arrives with the first deploy:
#
#   bash /srv/nuzm/current/infra/deploy/nginx-https.sh check      read-only: what nginx/certbot/apps look like now
#   AGREE_LE_TOS=yes bash /srv/nuzm/current/infra/deploy/nginx-https.sh admin
#                                                                 admin.nuzm.dev: NEW vhost + Let's Encrypt certificate (touches nothing existing)
#   bash /srv/nuzm/current/infra/deploy/nginx-https.sh www        www.nuzm.dev + nuzm.dev: moves the OLD vhost(s) aside, proxies to the web app
#   bash /srv/nuzm/current/infra/deploy/nginx-https.sh rollback   puts the old www vhost(s) back
#
# Safety: /etc/nginx is archived to /root/nginx-backup-<time>.tgz before any change; `nginx -t` must pass before every reload
# (a failed test restores what the step changed); `www` refuses to run unless the web app answers on 127.0.0.1:3000, and refuses
# if the old vhost also serves other domains. Set CERTBOT_EMAIL=you@example.com to get expiry mails (otherwise none are registered).
set -euo pipefail

MODE="${1:-check}"
TS="$(date +%Y%m%d-%H%M%S)"
CONF_DIR=/etc/nginx/conf.d
WEBROOT=/var/www/letsencrypt
STATE=/root/nuzm-disabled
ADMIN_HOST=admin.nuzm.dev
WWW_NAMES="www.nuzm.dev nuzm.dev"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
command -v nginx >/dev/null || die "nginx is not installed"
command -v python3 >/dev/null || die "python3 is needed to read the nginx configuration"

nginx_dump() { nginx -T 2>/dev/null; }

# "path|names|certificate|key" for every file (other than ours) that serves www.nuzm.dev or nuzm.dev
old_vhosts() {
  nginx_dump | python3 -c '
import os, re, sys
files, cur = {}, None
for line in sys.stdin.read().splitlines():
    m = re.match(r"# configuration file (.+):$", line)
    if m:
        cur = m.group(1); files[cur] = []; continue
    if cur: files[cur].append(line)
mine = {"nuzm.dev", "www.nuzm.dev"}
for path, lines in files.items():
    if os.path.basename(path).startswith("nuzm-app-"): continue
    body = "\n".join(re.sub(r"#.*$", "", l) for l in lines)
    names = set()
    for m in re.finditer(r"\bserver_name\s+([^;]+);", body): names.update(m.group(1).split())
    if not (names & mine): continue
    certs = re.findall(r"\bssl_certificate\s+([^;]+);", body)
    keys = re.findall(r"\bssl_certificate_key\s+([^;]+);", body)
    print("%s|%s|%s|%s" % (path, ",".join(sorted(names)), certs[0].strip() if certs else "", keys[0].strip() if keys else ""))
'
}

backup_nginx() {
  tar czf "/root/nginx-backup-$TS.tgz" /etc/nginx 2>/dev/null
  echo "backup: /root/nginx-backup-$TS.tgz"
}

# nginx -t, then reload; on a failed test run the given undo command and stop
apply() {
  local undo="$1"
  if nginx -t 2>&1; then
    systemctl reload nginx
  else
    echo "nginx -t failed: undoing this step" >&2
    eval "$undo"
    nginx -t >/dev/null 2>&1 || true
    exit 1
  fi
}

conf_dir_included() { nginx_dump | grep -qE 'include\s+/etc/nginx/conf\.d/\*\.conf'; }

# how plain-HTTP requests to each name are answered (code + redirect target); compared before and after the cutover
probe_http() {
  local h
  for h in www.nuzm.dev nuzm.dev; do
    printf '%s %s\n' "$h" "$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' --resolve "$h:80:127.0.0.1" "http://$h/x?y=1" || true)"
  done
}

status_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true; }

case "$MODE" in
check)
  say "nginx"; nginx -v 2>&1
  conf_dir_included && echo "conf.d is included: yes" || echo "conf.d is included: NO (this script needs it; tell the developer)"
  say "vhosts that serve www.nuzm.dev / nuzm.dev now (path|names|certificate|key)"; old_vhosts || true
  say "certbot"; command -v certbot >/dev/null && certbot certificates 2>/dev/null | grep -E "Certificate Name|Domains|Expiry" || echo "certbot not installed"
  say "apps (expect 200/302 after the first deploy; 000 = not running)"
  echo "web   127.0.0.1:3000 -> $(status_code http://127.0.0.1:3000/)"
  echo "admin 127.0.0.1:3001 -> $(status_code http://127.0.0.1:3001/)"
  say "DNS"; getent hosts www.nuzm.dev nuzm.dev "$ADMIN_HOST" || true
  say "firewall"; (command -v ufw >/dev/null && ufw status | head -8) || echo "ufw not installed"
  ;;

admin)
  [ "${AGREE_LE_TOS:-}" = "yes" ] || die "Let's Encrypt's subscriber agreement (https://letsencrypt.org/repository/) must be accepted by you: rerun with AGREE_LE_TOS=yes"
  conf_dir_included || die "/etc/nginx/conf.d is not included by nginx.conf"
  getent hosts "$ADMIN_HOST" >/dev/null || die "$ADMIN_HOST has no DNS record yet"
  # This VPS has IP-specific hosting-panel vhosts: wildcard listeners would lose traffic to them.
  ADMIN_IP="${NUZM_ADMIN_BIND_IP:-$(getent ahostsv4 "$ADMIN_HOST" | awk 'NR == 1 { print $1 }')}"
  [[ "$ADMIN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no IPv4 address for $ADMIN_HOST"
  ip -4 addr show | grep -Fq "inet $ADMIN_IP/" || die "$ADMIN_IP is not a local server address"
  if [ ! -e "$CONF_DIR/nuzm-app-admin.conf" ] && nginx_dump | grep -E 'server_name' | grep -q "$ADMIN_HOST"; then
    die "$ADMIN_HOST is already served by another nginx config; not touching it"
  fi
  command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot; }
  backup_nginx
  mkdir -p "$WEBROOT"
  F="$CONF_DIR/nuzm-app-admin.conf"
  cat > "$F" <<EOF
# Managed by infra/deploy/nginx-https.sh (admin). Step 1: answer the certificate challenge.
server {
  listen $ADMIN_IP:80;
  server_name $ADMIN_HOST;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; }
}
EOF
  apply "rm -f $F"
  say "requesting the certificate for $ADMIN_HOST"
  EMAIL_ARGS=(--register-unsafely-without-email)
  [ -n "${CERTBOT_EMAIL:-}" ] && EMAIL_ARGS=(-m "$CERTBOT_EMAIL")
  certbot certonly --webroot -w "$WEBROOT" -d "$ADMIN_HOST" --non-interactive --agree-tos "${EMAIL_ARGS[@]}" || { rm -f "$F"; nginx -t >/dev/null 2>&1 && systemctl reload nginx; die "certificate request failed (DNS or port 80 not reachable from the internet?)"; }
  cat > "$F" <<EOF
# Managed by infra/deploy/nginx-https.sh (admin). Admin console on 127.0.0.1:3001.
server {
  listen $ADMIN_IP:80;
  server_name $ADMIN_HOST;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen $ADMIN_IP:443 ssl;
  server_name $ADMIN_HOST;
  ssl_certificate     /etc/letsencrypt/live/$ADMIN_HOST/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$ADMIN_HOST/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}
EOF
  apply "rm -f $F"
  say "result"
  curl --noproxy '*' -fsS -o /dev/null --resolve "$ADMIN_HOST:443:$ADMIN_IP" "https://$ADMIN_HOST/ar/login" || die "admin HTTPS check failed"
  echo "https://$ADMIN_HOST/ar/login: HTTPS certificate and page check passed"
  certbot renew --cert-name "$ADMIN_HOST" --dry-run 2>&1 | tail -3
  ;;

www)
  conf_dir_included || die "/etc/nginx/conf.d is not included by nginx.conf"
  [ -z "$(status_code http://127.0.0.1:3000/ | grep -E '^(200|30[0-9])$' || true)" ] && die "the web app does not answer on 127.0.0.1:3000 yet: deploy first (otherwise www.nuzm.dev would show an error)"
  [ -e "$CONF_DIR/nuzm-app-www.conf" ] && die "already cut over ($CONF_DIR/nuzm-app-www.conf exists); use rollback first"
  OLD="$(old_vhosts)"; [ -n "$OLD" ] || die "found no existing vhost for www.nuzm.dev; refusing to guess"
  CERT=""; KEY=""
  while IFS='|' read -r path names cert key; do
    [ "$path" != "/etc/nginx/nginx.conf" ] || die "www.nuzm.dev is defined inside nginx.conf itself; edit it by hand"
    other="$(tr ',' '\n' <<<"$names" | grep -vxE 'nuzm.dev|www.nuzm.dev' || true)"
    [ -z "$other" ] || die "$path also serves other domains ($(echo $other)); not moving it. Edit its www.nuzm.dev block by hand (location / -> proxy_pass http://127.0.0.1:3000)"
    [ -z "$cert" ] || { CERT="$cert"; KEY="$key"; }
  done <<<"$OLD"
  [ -n "$CERT" ] && [ -r "$CERT" ] && [ -r "$KEY" ] || die "no readable certificate/key found in the old vhost; refusing to guess"
  echo "old vhost file(s):"; cut -d'|' -f1 <<<"$OLD" | sed 's/^/  /'
  echo "certificate kept: $CERT"
  PRE="$(probe_http)"
  echo "HTTP routing before:"; echo "$PRE" | sed 's/^/  /'
  backup_nginx
  mkdir -p "$STATE" "$WEBROOT"
  : > "$STATE/MANIFEST-$TS"
  while IFS='|' read -r path _ _ _; do
    dest="$STATE/$(basename "$path").$TS"
    mv "$path" "$dest"
    echo "$path|$dest" >> "$STATE/MANIFEST-$TS"
  done <<<"$OLD"
  ln -sfn "$STATE/MANIFEST-$TS" "$STATE/LATEST"
  F="$CONF_DIR/nuzm-app-www.conf"
  cat > "$F" <<EOF
# Managed by infra/deploy/nginx-https.sh (www). Customer website on 127.0.0.1:3000. The previous vhost(s) are in $STATE.
server {
  listen 80; listen [::]:80;
  server_name $WWW_NAMES;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl http2; listen [::]:443 ssl http2;
  server_name $WWW_NAMES;
  ssl_certificate     $CERT;
  ssl_certificate_key $KEY;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}
EOF
  UNDO="rm -f $F; while IFS='|' read -r o d; do mv \"\$d\" \"\$o\"; done < $STATE/MANIFEST-$TS"
  apply "$UNDO"
  POST="$(probe_http)"
  echo "HTTP routing after:"; echo "$POST" | sed 's/^/  /'
  if [ "$PRE" != "$POST" ]; then
    echo "routing differs from the old vhost: undoing the cutover" >&2
    eval "$UNDO"; nginx -t >/dev/null 2>&1 && systemctl reload nginx
    die "cutover undone; the old www/nuzm.dev vhost is back"
  fi
  say "result"
  echo "https://www.nuzm.dev (via this server) -> $(status_code -k --resolve www.nuzm.dev:443:127.0.0.1 https://www.nuzm.dev/)"
  certbot renew --dry-run >/tmp/nuzm-certbot-dry-run.log 2>&1 && echo "certificate renewal dry run: OK" || echo "WARNING: certificate renewal dry run FAILED (see /tmp/nuzm-certbot-dry-run.log); the cutover itself is fine, but renewal of the existing certificate may need attention"
  echo "If anything looks wrong: bash $0 rollback"
  ;;

rollback)
  M="$STATE/LATEST"; [ -e "$M" ] || die "nothing to roll back (no $M)"
  F="$CONF_DIR/nuzm-app-www.conf"
  backup_nginx
  rm -f "$F"
  while IFS='|' read -r o d; do [ -e "$d" ] && mv "$d" "$o"; done < "$M"
  apply "true"
  rm -f "$M"
  echo "old www vhost(s) restored."
  ;;

*) die "usage: $0 check | admin | www | rollback" ;;
esac
