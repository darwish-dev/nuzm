#!/usr/bin/env bash
# =====================================================================================================================================================================
# NUZM STAGING NODE INVENTORY (READ-ONLY)                                    STATUS: REVIEWED ARTIFACT. NEVER EXECUTED.
# Prints facts about the node it runs on, for the evidence directory (docs/security/sandbox/evidence/<node-id>/<date>/inventory.txt). It changes nothing, reads no secret, dumps no
# environment, prints no private key or token. Run it on the qualification node by the operator, then give the output to the reviewer, who compares it with the attestation.
# =====================================================================================================================================================================
set -uo pipefail
hdr() { printf '\n## %s\n' "$*"; }
try() { "$@" 2>&1 || printf '(command failed: %s)\n' "$1"; }

hdr "identity"; try cat /etc/nuzm/node.json
hdr "time (UTC)"; date -u +%Y-%m-%dT%H:%M:%SZ
hdr "kernel"; try uname -a
hdr "os"; try cat /etc/os-release
hdr "cpu and virtualization"; try lscpu | grep -E 'Model name|Architecture|^CPU\(s\)|Thread|Virtualization|Hypervisor vendor'
if [ -e /dev/kvm ]; then ls -l /dev/kvm; else echo "no /dev/kvm"; fi
hdr "memory and swap"; try free -m; try cat /proc/swaps
hdr "cgroup"; try stat -fc %T /sys/fs/cgroup; try cat /sys/fs/cgroup/cgroup.controllers
hdr "mounts of interest"; try findmnt -no TARGET,FSTYPE,OPTIONS /var/lib/nuzm/workspaces
hdr "listening sockets (must be sshd and, later, the agent only)"; try ss -H -ltnp | awk '{print $1, $4, $6}'
hdr "container-runtime sockets (must be absent: docker; the containerd socket is local and root-only)"; ls -l /var/run/docker.sock /run/containerd/containerd.sock 2>&1
hdr "runtime versions"; try runsc --version; try containerd --version
hdr "runtime binary checksums"; try sha256sum /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1
hdr "runtime configuration (checksums and content; contains no secret)"; try sha256sum /etc/containerd/config.toml /etc/containerd/runsc.toml; try cat /etc/containerd/runsc.toml
hdr "firewall ruleset (checksum and text)"; try nft list ruleset | sha256sum; try nft list ruleset
hdr "sysctl values"; try sysctl kernel.kptr_restrict kernel.dmesg_restrict kernel.unprivileged_bpf_disabled kernel.yama.ptrace_scope fs.protected_hardlinks fs.protected_symlinks vm.swappiness net.ipv6.conf.all.disable_ipv6
hdr "installed packages of interest"; try dpkg-query -W -f='${Package} ${Version}\n' containerd nftables auditd xfsprogs unattended-upgrades
hdr "users that can log in"; try awk -F: '$7 !~ /(nologin|false)$/ {print $1, $7}' /etc/passwd
hdr "pending security updates"; try apt-get -s upgrade | grep -c '^Inst' 
hdr "metadata address reachability from the node (expected: unreachable)"; try curl -sS -m 3 -o /dev/null -w '%{http_code}\n' http://169.254.169.254/ 
echo; echo "## end of inventory"
