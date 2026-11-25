#!/usr/bin/env bash
# Checklist section H: the state of the Phase 3 evidence. READ-ONLY: runs the evidence verifier and the acceptance matrix (reads docs/phase3/EVIDENCE/**, writes nothing).
#   H-evidence.sh [--strict]
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
CLI="$REPO_ROOT/apps/api/src/qa/evidence/cli.ts"
have pnpm || { fail H0 "pnpm is not installed" "install pnpm 10"; summary "H evidence"; exit $?; }
V="$(cd "$REPO_ROOT/apps/api" && pnpm --silent exec tsx "$CLI" verify 2>&1)"; RC=$?
[ $RC -eq 0 ] && pass H1 "every committed evidence record is accepted by the verifier ($(printf '%s' "$V" | head -1))" || fail H1 "the verifier rejected evidence" "$(printf '%s' "$V" | grep -m1 REJECTED)"
M="$(cd "$REPO_ROOT/apps/api" && pnpm --silent exec tsx "$CLI" matrix 2>&1)"
for T in T1 T2 T3 T4 T5 T6; do
  S="$(printf '%s\n' "$M" | sed -n "s/^| $T | \*\*\([A-Z ]*\)\*\* | \(.*\) |$/\1 (\2)/p")"
  case "$S" in PASS*) pass "$T" "acceptance target $T: $S";; *) fail "$T" "acceptance target $T: ${S:-unknown}" "see docs/phase3/EVIDENCE/ACCEPTANCE-MATRIX.md for the exact blocker per row";; esac
done
summary "H evidence"; exit $?
