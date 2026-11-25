#!/usr/bin/env bash
# Nuzm hosting node setup: the repeatable step AFTER HestiaCP is installed (docs/runbooks/node-onboarding.md, ADR-067/068).
#
# What it does (every command is a documented Hestia CLI command, https://hestiacp.com/docs/reference/cli; NOT VERIFIED on a real node until the owner runs it):
#   1. checks Hestia is there and prints its version (and the OS) for the node record;
#   2. creates one Hestia PACKAGE per plan from the .pkg files the admin console serves (GET /v1/admin/hosting/node-packages)   -> v-add-user-package
#   3. installs the access-key PROFILE (the platform's allow-list of commands) and creates ONE access key for it               -> v-add-access-key
#   4. enables the REST API and allows ONLY the platform's addresses (never allow-all)                                        -> v-change-sys-api / v-add-sys-api-ip
#   5. points Hestia's backups at the region's off-server backup host                                                         -> v-add-backup-host
#   6. (optional) removes Hestia's own nightly backup job, so the platform's schedule is the only one                         -> v-list-cron-jobs / v-delete-cron-job
#   7. hides other users' processes from a site's account (hidepid=2): WP-CLI arguments are briefly visible in the process list
# It never prints a secret. The new access key is written to a root-only file; you type it ONCE into the admin console (Hosting > Servers > panel) and delete the file.
# Re-running changes nothing that is already right. `--dry-run` prints the commands without running them.
set -euo pipefail

HESTIA_BIN="${HESTIA_BIN:-/usr/local/hestia/bin}"
HESTIA_DATA="${HESTIA_DATA:-/usr/local/hestia/data}"
PROFILE_NAME="nuzm-hosting"
DRY=0; REWRITE=0; DISABLE_NIGHTLY=0
PKG_DIR=""; PROFILE_FILE=""; ALLOW_IPS=""
BH_TYPE=""; BH_HOST=""; BH_USER=""; BH_PASS_FILE=""; BH_PATH=""; BH_PORT=""
KEY_OUT="/root/nuzm-access-key.txt"

usage() {
  cat <<USAGE
usage: node-setup.sh --packages-dir DIR --access-profile FILE --allow-ip IP[,IP...]
                     --backup-host-type sftp|ftp|rclone --backup-host HOST --backup-user USER --backup-password-file FILE [--backup-path PATH] [--backup-port PORT]
                     [--rewrite-packages] [--disable-hestia-nightly-backups] [--key-out FILE] [--dry-run]
USAGE
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --packages-dir) PKG_DIR="$2"; shift 2 ;;
    --access-profile) PROFILE_FILE="$2"; shift 2 ;;
    --allow-ip) ALLOW_IPS="$2"; shift 2 ;;
    --backup-host-type) BH_TYPE="$2"; shift 2 ;;
    --backup-host) BH_HOST="$2"; shift 2 ;;
    --backup-user) BH_USER="$2"; shift 2 ;;
    --backup-password-file) BH_PASS_FILE="$2"; shift 2 ;;
    --backup-path) BH_PATH="$2"; shift 2 ;;
    --backup-port) BH_PORT="$2"; shift 2 ;;
    --rewrite-packages) REWRITE=1; shift ;;
    --disable-hestia-nightly-backups) DISABLE_NIGHTLY=1; shift ;;
    --key-out) KEY_OUT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$PKG_DIR" ] && [ -n "$PROFILE_FILE" ] && [ -n "$ALLOW_IPS" ] || usage
