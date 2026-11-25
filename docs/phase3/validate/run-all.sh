#!/usr/bin/env bash
# One validation pass over the owner checklist (docs/phase3/OWNER-SETUP-CHECKLIST.md). READ-ONLY: runs every section script with the options you give; changes and calls nothing paid.
#   run-all.sh [--build-user U] [--panel URL] [--runtime-node user@host] [--hosting-node user@host]
#              [--preview-domain D] [--expect-ip IP] [--console-domain D] [--tls HOST] [--files-dir DIR] [--target T1..T6] [--strict]
# Sections whose option you do not give report SKIP with the exact option to pass. Exit 1 if any check FAILED (with --strict: or was not proven).
D="$(cd "$(dirname "$0")" && pwd)"
RC=0
pick() { local out=(); local n; for n in "$@"; do local v; v="$(. "$D/lib.sh"; opt_value "$n" "${ARGS[@]}")"; [ -n "$v" ] && out+=("$n" "$v"); done; printf '%s\0' "${out[@]}"; }
ARGS=("$@")
STRICT_FLAG=(); for a in "$@"; do [ "$a" = "--strict" ] && STRICT_FLAG=(--strict); done
opt() { local n="$1" i; for ((i=0;i<${#ARGS[@]};i++)); do [ "${ARGS[$i]}" = "$n" ] && { printf '%s' "${ARGS[$((i+1))]:-}"; return; }; done; }
run() { local s="$1"; shift; printf '\n=== %s ===\n' "$s"; bash "$D/$s" "$@" "${STRICT_FLAG[@]}" || RC=1; }
a=(); v="$(opt --build-user)"; [ -n "$v" ] && a=(--build-user "$v"); run A-build-host.sh "${a[@]}"
a=(); v="$(opt --panel)"; [ -n "$v" ] && a=(--panel "$v"); run B-accounts.sh "${a[@]}"
a=(); v="$(opt --runtime-node)"; [ -n "$v" ] && a+=(--runtime-node "$v"); v="$(opt --hosting-node)"; [ -n "$v" ] && a+=(--hosting-node "$v"); run C-servers.sh "${a[@]}"
a=(); for n in --preview-domain --expect-ip --console-domain --tls; do v="$(opt $n)"; [ -n "$v" ] && a+=("$n" "$v"); done; run D-dns.sh "${a[@]}"
a=(); v="$(opt --files-dir)"; [ -n "$v" ] && a=(--files-dir "$v"); run E-environment.sh "${a[@]}"
a=(); v="$(opt --target)"; [ -n "$v" ] && a=(--target "$v"); run G-approvals.sh "${a[@]}"
run H-evidence.sh
printf '\nOverall: %s\n' "$([ $RC -eq 0 ] && echo 'no check FAILED (MANUAL and SKIP lines are NOT proven: read them)' || echo 'at least one check FAILED')"
exit $RC
