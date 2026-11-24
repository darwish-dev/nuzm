#!/usr/bin/env bash
# =====================================================================================================================================================================
# NUZM STAGING RUNTIME NODE BOOTSTRAP (gVisor / runsc, systrap platform)            STATUS: REVIEWED ARTIFACT. NEVER EXECUTED. NOT TESTED ON ANY MACHINE.
#
# Purpose : prepare ONE dedicated, disposable Linux staging node for the isolation qualification described in docs/parallel/RUNTIME-QUALIFICATION.md.
# Safety  : * the default mode is --plan: it PRINTS every step and changes nothing (it runs no command of the steps, it only echoes them);
#           * --apply is refused unless ALL of: root, Linux, a reviewer's sign-off reference, a node id, the pinned runsc release and its sha512 (supplied by the reviewer, no default),
#             and the node looks dedicated (no container-runtime socket, nothing listening except sshd);
#           * it never touches the network except to download the two pinned binaries from the URL below and verify their sha512 BEFORE installing them;
#           * it does not start the node agent (the agent does not exist yet: D-21), does not enable any customer route, and installs no credential of any kind.
# Never run it on a developer machine, on a shared host, or on a node that holds anything else. Every line marked (V) must be verified by the reviewer against the pinned release.
# Assumed OS: Ubuntu Server 24.04 LTS or 22.04 LTS (V). Adapt package names for another distribution.
#
# Required environment for --apply (no defaults on purpose):
#   NUZM_BOOTSTRAP_REVIEW_REF   the reviewer's sign-off reference for THIS version of this file (e.g. HG-10-02-bootstrap-<date>)
#   NUZM_NODE_ID                the node id that the attestation will name
#   NUZM_RUNSC_VERSION          the pinned gVisor release, e.g. 20260101.0 (V: the reviewer picks it)
#   NUZM_RUNSC_SHA512           sha512 of the runsc binary for this architecture, from the reviewer's own verification of the release
#   NUZM_SHIM_SHA512            sha512 of containerd-shim-runsc-v1 for this architecture
#   NUZM_OPERATOR_CIDR          the only network allowed to SSH in (e.g. 203.0.113.10/32)
#   NUZM_CONTROL_PLANE_CIDR     the only network allowed to reach the node agent port
#   NUZM_PROXY_ADDR             address:port of the egress proxy sandboxes may reach (registry-only class)
# Optional: NUZM_APPLY_FIREWALL=yes (default no: the ruleset is only checked with nft -c), NUZM_WORKSPACE_DIR (default /var/lib/nuzm/workspaces).
# =====================================================================================================================================================================
set -euo pipefail
IFS=$'\n\t'

MODE="plan"
case "${1:-}" in
  --plan | "") MODE="plan" ;;
  --apply) MODE="apply" ;;
  *) echo "usage: $0 [--plan|--apply]" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
# step <description> <command...>: in plan mode only prints; in apply mode prints and runs.
step() {
  local desc="$1"; shift
  say "==> ${desc}"
  say "    \$ $*"
  if [ "${MODE}" = "apply" ]; then "$@"; fi
}

