# DNET-S1 report: architecture assessment for the DNet (`.sa`) registrar integration

Status: **assessment DONE; adapter BLOCKED (HG-07-03, D-50)** · Written 2026-11-21 · Input: the owner's "Complete DNet Saudi Domain Registrar Integration" brief · No product code was changed.

## A. Repository findings and assumptions

- The brief says "integrate into the existing codebase" and suggests a new `src/modules/domains/` tree. A domains module **already exists** (M07, sprints S28-S33): `apps/api/src/modules/domains/`. It is spec-first (`/v1/...` in `spec/openapi/openapi.yaml`), schema-per-module (`domains.*` in `spec/db/ownership.yaml`), and provider-neutral through `RegistrarAdapter` (`packages/adapters/registrar-contracts`, contract 1.0.0) with two adapters (`openprovider`, `resellerclub`), a conformance kit and mock servers. The brief's new tree, `/api/domains/...` routes and TypeORM-style entities would duplicate it and break CLAUDE.md §2 (no renaming endpoints or tables; no second payment/ledger path; module boundaries). **Decision followed: DNet becomes one more `RegistrarAdapter`, not a new module.**
- `.sa` and every Saudi suffix are **deliberately not sold**: `spec/providers/tld-policy.yaml` lists them as always restricted, and the loader refuses a Saudi suffix without an `evidence_ref`. Opening them needs HG-07-02 (eligibility route) and D-19. This integration is the proposed route; it is recorded as **D-50** and the account/documentation request as **HG-07-03** in `docs/07`.
- DNet's API documentation is not in the repository and could not be read (dnet.sa returned HTTP 403 to our fetcher; a search snippet only shows an "API for reseller" menu entry). See [docs/adapters/dnet.md](../adapters/dnet.md). The brief itself says: without documentation, build provider-independent work and mark DNet operations blocked. Nothing about DNet's endpoints, auth or payloads was assumed.

## B. Brief vs. what exists (reuse map)

| Brief item | Already in the repo | Gap for DNet / `.sa` |
|---|---|---|
| Provider interface + factory | `RegistrarAdapter`, `AdapterFactory` in `domains/internal/factories.ts`, capability ids with unknown = unsupported | A `dnet` adapter and one factory entry (blocked) |
| Typed capability errors | `unsupported_capability` (409/422) from the TLD policy and capability checks | none |
| Search, pricing, quotes | `search.service`, `domain-pricer`, `pricing`, `GET /v1/domains/search`, quote TTL, FX, markup (`DOMAINS_MARKUP_BPS`, D-23 open) | per-TLD markup and promotions are not modelled; needs a spec change (owner approval) |
| Eligibility engine | `tld-policy` + `eligibility.service` (platform policy, then registry rules when the adapter declares `registrar.eligibility`), append-only `eligibility_checks` | Saudi applicant categories, per-suffix required fields and document lists: **depend on DNet/SaudiNIC rules (not read)** |
| Document upload and verification statuses | not present for domains (contacts are encrypted in `domain_contacts.payload_enc`; knowledge module has an object store) | a private document store + scan + signed URLs for registrant documents; status workflow. New tables = migration + ownership change; only if DNet requires documents |
| Registration wizard, orders, states | `orders.service`, `domain_orders`, `/v1/domains` POST, checkout UI, reconciler, `needs_reconcile`/`provider_pending` | extra states (`PENDING_DOCUMENTS`, `PENDING_PROVIDER_REVIEW`, `MANUAL_REVIEW_REQUIRED`) only if DNet has an async review |
| Wallet and money | quote → authorize → record → reconcile through `billing`; `ledger-recipes`; integer minor units | none (no second payment system, per brief and CLAUDE.md §4) |
| Renewals, reminders, auto-renew | `renewal.service` (reminders 60/30/7/1 days, spend-approval, `renewal_at_risk`) | brief asks 30/14/7/3/1: a config change, needs owner OK |
| Transfers | `transfer.service`, `domain_transfers`, auth code in vault | `.sa` transfer rules unknown (the brief says not to assume EPP) |
| DNS and nameservers | `dns.service`, `dns_zones/records`, `registrar.dns` capability, `/v1/dns/...`; DNS is Nuzm-operated unless an adapter supports `dns` (D-36) | none until DNet's DNS capability is known |
| Hosting connection and SSL | `linkage.service`, `POST/GET /v1/domains/{id}/hosting-links`, platform-managed records, `_acme-challenge` via the port | the hosting read port is still an in-memory fake until M06 |
| Admin registrar settings, orders, reconcile | `admin-registrars.controller`, `registrar-admin.service`, `/v1/admin/registrars`, `/v1/admin/domains`, reconciliations, verification | DNet-specific form fields depend on its auth scheme; "Test connection" needs a documented read-only call (the existing `verification` route is the place) |
| Jobs, locks, idempotency | `DomainJobs.runDaily()`, reconciler sweep, idempotency tokens, webhook dedupe, `findByToken` | worker host is M12; schedule is a timer today |
| Security | vault references only (vault client not built: D-12, HG-01-02), redaction, SSRF-limited egress per adapter | live credentials impossible until D-12 |
| Customer and admin UI | domain screens in `apps/web/.../domains/**` and `apps/admin/.../domains/**` (ar/en) | Saudi-specific wizard steps once the rules are known |

