# S52 report — Connectors and outbound webhooks (M11)

Status: **IMPLEMENTED; local evidence only.** Named third-party connectors are out of scope (PROPOSED-HG-11-02 not raised).

## Built
- **Connectors** (`connector.service.ts`, migration 1601): types `nuzm`, `http`, `oauth2` (authorization code + PKCE S256, tenant-supplied endpoints through the SSRF-guarded client), `email`. Authorization stores a **vault reference of THIS organization only** (`vault://…/tenant-<orgId>-…`); raw secrets in bodies → 422 `credential_value_rejected`; scopes of an authorization ⊆ the connector's. Runtime gate before every step: missing/foreign/pending/revoked/expired/disabled/scope-lacking → `403 connector_not_authorized`, fail closed. Token bucket + circuit breaker per connector (process-local).
- **SSRF** (`ssrf.ts`): https only, no credentials, port allow-list, internal-name patterns, IPv4 in any notation, IPv6 (mapped, NAT64, 6to4, ULA, link-local), CGNAT/metadata, DNS resolved HERE with every answer vetted and the connection pinned to the vetted IP (rebinding), redirects re-validated per hop, 5 MB / 30 s caps. Also applied at registration of webhook URLs and connector/OAuth endpoints.
- **Outbound webhooks** (`webhook-endpoint.service.ts`): secret shown once; `X-Nuzm-Signature: t=…,v1=HMAC-SHA256(t.body)` (several `v1` during rotation overlap); exclusive attempt claim; exponential schedule ≤ 23.9 h then dead; 4xx permanent; endpoint auto-paused after 50 failures; append-only delivery log; replay (service-level).
- **Abuse**: see S51.

## Evidence
- AC-M11-03: **domain corpus 60+ payloads denied (0 reach transport)**; API level: 43 URL payloads × (webhook endpoint + OAuth connector) all 422; runtime: 9 internal targets fail with `ssrf_denied`, transport hit count 0; DNS-rebinding test proves a single resolution and a pinned IP.
- AC-M11-12: signature valid/tampered/expired/future/replay/malformed, rotation overlap, retry schedule (10 attempts), dead letter + replay, duplicate event = one delivery, concurrent dispatchers send an attempt once — all PASS (`automation-triggers.int.spec.ts`, `runtime.spec.ts`).

## Not verified
Real third-party receivers and OAuth providers; egress proxy at network level; cross-border `transfer_assessment` reference on connectors is stored but not auto-created (HG-04-01).