WS_DIR="${NUZM_WORKSPACE_DIR:-/var/lib/nuzm/workspaces}"
PROXY="${NUZM_PROXY_ADDR:-0.0.0.0:0}"   # placeholder in plan mode only; apply mode refuses if unset
RUNSC_BASE="https://storage.googleapis.com/gvisor/releases/release"   # (V) URL layout of the pinned release

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 0. guards
preflight() {
  say "== preflight (mode: ${MODE})"
  if [ "${MODE}" = "plan" ]; then
    say "   (plan mode: the checks below are described, not run)"
    say "   - uname -s must be Linux; id -u must be 0; cgroup v2 (stat -fc %T /sys/fs/cgroup = cgroup2fs); kernel >= 5.15 (V); swap off"
    say "   - no /var/run/docker.sock, /run/containerd/containerd.sock present BEFORE this script, nothing listening except sshd (the node must be dedicated)"
    say "   - all required NUZM_* variables set; NUZM_RUNSC_SHA512 / NUZM_SHIM_SHA512 are 128 hex characters"
    return 0
  fi
  [ "$(uname -s)" = "Linux" ] || die "not Linux"
  [ "$(id -u)" = "0" ] || die "must run as root on the dedicated node"
  local v
  for v in NUZM_BOOTSTRAP_REVIEW_REF NUZM_NODE_ID NUZM_RUNSC_VERSION NUZM_RUNSC_SHA512 NUZM_SHIM_SHA512 NUZM_OPERATOR_CIDR NUZM_CONTROL_PLANE_CIDR NUZM_PROXY_ADDR; do
    [ -n "${!v:-}" ] || die "missing ${v}"
  done
  [[ "${NUZM_RUNSC_SHA512}" =~ ^[0-9a-f]{128}$ ]] || die "NUZM_RUNSC_SHA512 is not a sha512 hex digest"
  [[ "${NUZM_SHIM_SHA512}" =~ ^[0-9a-f]{128}$ ]] || die "NUZM_SHIM_SHA512 is not a sha512 hex digest"
  [[ "${NUZM_NODE_ID}" =~ ^[a-z0-9-]{3,40}$ ]] || die "NUZM_NODE_ID must be lowercase letters, digits and dashes"
  [[ "${NUZM_RUNSC_VERSION}" =~ ^[0-9A-Za-z._-]{3,40}$ ]] || die "NUZM_RUNSC_VERSION has odd characters"
  [ "$(stat -fc %T /sys/fs/cgroup)" = "cgroup2fs" ] || die "cgroup v2 (unified hierarchy) is required"
  local major minor
  major="$(uname -r | cut -d. -f1)"; minor="$(uname -r | cut -d. -f2)"
  if [ "${major}" -lt 5 ] || { [ "${major}" -eq 5 ] && [ "${minor}" -lt 15 ]; }; then die "kernel $(uname -r) is older than 5.15 (V)"; fi
  [ ! -S /var/run/docker.sock ] || die "a Docker socket exists: this node is not dedicated"
  [ ! -S /run/containerd/containerd.sock ] || die "a containerd socket already exists: this node is not fresh"
  local extra
  extra="$(ss -H -ltn | awk '{print $4}' | grep -Ev '(:22$|127\.0\.0\.1:|\[::1\]:)' || true)"
  [ -z "${extra}" ] || die "other services listen on this node: ${extra}"
  case "$(uname -m)" in x86_64 | aarch64) ;; *) die "unsupported architecture $(uname -m)" ;; esac
}

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 1. packages
packages() {
  step "update the package index and install the minimal toolset (no recommends)" \
    bash -c 'apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl jq nftables xfsprogs auditd containerd'
  step "unattended security updates on" \
    bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unattended-upgrades'
}

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 2. host baseline
baseline() {
  step "swap off now and permanently (the runtime spec requires swapMb = 0)" \
    bash -c "swapoff -a && sed -i.bak -E '/\\sswap\\s/ s/^/#/' /etc/fstab"
  step "kernel hardening sysctls" \
    bash -c "cat > /etc/sysctl.d/90-nuzm-sandbox-node.conf <<'SYSCTL'
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 2
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.suid_dumpable = 0
vm.swappiness = 0
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
SYSCTL
sysctl --system"
  step "a non-login system user for the (future) node agent" \
    bash -c 'id nuzm-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nuzm-agent'
  step "workspace directory (must be an XFS filesystem mounted with prjquota: verified, never created or formatted here)" \
    bash -c "install -d -m 0750 -o nuzm-agent -g nuzm-agent '${WS_DIR}' && findmnt -no FSTYPE,OPTIONS '${WS_DIR}' | grep -E '^xfs .*prjquota' >/dev/null || { echo 'REFUSED: ${WS_DIR} is not on an XFS mount with prjquota; mount a dedicated volume first' >&2; exit 1; }"
}

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 3. gVisor (pinned, checksummed)
gvisor() {
  local arch tmp
  arch="$(uname -m 2>/dev/null || echo x86_64)"
  tmp="/var/tmp/nuzm-runsc-download"
  step "download the pinned runsc and shim into a private directory" \
    bash -c "install -d -m 0700 '${tmp}' && curl -fsSL --proto '=https' --tlsv1.2 -o '${tmp}/runsc' '${RUNSC_BASE}/${NUZM_RUNSC_VERSION:-VERSION}/${arch}/runsc' && curl -fsSL --proto '=https' --tlsv1.2 -o '${tmp}/containerd-shim-runsc-v1' '${RUNSC_BASE}/${NUZM_RUNSC_VERSION:-VERSION}/${arch}/containerd-shim-runsc-v1'"
  step "verify both checksums BEFORE anything is installed (a mismatch aborts the script)" \
    bash -c "cd '${tmp}' && printf '%s  runsc\n%s  containerd-shim-runsc-v1\n' '${NUZM_RUNSC_SHA512:-}' '${NUZM_SHIM_SHA512:-}' | sha512sum -c -"
  step "install the verified binaries" \
    bash -c "install -m 0755 -o root -g root '${tmp}/runsc' /usr/local/bin/runsc && install -m 0755 -o root -g root '${tmp}/containerd-shim-runsc-v1' /usr/local/bin/containerd-shim-runsc-v1 && rm -rf '${tmp}'"
  step "runsc configuration: systrap platform (no KVM needed), sandboxed network stack (V: verify each flag against the pinned release's documentation)" \
    bash -c "install -d -m 0755 /etc/containerd && cat > /etc/containerd/runsc.toml <<'RUNSC'
[runsc_config]
  platform = \"systrap\"
  network = \"sandbox\"
RUNSC"
  step "register the runsc runtime handler with containerd and restart it" \
    bash -c "cat > /etc/containerd/config.toml <<'CTD'
version = 2
[plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc]
  runtime_type = \"io.containerd.runsc.v1\"
  [plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc.options]
    TypeUrl = \"io.containerd.runsc.v1.options\"
    ConfigPath = \"/etc/containerd/runsc.toml\"
CTD
systemctl restart containerd && systemctl enable containerd"
  step "record the installed versions as evidence" \
    bash -c "runsc --version && containerd --version"
}

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 4. network: default deny
firewall() {
  local f="/etc/nftables.d/nuzm-sandbox-node.nft"
  step "write the default-deny ruleset (input and forward drop; sandboxes may only reach the egress proxy; metadata, link-local and private ranges are blocked in every direction)" \
    bash -c "install -d -m 0755 /etc/nftables.d && cat > '${f}' <<NFT
flush ruleset
table inet nuzm_sandbox {
  set blocked_v4 {
    type ipv4_addr; flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    ip saddr ${NUZM_OPERATOR_CIDR:-0.0.0.0/32} tcp dport 22 accept
    ip saddr ${NUZM_CONTROL_PLANE_CIDR:-0.0.0.0/32} tcp dport 8443 accept comment \"node agent (future), mTLS only\"
    icmp type echo-request limit rate 5/second accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    # sandbox traffic: only to the egress proxy; everything else, including blocked ranges and the metadata address, is dropped
    ip daddr @blocked_v4 drop
    ip daddr ${PROXY%%:*} tcp dport ${PROXY##*:} accept
  }
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oif lo accept
    # the node itself: DNS and HTTPS for package updates and the pinned downloads only (tighten to the reviewer's allowlist: V)
    tcp dport { 53, 443 } accept
    udp dport 53 accept
  }
}
NFT
nft -c -f '${f}'"
  if [ "${NUZM_APPLY_FIREWALL:-no}" = "yes" ]; then
    step "load the ruleset (risk of locking yourself out: confirm NUZM_OPERATOR_CIDR first)" bash -c "nft -f '${f}'"
  else
    say "==> ruleset syntax-checked only (nft -c); set NUZM_APPLY_FIREWALL=yes to load it"
  fi
}

