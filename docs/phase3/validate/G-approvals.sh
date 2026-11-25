#!/usr/bin/env bash
# Checklist section G: security and legal approvals recorded with a reference in docs/parallel/OWNER-APPROVAL-PACK.md section 6. READ-ONLY (it reads that one file).
#   G-approvals.sh [--target T1|T2|T3|T4|T5|T6|X] [--strict]
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
T="$(opt_value --target "$@")"
have pnpm || { fail G0 "pnpm is not installed" "install pnpm 10"; summary "G approvals"; exit $?; }
OUT="$(cd "$REPO_ROOT/apps/api" && pnpm --silent exec tsx "$REPO_ROOT/docs/phase3/validate/approvals-check.ts" ${T:+--target "$T"} 2>&1)" || { fail G0 "could not read the decision log" "$(printf '%s' "$OUT" | tail -1)"; summary "G approvals"; exit $?; }
while IFS="$(printf '\t')" read -r st id what hint; do
  case "$st" in PASS) pass "$id" "$what";; FAIL) fail "$id" "$what" "$hint";; esac
done <<EOT
$OUT
EOT
summary "G approvals"; exit $?
