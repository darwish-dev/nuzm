# S09 report — Payments: PSP adapter + sandbox mock, methods, intents, webhooks (M03 sprint 2)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M03 continues with S10 (subscriptions, wallet, dunning, refunds), S11 (ZATCA, sandbox/simulation only), S12 (reconciliation, reports, UIs). **Everything here runs against the deterministic `psp-mock`; no real PSP exists (D-10 OPEN, HG-03-02 PENDING): AC-M03-20/21 stay BLOCKED.**

## A. Repository findings and assumptions
- **Adapter placement:** `packages/adapters` is a skeleton created in M05; the `PspAdapter` contract and the mock live in `apps/api/src/modules/payments/internal/psp` until then. The contract follows docs/09 §6 (`createCustomer`, `attachMethod` (tokenize setup), `createPayment`, `retrievePayment` (the reconcile probe), `parseWebhook`); `capture`, `refund` and `listSettlements` arrive with S10/S12.
- **Production profile registers no adapter:** with `NODE_ENV=production` the mock is not registered, so no payment can be made (and webhooks answer 404) until a real adapter exists.
- **Payable targets:** `invoiceId` only. `quoteId` and `walletTopupId` (docs/04) are refused with a clear 422: quotes need the order flow (M05) and top-ups are S10.
- **`psp_events` per docs/05, not `platform.webhook_events_inbound`:** docs/05 lists `payments.psp_events`; the generic M01 inbound table stays unused. The new table is reachable only with a new database scope `psp_webhook`.
- **Raw body:** webhook signatures are computed over the exact request bytes (Nest `rawBody: true` at application creation, in the dev stack and the test harness).
- **Unapplied money:** a succeeded payment that cannot be applied (invoice void or already settled) is booked as an unapplied customer payment (account 2500) instead of failing; a finance workflow for it is S10/S12.
- `payment.refunded` states, refunds table and `finrec` are not part of S09.

## B. Plan and changed files
- Migrations `payments/0310` and `invoicing/0302` (+ `.down.sql`, dev only); `spec/db/ownership.yaml`; `platform/db.ts` (`psp_webhook` scope).
- `apps/api/src/modules/payments`: `psp.ts`, `mock-psp.ts`, `registry.ts`, `payment-state.ts`, `pan.ts`, `method.service.ts`, `payment.service.ts`, three controllers, module. `invoicing`: `InvoiceService.applyPayment`. `billing`: recipe `paymentCaptured`. Spec: 8 operations (99 in total), error codes `pan_not_allowed`, `payment_method_required`, `invalid_signature`.
- `scripts/scan-secrets.ts`: Luhn-checked card-number rule. Runbook `psp-incident.md`. `.env.example`: `PSP_MOCK_WEBHOOK_SECRET`, `PAYMENT_RETURN_URL_ALLOWLIST`.

## C. Implemented features and API
Payment methods (save from a PSP setup token, list with an expiring flag, default, remove; no card data in any form); payment intents for invoices (success, decline, 3-D Secure with redirect, processing → 202, uncertain → reconcile, partial payments, default method); webhook intake (signature, replay window, dedupe, whitelist storage, transactional processing, stale/out-of-order handling, anomaly capture); capture finalization (state + audit + outbox, then invoice application and ledger `Dr 1100 / Cr 1200`, both idempotent and repairable).

## D. Migrations and rollback
`payments/0310` (7 tables, state-machine trigger, immutability, forced RLS, `resolve_intent` definer function, unique default and unique active fingerprint per organization) and `invoicing/0302` (payment applications). Dev-only down scripts; payment records are never dropped in production.

## E. Tests run (actual)
- Unit: payment state machine (all 64 pairs), card-number detection, mock PSP and webhook verification (tamper, wrong secret, replay both directions, malformed), recipe `paymentCaptured` balanced over **10,000** random amounts.
- Integration (real PostgreSQL): `payments.int.spec.ts` **30** tests. Highlights: **AC-M03-02** one event delivered 100 times in parallel → one `processed`, 99 `duplicate`, one ledger effect, one invoice application, one outbox event; out-of-order and anomaly cases; **AC-M03-03** 1,000 injected timeouts → 0 duplicate charges, every payment charged exactly once, 1,000 ledger postings; **AC-M03-04** card data refused in 7 shapes (never echoed back), CHECK constraints reject card-like tokens and fingerprints, and no Luhn-valid number in any payments, invoicing, ledger, outbox or audit row; every illegal intent transition refused by the database; tenant isolation.
- Cross-tenant generated suite now covers the payment-method and payment id routes (103 tests).
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **341 unit tests** (api 255, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **6 passed**; spec lint clean, spec drift OK (99 operations), `sdk:check` up to date, `scan:secrets` 838 files / 8 rules / 0 hits, `db check` OK; integration on real PostgreSQL **519** (db 43, platform 32, worker 8, api 436).

## F. Security, tenant isolation, billing, residency verification
RLS forced on every payment table (tenant sessions cannot read `psp_events` at all); signature + replay + dedupe on webhooks; return URLs restricted to an origin allow-list (open-redirect protection); roles: owner/billing admin manage, billing readers read, developers and viewers refused. Residency: PSP processing is not residency-evaluated (M04 transfer inventory entry to be added for the PSP).

## G. Human gates and live checks still needed
D-10 (PSP choice) OPEN; HG-03-02 (merchant account, sandbox keys, production approval) PENDING → AC-M03-20 (live sandbox end-to-end) and AC-M03-21 (production) **BLOCKED**. PCI scope (SAQ-A style) must be confirmed with the PSP/QSA [VERIFY]; the platform handles no card data by construction and by test, but that is not a certification.

## H. Acceptance (S09 rows)
| Row | Status |
|---|---|
| AC-M03-02 duplicate webhook ×100 and out-of-order → exactly 1 ledger effect | PASS (mock PSP) |
| AC-M03-03 0 duplicate charges in 1,000 injected-timeout runs | PASS (mock PSP) |
| AC-M03-04 no PAN/CVV in DB, logs or fixtures; scanner 0 hits | PASS (database, request path and repository scanner; log redaction beyond the request path not separately scanned) |
| AC-M03-01 recipes | PARTIAL: payment captured added (invoice issued, credit note in S08b); refund and wallet top-up in S10 |
| AC-M03-20 / -21 live PSP | BLOCKED (D-10, HG-03-02) |

## I. Handoff
S10: refunds (`POST /v1/admin/billing/refunds`, ≤ remaining captured, credit-note link), wallet top-ups, subscriptions and renewal worker (the scheduler for period close), dunning. Owner decisions: D-10; how to handle money that cannot be applied (2500) operationally.
