#!/usr/bin/env bash
# Checklist section C: servers. READ-ONLY (see lib.sh). It runs ONE fixed read-only command set over ssh on each host you name, in BatchMode (no password prompt, no agent forwarding).
#   C-servers.sh [--runtime-node user@host] [--hosting-node user@host] [--strict]
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
RT="$(opt_value --runtime-node "$@")"; HN="$(opt_value --hosting-node "$@")"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o ForwardAgent=no)
REMOTE='uname -r; nproc; free -g | sed -n 2p; stat -fc %T /sys/fs/cgroup/; if [ -e /dev/kvm ]; then echo kvm=yes; else echo kvm=no; fi; swapon --show --noheadings | wc -l'

check_runtime() {
  local host="$1" out
  out="$(ssh "${SSH_OPTS[@]}" "$host" "$REMOTE" 2>&1)" || { fail C1 "cannot read the runtime node $host over ssh" "check the key, the host key (known_hosts), the operator IP allow-list: $(printf '%s' "$out" | head -1)"; return; }
  local kernel cores mem cg kvm swap
  kernel="$(printf '%s\n' "$out" | sed -n 1p)"; cores="$(printf '%s\n' "$out" | sed -n 2p)"; mem="$(printf '%s\n' "$out" | sed -n 3p | awk '{print $2}')"
  cg="$(printf '%s\n' "$out" | sed -n 4p)"; kvm="$(printf '%s\n' "$out" | sed -n 5p)"; swap="$(printf '%s\n' "$out" | sed -n 6p)"
  local major minor; major="${kernel%%.*}"; minor="${kernel#*.}"; minor="${minor%%.*}"
  if [ "${major:-0}" -gt 6 ] || { [ "${major:-0}" -eq 6 ] && [ "${minor:-0}" -ge 1 ]; }; then pass C1 "runtime node kernel $kernel (>= 6.1)"; else fail C1 "runtime node kernel $kernel is older than 6.1" "install a pinned LTS kernel 6.1 or newer"; fi
  [ "${cores:-0}" -ge 8 ] && pass C2 "runtime node has $cores threads (>= 8)" || fail C2 "runtime node has ${cores:-?} threads" "8 or more threads (4+ physical cores) are required"
  [ "${mem:-0}" -ge 30 ] && pass C3 "runtime node has ${mem} GB RAM (>= 32 GB nominal)" || fail C3 "runtime node has ${mem:-?} GB RAM" "32 GB or more"
  [ "$cg" = "cgroup2fs" ] && pass C4 "cgroup v2 is mounted" || fail C4 "cgroup filesystem is '$cg', not cgroup2fs" "use a distribution/kernel configuration with cgroup v2"
  [ "$kvm" = "kvm=yes" ] && pass C5 "/dev/kvm is present (Firecracker-class runtimes possible)" || manual C5 "/dev/kvm is absent" "needed only if a microVM runtime is wanted; gVisor systrap does not need it"
  [ "${swap:-1}" = "0" ] && pass C6 "no swap is active" || fail C6 "swap is active (${swap:-?} device(s))" "swapoff and remove it (sandbox memory limits must be hard)"
}
check_hosting() {
  local host="$1" out
  out="$(ssh "${SSH_OPTS[@]}" "$host" 'uname -sr; command -v v-list-users >/dev/null 2>&1 && echo hestia=yes || echo hestia=no' 2>&1)" || { fail C7 "cannot read the hosting node $host over ssh" "$(printf '%s' "$out" | head -1)"; return; }
  pass C7 "hosting node reachable: $(printf '%s\n' "$out" | sed -n 1p)"
  printf '%s\n' "$out" | grep -q 'hestia=yes' && pass C8 "HestiaCP command line is present (v-list-users)" || fail C8 "HestiaCP is not installed on the hosting node" "install HestiaCP (HG-06)"
}
have ssh || { fail C0 "ssh is not installed" "install an ssh client"; summary "C servers"; exit $?; }
[ -n "$RT" ] && check_runtime "$RT" || skip C1 "runtime node (C1)" "pass --runtime-node user@host after the server exists (do not buy before D-21 and the budget are approved)"
[ -n "$HN" ] && check_hosting "$HN" || skip C7 "hosting staging node (C3)" "pass --hosting-node user@host after the node exists"
manual C9 "egress proxy and registry mirror (C2)" "reviewer's call whether a VM or a namespace on C1: confirm in docs/security/sandbox/ once it exists"
summary "C servers"; exit $?
