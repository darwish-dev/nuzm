#!/usr/bin/env bash
# Checklist section E: environment variables of ONE named non-production environment. READ-ONLY (see lib.sh). It reads the variables of the CURRENT shell and prints only
# "set"/"not set" and shape checks (length, JSON validity, caps). It NEVER prints a value.
#   E-environment.sh [--expect live-provider,runtime,mobile] [--files-dir ~/nuzm-live] [--strict]
# A variable that is not set is SKIP ("not needed yet") unless you say that step is due with --expect: then it is a FAIL naming the variable.
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
FILES="$(opt_value --files-dir "$@")"; EXPECT="$(opt_value --expect "$@")"
due() { case ",$EXPECT," in *",$1,"*) return 0;; esac; return 1; }
unset_var() { if due "$1"; then fail "$2" "$3" "$4"; else skip "$2" "$3" "$4"; fi; }

if [ "${NODE_ENV:-}" = "production" ]; then fail E0 "NODE_ENV is production in this shell" "live qualification variables are set in ONE non-production environment only"; else pass E0 "NODE_ENV is not production (${NODE_ENV:-unset})"; fi
# E1 live gate: exactly 'claude', only after the provider path is decided
case "${AI_LIVE_PROVIDERS:-}" in
  '') unset_var live-provider E1 "AI_LIVE_PROVIDERS" "not set: correct until D2, D4, D5, D6 are recorded; set to exactly 'claude' as the LAST step of the provider path (D3)" ;;
  claude) pass E1 "AI_LIVE_PROVIDERS is set to claude (the live gate is OPEN in this shell: paid calls are possible)" ;;
  *) fail E1 "AI_LIVE_PROVIDERS is set to an unexpected provider list" "it must be exactly 'claude' (D11: no other provider is approved)" ;;
esac
# E2 probe approvals: valid JSON, each entry carries the caps
if [ -z "${AI_PROBE_APPROVALS:-}" ]; then unset_var live-provider E2 "AI_PROBE_APPROVALS" "not set: set it with D9 (one JSON line: ref, approvedBy, environment non-production, maxRequests, maxTotalTokens)"
elif have node; then
  R="$(node -e '
    try { const a = JSON.parse(process.env.AI_PROBE_APPROVALS); if (!Array.isArray(a) || a.length === 0) throw new Error("not a non-empty array");
      for (const e of a) { for (const k of ["ref","approvedBy","environment","maxRequests","maxTotalTokens"]) if (e[k] === undefined || e[k] === "") throw new Error("missing " + k);
        if (e.environment !== "non-production") throw new Error("environment must be non-production");
        if (!(e.maxRequests > 0 && e.maxRequests <= 13)) throw new Error("maxRequests must be 1..13 (the D9 plan)");
        if (!(e.maxTotalTokens > 0 && e.maxTotalTokens <= 14716)) throw new Error("maxTotalTokens must be 1..14716 (the D9 plan)"); }
      console.log("ok"); } catch (x) { console.log("bad: " + x.message); }' 2>&1)"
  [ "$R" = "ok" ] && pass E2 "AI_PROBE_APPROVALS is valid JSON with refs and caps inside the D9 plan" || fail E2 "AI_PROBE_APPROVALS is invalid ($R)" "one JSON line per LIVE-PROVIDER-PLAN.md section 9"
else fail E2 "node is not installed" "install Node 22"; fi
# E3 seal key: length only (base64 of 32 random bytes is 44 characters)
if [ -z "${SESSION_SEAL_KEY:-}" ]; then unset_var live-provider E3 "SESSION_SEAL_KEY" "not set: generate it yourself (openssl rand -base64 32), keep it in your own shell/secret store"
else
  L=${#SESSION_SEAL_KEY}
  [ "$L" -ge 43 ] && pass E3 "SESSION_SEAL_KEY is set (length $L, value not shown)" || fail E3 "SESSION_SEAL_KEY is set but only $L characters long" "at least 43 characters (openssl rand -base64 32 gives 44)"
fi
[ -n "${NUZM_QUALIFICATION_APPROVED:-}" ] && pass E4 "NUZM_QUALIFICATION_APPROVED is set (a runtime qualification run is authorised in this shell)" || unset_var runtime E4 "NUZM_QUALIFICATION_APPROVED" "not set: correct until D-21/HG-10-02 authorise a run; then your approval reference"
[ "${MOBILE_FLUTTER_LOCAL:-}" = "1" ] && pass E5 "MOBILE_FLUTTER_LOCAL=1 (Flutter local tests enabled in this shell)" || unset_var mobile E5 "MOBILE_FLUTTER_LOCAL" "not set: set to 1 only for the Flutter local tests in the isolated build environment (after B-Android)"
# E6 no secret-looking variable names are exported with values that look like keys (names only)
BAD="$(env | grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|STRIPE_SECRET_KEY)=' | cut -d= -f1 | tr '\n' ' ')"
[ -z "$BAD" ] && pass E6 "no provider API key is exported as an environment variable in this shell" || fail E6 "provider key variable(s) exported in this shell: $BAD" "keys are typed into the admin console only; unset them"
# E7 files outside the repository
if [ -n "$FILES" ]; then
  if in_repo "$FILES/approval.json"; then fail E7 "$FILES is inside the repository" "keep approval.json and evidence.json outside the repository (for example ~/nuzm-live)"
  else
    for f in approval.json evidence.json; do
      if [ -f "$FILES/$f" ]; then
        MODE="$(stat -f %Lp "$FILES/$f" 2>/dev/null || stat -c %a "$FILES/$f" 2>/dev/null)"
        [ "$MODE" = "600" ] && pass E7 "$FILES/$f exists with mode 600" || fail E7 "$FILES/$f has mode $MODE" "chmod 600 $FILES/$f"
      else skip E7 "$FILES/$f" "not present yet (formats: LIVE-PROVIDER-PLAN.md section 9.1)"; fi
    done
  fi
else skip E7 "approval.json / evidence.json outside the repository" "pass --files-dir ~/nuzm-live"; fi
summary "E environment"; exit $?