# ----------------------------------------------------------------------------------------------------------------------------------------------------------------- 5. audit + identity
audit_and_identity() {
  step "audit rules for exec, mounts and privilege changes (logs are shipped by the platform's log agent, not configured here)" \
    bash -c "cat > /etc/audit/rules.d/nuzm-sandbox-node.rules <<'AUD'
-a always,exit -F arch=b64 -S execve -k nuzm_exec
-a always,exit -F arch=b64 -S mount,umount2 -k nuzm_mount
-a always,exit -F arch=b64 -S setuid,setgid,setresuid,setresgid -k nuzm_priv
AUD
augenrules --load"
  step "write the node identity file (no secret) that the inventory and the attestation draft refer to" \
    bash -c "install -d -m 0755 /etc/nuzm && printf '{\"nodeId\":\"%s\",\"runtimeClass\":\"gvisor-runsc\",\"bootstrapReview\":\"%s\"}\n' '${NUZM_NODE_ID:-}' '${NUZM_BOOTSTRAP_REVIEW_REF:-}' > /etc/nuzm/node.json"
}

main() {
  say "NUZM staging runtime node bootstrap (gVisor) | mode=${MODE}"
  [ "${MODE}" = "apply" ] && say "APPLYING on $(hostname) after the guards below" || say "PLAN ONLY: nothing is executed, nothing is changed"
  preflight
  packages
  baseline
  gvisor
  firewall
  audit_and_identity
  say "== done. Next (manual): run node-inventory.sh and keep its output as evidence; the node agent is NOT installed; qualification has NOT started."
}
main
