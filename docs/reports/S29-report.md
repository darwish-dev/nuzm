# S29 report — ResellerClub, orders/renewals/transfers, contacts, webhooks

Vendor results **NOT VERIFIED** (HG-07-01); mock only.

## A. Findings and assumptions
* ResellerClub documents **no client token, no webhooks, no atomic DNS, no standalone auto-renew toggle, no auth-code retrieval call, and deprecates contact modification** (see `docs/adapters/resellerclub.md`). The adapter therefore reports those capabilities `unsupported`; `findByToken` is a **lookup by domain name under our customer id** (domain names are unique). One reseller customer id per account (vault field `customerId`) is assumed.
* Openprovider has no client token either: the idempotency token travels in the domain `comments` field and `findByToken` searches it; adapter-level replay protection looks the token up before registering.
* `autoRenew` is the **platform's** renewal flag; the vendor's own auto-renew is always off (so a vendor can never charge without an order).
* Payment: orders are paid from the **prepaid wallet** (M03 wallet): funds are reserved (Dr 2100 → Cr 2200), revenue recognised after the registrar confirms (Dr 2200 → Cr 4300 + 2300), reversing entry on failure. Per-order PSP intents are not built (PSP is sandbox-only, HG-03-02); `402 payment_required` is raised before anything is reserved.
* "operationId" in the idempotency token `sha256(orgId|operationId|stepId)` is the **domain order id** (stable across operation re-creation).

## B. Changed files
`packages/adapters/resellerclub` (+ `docs/adapters/resellerclub.md`); migration `0910` (contacts, transfers); `domains/internal/{orders,domain,webhook,transfer,contacts,ledger-recipes,dsr-handler,reconciler}.service.ts` and controllers; `commerce` (`setStatus`, `findByQuote`); `spec/compliance/purposes.yaml` (+consent `domain_registrant_disclosure`); residency hook `m07-registrant-contacts` → **enforced**.

## C. Implemented
`POST /v1/domains` (202 + operationId), `GET /v1/domains`, `GET/PATCH /v1/domains/{id}` (If-Match = version; capability-gated; 202 when uncertain), `POST /v1/domains/{id}/renewals`, `POST/GET /v1/domains/transfers` (auth code → vault, only the reference is kept), `GET /v1/domains/{id}/eligibility`, `POST /v1/webhooks/registrars/{provider}` (HMAC over the raw body, 5 min replay window, dedupe on provider event id in `platform.webhook_events_inbound`, whitelist payload), forced `POST /v1/admin/domains/{id}/reconciliations`. Workflow: quote valid → spend approval (M02 `OrderService`) → funds reservation → TOCTOU re-validation (account, policy, capability, residency) → `register(token)` → persist → ledger record → meter (`eventId` deterministic) → provider cost → notify; `uncertain` ⇒ `needs_reconcile` ⇒ `findByToken` ⇒ finalize, or **one** retry when absence is proven.

## D. Migrations
`0910` `domain_contacts` (sealed `enc:v1:` payload, CHECK-enforced), `domain_transfers` (`auth_code_ref` vault reference).

## E. Tests run (actual)
| Command | Result |
|---|---|
| ResellerClub conformance on the mock | 16 pass, **R15 (webhooks) and R16 (DNS) skipped by design** (documented unsupported) |
| `domains-orders.int.spec` | **17 pass**: happy path (1 authorization, 1 record, 1 meter, 1 cost record, funds once); PII sealed/masked/absent from audit, operations, outbox, notifications; 402 leaves nothing; timeout after/before; bounded retry; definitive refusal releases funds; **AC-M07-03: 50 seeded fault-injection runs ⇒ 0 duplicate registrations, 0 duplicate charges, all orders and operations terminal**; two orgs racing for one name ⇒ exactly one registration, loser 409 with no owner leaked; idempotency replay; cross-tenant matrix; PATCH/ETag/renewal |
| `domains-webhooks.int.spec` | **6 pass**: **AC-M07-02: the same event ×100 (10 parallel) ⇒ 1 processed, 99 duplicates, 1 registration, 1 meter event, 1 ledger record**; forged 401, replay 409, malformed 422, unknown provider 404; auth code appears in no table/log-like column/response (AC-M07-08 scan) |

## F. Security / tenancy / billing / residency
Contacts are `personal`: sealed with the M04 field cipher, bound to column+row; masked for callers without `domain:write`; **never** in audit/operations/outbox/notifications (scanned in tests). Residency is evaluated at quote, at order creation and again immediately before PII leaves; the decision is stored with the order. Consent `domain_registrant_disclosure` is required when privacy protection is not used. DSR: export/erase handler `domains.contacts` (erase refuses `retention_mandatory` for live registrations; registry retention per TLD is **to be confirmed with counsel**, HG-04-01).

## G. Gates
HG-07-01 PENDING; HG-03-02 PENDING (no live charge); HG-04-01 PENDING.

## H. Acceptance (S29 slice)
AC-M07-02 PASS; AC-M07-03 PASS (mock); AC-M07-07 PASS for the order/domain/transfer endpoints (full matrix in S31/M07 report); AC-M07-08 PASS for the scans written (orders, transfers, webhooks); AC-M07-12 **BLOCKED (HG-07-01)**.

## I. Handoff
S30 adds DNS on top of the adapter `dns` capability; S31 links hosting, adds renewals jobs and reconciliation.
