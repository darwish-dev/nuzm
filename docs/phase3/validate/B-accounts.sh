#!/usr/bin/env bash
# Checklist section B: accounts and credentials. READ-ONLY (see lib.sh). Vendor consoles cannot be read from here, so most rows are MANUAL: they say exactly where to look.
#   B-accounts.sh [--panel https://<node>:<panel-port>] [--strict]
# The only network call is the optional --panel one: a single HEAD request to YOUR node, printing the HTTP status code only.
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
PANEL="$(opt_value --panel "$@")"

manual B1 "Anthropic dedicated non-production workspace, key, monthly limit USD 5 (D4)" "Vendor Console: workspace is not 'Default', limit is USD 5/month, one key inside it; Nuzm admin console: AI > Model providers > Claude shows a vault reference and the provider disabled"
manual B2 "agreement and data terms (D2), region statement (D5), rate card (D6)" "Nuzm admin console: terms attested with your agreement reference; the decision log rows are checked by G-approvals.sh"
manual B3 "hosting staging node account with a billing alert / hard cap (HG-05)" "provider console: the billing alert or cap is visible; no secret is needed here"
if [ -z "$PANEL" ]; then
  skip B4 "hosting panel reachable (HG-06)" "pass --panel https://<node>:<panel-port> (the check is one HEAD request to your own node, status code only)"
elif have curl; then
  CODE="$(curl -sk -I -m 10 -o /dev/null -w '%{http_code}' "$PANEL" 2>/dev/null || true)"
  case "$CODE" in
    000|'') fail B4 "panel $PANEL did not answer" "check the node, the panel port and the firewall" ;;
    *) pass B4 "panel $PANEL answers HTTP $CODE (the access key is typed into the admin console only; its sealed vault reference is MANUAL: admin console > Hosting)" ;;
  esac
else fail B4 "curl is not installed" "install curl"; fi
manual B5 "preview domain separate from the console and API domains; DNS API token held by the node's ACME client only (B-DOMAIN)" "D-dns.sh checks the records; the token must exist ONLY on the node"
manual B6 "provider account able to rent a dedicated bare-metal Linux server (D-21)" "provider console; nothing is purchased until D-21 and the budget are approved"
# a guard that is checkable: no credential-looking value in the repository's tracked files
if have git && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if (cd "$REPO_ROOT" && pnpm --silent scan:secrets >/dev/null 2>&1); then pass B7 "repository secret scan (pnpm scan:secrets) is clean"; else fail B7 "the repository secret scan reports a finding (or pnpm is unavailable)" "run: pnpm scan:secrets   (the finding names file and kind, never the value)"; fi
fi
summary "B accounts"; exit $?