[ -n "$BH_TYPE" ] && [ -n "$BH_HOST" ] && [ -n "$BH_USER" ] && [ -n "$BH_PASS_FILE" ] || usage
# a literal address or CIDR list only: nothing that could be a shell fragment
[[ "$ALLOW_IPS" =~ ^[0-9a-fA-F:./,]+$ ]] || { echo "--allow-ip must be a comma separated list of addresses" >&2; exit 2; }
[[ "$BH_TYPE" =~ ^(sftp|ftp|rclone)$ ]] || { echo "--backup-host-type must be sftp, ftp or rclone" >&2; exit 2; }
[[ "$BH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "--backup-host is not a host name" >&2; exit 2; }
[[ "$BH_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--backup-user is not a user name" >&2; exit 2; }
[ -z "$BH_PORT" ] || [[ "$BH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "--backup-port is not a port" >&2; exit 2; }
[ -z "$BH_PATH" ] || [[ "$BH_PATH" =~ ^/[A-Za-z0-9._/-]*$ ]] || { echo "--backup-path must be an absolute path" >&2; exit 2; }
[ -d "$PKG_DIR" ] || { echo "--packages-dir is not a directory" >&2; exit 2; }
[ -f "$PROFILE_FILE" ] || { echo "--access-profile is not a file" >&2; exit 2; }
[ -f "$BH_PASS_FILE" ] || { echo "--backup-password-file is not a file" >&2; exit 2; }
if [ "$DRY" = 0 ]; then
  [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
  perm="$(stat -c '%a' "$BH_PASS_FILE" 2>/dev/null || stat -f '%Lp' "$BH_PASS_FILE")"
  [ "$perm" = 600 ] || { echo "the backup password file must be mode 600" >&2; exit 1; }
fi

say() { printf '%s\n' "$*"; }
# run a Hestia command (never echoing arguments that carry secrets: callers pass SECRET=1)
hv() {
  local cmd="$1"; shift
  if [ "$DRY" = 1 ]; then say "[dry-run] $cmd ${HV_SHOW:-$*}"; return 0; fi
  "$HESTIA_BIN/$cmd" "$@"
}

# 1. Hestia ---------------------------------------------------------------------------------------------------------------------
[ -x "$HESTIA_BIN/v-list-sys-info" ] || { echo "HestiaCP is not installed here ($HESTIA_BIN/v-list-sys-info missing): install it first (S04 cloud-init or the runbook)" >&2; exit 1; }
say "== HestiaCP"
"$HESTIA_BIN/v-list-sys-info" plain | head -n 3 || true
[ -r /etc/os-release ] && . /etc/os-release && say "OS: ${PRETTY_NAME:-unknown}"

# 2. packages --------------------------------------------------------------------------------------------------------------------
say "== packages"
existing="$("$HESTIA_BIN/v-list-user-packages" plain 2>/dev/null | awk '{print $1}' || true)"
shopt -s nullglob
count=0
for f in "$PKG_DIR"/*.pkg; do
  name="$(basename "$f" .pkg)"
  [[ "$name" =~ ^[A-Za-z0-9_.-]{1,40}$ ]] || { echo "refusing package file name: $name" >&2; exit 1; }
  count=$((count+1))
  if printf '%s\n' "$existing" | grep -qx "$name" && [ "$REWRITE" = 0 ]; then say "package $name exists (use --rewrite-packages to replace)"; continue; fi
  hv v-add-user-package "$f" "$name" yes
  say "package $name written"
done
[ "$count" -gt 0 ] || { echo "no .pkg files in $PKG_DIR" >&2; exit 1; }

# 3. access-key profile and key ---------------------------------------------------------------------------------------------------
say "== access key"
profile_dst="$HESTIA_DATA/api/$PROFILE_NAME"
if [ "$DRY" = 1 ]; then
  say "[dry-run] install profile $PROFILE_FILE -> $profile_dst"
elif ! cmp -s "$PROFILE_FILE" "$profile_dst" 2>/dev/null; then
  install -m 0644 -o root -g root "$PROFILE_FILE" "$profile_dst"
  say "profile $PROFILE_NAME installed"
else
  say "profile $PROFILE_NAME already current"
fi
if [ "$DRY" = 1 ]; then
  say "[dry-run] v-add-access-key admin $PROFILE_NAME nuzm-control-plane json  -> $KEY_OUT (mode 600)"
elif [ -s "$KEY_OUT" ]; then
  say "an access key file already exists ($KEY_OUT): not creating a second key"
else
  umask 077
  # the CLI prints the key as JSON; it goes to the file, never to this terminal
  "$HESTIA_BIN/v-add-access-key" admin "$PROFILE_NAME" nuzm-control-plane json > "$KEY_OUT"
  chmod 600 "$KEY_OUT"
  say "access key written to $KEY_OUT: type it once into the admin console, then shred the file"
fi

# 4. REST API and its source addresses ----------------------------------------------------------------------------------------------
say "== API"
hv v-change-sys-api enable
IFS=',' read -r -a ips <<< "$ALLOW_IPS"
for ip in "${ips[@]}"; do hv v-add-sys-api-ip "$ip"; done

# 5. off-server backup host --------------------------------------------------------------------------------------------------------
say "== backup host ($BH_TYPE $BH_HOST)"
if [ "$DRY" = 1 ]; then
  say "[dry-run] v-add-backup-host $BH_TYPE $BH_HOST $BH_USER <password from file> ${BH_PATH:-} ${BH_PORT:-}"
else
  # the password is read from the root-only file; it is an argument of the CLI for the instant it runs (hidepid below keeps it from other users)
  "$HESTIA_BIN/v-add-backup-host" "$BH_TYPE" "$BH_HOST" "$BH_USER" "$(cat "$BH_PASS_FILE")" ${BH_PATH:+"$BH_PATH"} ${BH_PORT:+"$BH_PORT"}
fi

# 6. Hestia's own nightly backup job --------------------------------------------------------------------------------------------------
if [ "$DISABLE_NIGHTLY" = 1 ]; then
  say "== nightly backup job"
  if [ "$DRY" = 1 ]; then
    say "[dry-run] remove admin cron jobs that run v-backup-users"
  else
    "$HESTIA_BIN/v-list-cron-jobs" admin plain | awk '/v-backup-users/ {print $1}' | while read -r id; do
      [ -n "$id" ] && "$HESTIA_BIN/v-delete-cron-job" admin "$id" && say "removed cron job $id"
    done
  fi
fi

# 7. hide other accounts' processes ---------------------------------------------------------------------------------------------------
say "== /proc hidepid"
if [ "$DRY" = 1 ]; then
  say "[dry-run] mount -o remount,hidepid=2 /proc and persist it in /etc/fstab"
else
  mount -o remount,hidepid=2 /proc 2>/dev/null || say "warning: could not remount /proc with hidepid=2 (container or kernel): do it by hand"
  grep -qE '^proc[[:space:]]+/proc[[:space:]]+proc[[:space:]].*hidepid=2' /etc/fstab || echo 'proc /proc proc defaults,hidepid=2 0 0' >> /etc/fstab
fi

say "== done: the node is configured but NOT VERIFIED. Next: type the access key into Hosting > Servers > panel, run the connection test (inventory), then the live checks of docs/runbooks/node-onboarding.md."