Route names in the brief (`/api/domains/...`) are **not adopted**: the spec's `/v1/domains...` routes stay. Any addition (for example a documents route) is a spec change first, with owner approval (CLAUDE.md §2).

## C. What was done

- `docs/adapters/dnet.md`: vendor research record, capability matrix (all `unknown`), the ten questions the documentation must answer, planned adapter shape.
- `docs/07-open-decisions-and-blockers.md`: **D-50** (DNet as the `.sa` route, OPEN) and **HG-07-03** (DNet account, documentation, sandbox credentials).
- No code, migration, spec or UI change. Writing a DNet client now would mean inventing endpoints, which CLAUDE.md §4 and the brief both forbid. A "DNet adapter" returning `unknown` everywhere would add nothing the existing "unlisted provider = unsupported" rule does not already give.

## D. Migrations and rollback

None.

## E. Tests run

None (documentation-only change). `pnpm lint` (prettier) on the three files is recorded in the hand-off message.

## F. Security, tenant isolation, billing, residency

Not exercised. Residency: Saudi domain registrant data sent to DNet goes through `ResidencyPolicyService` like every vendor call; personal data classification for any new registrant/document fields is required before a migration.

## G. Human gates and live checks still needed

- **HG-07-03** (new): DNet reseller account, API documentation, sandbox credentials.
- **HG-07-02 / D-19 / D-50**: written confirmation of the `.sa` eligibility route; counsel review of Saudi registrant data and document handling.
- D-12 (vault client), D-23 (margin policy), D-36 (authoritative DNS), D-31 (cost-variance threshold).
- Nothing is LIVE-VERIFIED.

## H. Acceptance checklist

| Item | Status |
|---|---|
| Existing code analysed, reuse map | PASS (this document) |
| DNet capability matrix | BLOCKED (HG-07-03): all cells `unknown` |
| DNet adapter, auth, availability, pricing | BLOCKED (HG-07-03) |
| `.sa` eligibility rules, documents, verification workflow | BLOCKED (HG-07-02/03, D-19) |
| Wallet/billing, renewals, DNS, hosting connection, admin | PASS in M07 for existing providers (mock); DNet-specific parts BLOCKED |
| Live registration/renewal | BLOCKED (never run without explicit authorization) |

## I. Next-milestone handoff and open decisions

1. Owner supplies DNet's API documentation and sandbox credentials (HG-07-03), and answers D-50.
2. Then, in order: spec changes the owner approves (documents route, extra order states if DNet needs them, per-TLD markup), `packages/adapters/dnet` with mock server and conformance run, factory entry, TLD-policy entries with `evidence_ref`, Saudi-specific wizard and admin form fields, sandbox probe (`NOT VERIFIED` → `LIVE-VERIFIED` only with live evidence).
