#!/usr/bin/env bash
# Shared helpers for the owner-checklist validation scripts (P3-S08). SOURCED, never run directly.
#
# Contract of every script in this folder:
#   * READ-ONLY: it changes nothing on this machine or on any server, creates no account, installs nothing, accepts no licence, calls no paid or metered API,
#     sends no request to any model provider, and never reads or prints a secret value (it reports only "set"/"not set" and shape checks such as length).
#   * Anything that reaches a machine other than this one (ssh, an HTTPS check, DNS) happens only when YOU pass that host as an argument; there are no defaults.
#   * Each check prints one line:  PASS | FAIL | MANUAL | SKIP  <id>  <what>  [-> the exact missing item or the exact thing to look at]
#       PASS    proven by the command's own output
#       FAIL    checked and the prerequisite is missing or wrong (the line names the exact missing item)
#       MANUAL  cannot be proven read-only from here (e.g. a vendor console): the line says exactly where to look; it is never counted as PASS
#       SKIP    not checked because you did not pass the host/option it needs (the line names the option)
#   * Exit status: 0 when nothing FAILED, 1 when at least one check FAILED (add --strict: also 1 when anything was MANUAL or SKIP, i.e. not proven).
set -u
P3_PASS=0; P3_FAIL=0; P3_MANUAL=0; P3_SKIP=0
STRICT=0
pass()   { P3_PASS=$((P3_PASS+1));     printf 'PASS   %-8s %s\n' "$1" "$2"; }
fail()   { P3_FAIL=$((P3_FAIL+1));     printf 'FAIL   %-8s %s  -> %s\n' "$1" "$2" "$3"; }
manual() { P3_MANUAL=$((P3_MANUAL+1)); printf 'MANUAL %-8s %s  -> %s\n' "$1" "$2" "$3"; }
skip()   { P3_SKIP=$((P3_SKIP+1));     printf 'SKIP   %-8s %s  -> %s\n' "$1" "$2" "$3"; }
have()   { command -v "$1" >/dev/null 2>&1; }
# run a command for at most N seconds (macOS has no `timeout`): bounded 120 cmd args...
bounded() { local n="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$n" "$@"; }
# run a command with all output captured; never let it print secrets: callers only pass commands that print versions/state
capture() { "$@" 2>&1; }
summary() {
  printf '\n%s: %d PASS, %d FAIL, %d MANUAL, %d SKIP\n' "${1:-summary}" "$P3_PASS" "$P3_FAIL" "$P3_MANUAL" "$P3_SKIP"
  if [ "$P3_FAIL" -gt 0 ]; then return 1; fi
  if [ "$STRICT" -eq 1 ] && [ $((P3_MANUAL+P3_SKIP)) -gt 0 ]; then return 1; fi
  return 0
}
# option parsing helper: opt_value --name "$@"  prints the value after --name (or nothing)
opt_value() { local n="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$n" ]; then printf '%s' "${2:-}"; return; fi; shift; done; }
has_flag() { local n="$1"; shift; for a in "$@"; do [ "$a" = "$n" ] && return 0; done; return 1; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# true when a path is inside the repository (secrets and approvals files must not be)
in_repo() { case "$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" in "$REPO_ROOT"/*) return 0;; *) return 1;; esac; }
