#!/usr/bin/env bash
# =====================================================================================================================================================================
# NUZM RUNTIME NODE: INSTALL AGENT, PROXY AND UNITS (P3-S02)                                 STATUS: REVIEWED ARTIFACT. NEVER EXECUTED.
# Runs AFTER the reviewed node bootstrap (docs/security/sandbox/bootstrap/node-bootstrap.sh) on the same dedicated node. --plan (default) prints; --apply needs root, Linux and:
#   NUZM_INSTALL_REVIEW_REF   the reviewer's sign-off of THIS file's commit
#   NUZM_AGENT_TARBALL        the built agent as a .tar (packages/runtime-agent dist + its production node_modules, produced by CI)
#   NUZM_AGENT_SHA256         sha256 of that tarball (from the reviewer's own build); verified BEFORE anything is unpacked
#   NUZM_OPERATOR_CIDR, NUZM_CONTROL_PLANE_CIDR, NUZM_AGENT_PORT, NUZM_PROXY_IP (default 10.200.0.1), NUZM_PROXY_PORT (default 3128)
# It installs files and units, loads the static firewall only with NUZM_APPLY_FIREWALL=yes, and does NOT start the agent: the operator writes /etc/nuzm/agent.json (paths + public keys),
# places the TLS material (issued out of band) and starts the units after the inventory matches the attestation template.
# =====================================================================================================================================================================
set -euo pipefail
IFS=$'\n\t'
MODE="plan"; case "${1:-}" in --plan | "") MODE="plan" ;; --apply) MODE="apply" ;; *) echo "usage: $0 [--plan|--apply]" >&2; exit 2 ;; esac
say() { printf '%s\n' "$*"; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
step() { local d="$1"; shift; say "==> ${d}"; say "    \$ $(IFS=' '; echo "$*")"; if [ "${MODE}" = "apply" ]; then "$@"; fi; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_IP="${NUZM_PROXY_IP:-10.200.0.1}"; PROXY_PORT="${NUZM_PROXY_PORT:-3128}"

preflight() {
  if [ "${MODE}" = "plan" ]; then say "== preflight (plan: described, not run): Linux, root, bootstrap already applied (/etc/nuzm/node.json exists and names this node), all variables set, agent tarball sha256 matches, no agent running"; return 0; fi
  [ "$(uname -s)" = "Linux" ] || die "not Linux"
  [ "$(id -u)" = "0" ] || die "must run as root"
  local v; for v in NUZM_INSTALL_REVIEW_REF NUZM_AGENT_TARBALL NUZM_AGENT_SHA256 NUZM_OPERATOR_CIDR NUZM_CONTROL_PLANE_CIDR NUZM_AGENT_PORT; do [ -n "${!v:-}" ] || die "missing ${v}"; done
  [[ "${NUZM_AGENT_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die "NUZM_AGENT_SHA256 is not a sha256 hex digest"
  [ -f /etc/nuzm/node.json ] || die "the node bootstrap has not been applied (/etc/nuzm/node.json missing)"
  ! systemctl is-active --quiet nuzm-runtime-agent || die "an agent is already running: rebuild the node instead of reinstalling over it"
}
install_agent() {
  step "verify the agent tarball checksum BEFORE unpacking (a mismatch is a supply-chain incident: stop)" \
    bash -c "echo '${NUZM_AGENT_SHA256:-0}  ${NUZM_AGENT_TARBALL:-agent.tar}' | sha256sum -c -"
  step "service users (no login): the proxy runs unprivileged; the agent runs as root (see the unit's comment)" \
    bash -c "id nuzm-proxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nuzm-proxy"
  step "unpack the verified agent read-only for non-root" \
    bash -c "install -d -m 0755 /opt/nuzm /opt/nuzm/runtime-agent && tar -xf '${NUZM_AGENT_TARBALL:-agent.tar}' -C /opt/nuzm/runtime-agent --no-same-owner && chown -R root:root /opt/nuzm/runtime-agent && chmod -R go-w /opt/nuzm/runtime-agent"
  step "state, log and runtime directories" \
    bash -c "install -d -m 0700 /var/lib/nuzm/state /run/nuzm/runsc && install -d -m 0750 /var/log/nuzm /etc/nuzm /etc/nuzm/tls"
  step "configuration skeletons (the operator fills paths, fingerprints and PUBLIC keys; no secret is ever written here)" \
    bash -c "install -m 0600 '${HERE}/agent/agent.example.json' /etc/nuzm/agent.json && install -m 0644 '${HERE}/proxy/proxy.example.json' /etc/nuzm/proxy.json"
  step "systemd units (installed and enabled, NOT started)" \
    bash -c "install -m 0644 '${HERE}/systemd/nuzm-proxy-addr.service' '${HERE}/systemd/nuzm-egress-proxy.service' '${HERE}/systemd/nuzm-runtime-agent.service' /etc/systemd/system/ && systemctl daemon-reload && systemctl enable nuzm-proxy-addr nuzm-egress-proxy nuzm-runtime-agent"
}
firewall() {
  local f=/etc/nftables.d/nuzm-sandbox-node.nft
  step "render the static default-deny ruleset from the reviewed template with the signed-off values and syntax-check it" \
    bash -c "install -d -m 0755 /etc/nftables.d && OPERATOR_CIDR='${NUZM_OPERATOR_CIDR:-X}' CONTROL_PLANE_CIDR='${NUZM_CONTROL_PLANE_CIDR:-X}' AGENT_PORT='${NUZM_AGENT_PORT:-X}' PROXY_IP='${PROXY_IP}' PROXY_PORT='${PROXY_PORT}' envsubst < '${HERE}/nftables/nuzm-node.nft' > '${f}' && nft -c -f '${f}'"
  if [ "${NUZM_APPLY_FIREWALL:-no}" = "yes" ]; then step "load the ruleset (risk of locking yourself out: confirm NUZM_OPERATOR_CIDR first)" bash -c "nft -f '${f}'"; else say "==> ruleset syntax-checked only; set NUZM_APPLY_FIREWALL=yes to load it"; fi
}
main() {
  say "NUZM runtime node: install agent | mode=${MODE}"
  preflight; install_agent; firewall
  say "== done. NOT started. Next (manual): fill /etc/nuzm/agent.json and the TLS files; run node-inventory.sh and compare with the attestation template; start nuzm-proxy-addr, nuzm-egress-proxy, nuzm-runtime-agent; qualification has NOT started."
}
main
