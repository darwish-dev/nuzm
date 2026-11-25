#!/usr/bin/env bash
# Checklist section D: DNS and TLS for the preview domain. READ-ONLY (see lib.sh): public DNS queries and, with --tls, one TLS handshake with a host YOU name. No record is created.
#   D-dns.sh --preview-domain <domain> [--expect-ip <ip>] [--console-domain <domain>] [--tls <host>] [--strict]
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
PD="$(opt_value --preview-domain "$@")"; IP="$(opt_value --expect-ip "$@")"; CD="$(opt_value --console-domain "$@")"; TLS="$(opt_value --tls "$@")"
if [ -z "$PD" ]; then skip D1 "preview domain records" "pass --preview-domain <domain> (B-DOMAIN)"; summary "D dns"; exit $?; fi
have dig || { fail D0 "dig is not installed" "install bind-tools / dnsutils"; summary "D dns"; exit $?; }
ips() { grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]+:[0-9a-fA-F:]+$'; }   # only real addresses: a dig error message is not an answer
A="$(dig +short +time=5 +tries=1 A "$PD" 2>/dev/null | ips | head -3 | tr '\n' ' ')"; W="$(dig +short +time=5 +tries=1 A "p-check-$(date +%s).$PD" 2>/dev/null | ips | head -3 | tr '\n' ' ')"; CAA="$(dig +short +time=5 +tries=1 CAA "$PD" 2>/dev/null | grep -E '^[0-9]+ (issue|issuewild|iodef) ' | head -2 | tr '\n' ' ')"
[ -n "$A" ] && pass D1 "A record for $PD: $A" || fail D1 "no A record for $PD" "create: A <node-ip> for $PD"
[ -n "$W" ] && pass D2 "the wildcard resolves ($W)" || fail D2 "no wildcard record for *.$PD (a random label did not resolve)" "create: A <node-ip> for *.$PD"
if [ -n "$IP" ]; then case " $A " in *" $IP "*) pass D3 "$PD points at the expected node $IP";; *) fail D3 "$PD does not point at $IP (got: ${A:-nothing})" "fix the A record";; esac; else skip D3 "record points at the expected node" "pass --expect-ip <node-ip>"; fi
[ -n "$CAA" ] && pass D4 "CAA present: $CAA" || manual D4 "no CAA record (optional)" "CAA 0 issue \"letsencrypt.org\" restricts issuance"
if [ -n "$CD" ]; then
  case "$PD" in "$CD"|*".$CD") fail D5 "preview domain $PD is $CD or a subdomain of it" "ADR-060: use a registrable domain of its own";;
    *) case "$CD" in *".$PD") fail D5 "console domain $CD is a subdomain of the preview domain $PD" "ADR-060: separate registrable domains";; *) pass D5 "preview domain is separate from the console domain";; esac;; esac
else skip D5 "preview domain separate from the console domain" "pass --console-domain <domain>"; fi
if [ -n "$TLS" ]; then
  if have openssl; then
    OUT="$(echo | openssl s_client -connect "$TLS:443" -servername "$TLS" 2>/dev/null | openssl x509 -noout -subject -enddate 2>&1 || true)"
    if printf '%s' "$OUT" | grep -q 'notAfter'; then
      END="$(printf '%s\n' "$OUT" | sed -n 's/^notAfter=//p')"
      if echo | openssl s_client -connect "$TLS:443" -servername "$TLS" -verify_return_error >/dev/null 2>&1; then pass D6 "TLS certificate verifies for $TLS, expires $END"; else fail D6 "the certificate for $TLS does not verify" "issue a valid certificate (wildcard DNS-01 by the node's ACME client)"; fi
    else fail D6 "no TLS certificate from $TLS:443" "issue one before the preview track"; fi
  else fail D6 "openssl is not installed" "install openssl"; fi
else skip D6 "TLS certificate on a preview host" "pass --tls test.<preview-domain> after issuance"; fi
summary "D dns"; exit $?
