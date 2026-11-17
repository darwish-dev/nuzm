# S10a report — Refunds and wallet top-ups (M03 sprint 10, first half)

Status: implemented and verified against real PostgreSQL and the sandbox PSP (see §E). **Not committed.** S10b (subscriptions, renewal scheduler, proration, dunning) is next.

## A. Repository findings and assumptions
- **Sprint split.** docs/06 S10 is one sprint; I split it like S07/S08: S10a = refunds + wallet top-ups + their ledger recipes; S10b = subscriptions, renewal, proration, dunning policy, wallet-debit mode orchestration.
- **Spec gaps (no silent reconciliation):**
  1. docs/04 defines only `POST /v1/admin/billing/refunds`. There is no list/get for refunds, which UI-M03-15 ("request refund, status") needs. **Not invented**; owner decision needed (proposal: `GET /v1/admin/billing/refunds` and `…/{id}`).
  2. `POST /v1/billing/wallet-topups` has no `returnUrl` in docs/04, but a 3-D Secure redirect needs one. I made `returnUrl` required in the body (additive); the allow-list check is the same as for payments.
  3. `creditNoteId` on the refund body is an additive optional field (the "credit-note link" of the M03 prompt).
  4. `Payment.invoiceId` is now nullable and `Payment.walletTopupId` exists (a payment pays an invoice **or** a top-up).
- **D-25 (VAT timing on prepaid credit):** only *VAT at consumption* is implemented (top-up posts Dr 1100 / Cr 2100, no VAT; `walletConsume` carries the VAT). `WALLET_VAT_TIMING=topup` is refused at start-up because an advance-payment tax document is not built. [VERIFY HG-03-04].
- **A refund does not edit the invoice.** The invoice stays `paid`; the legal correction is the credit note. A refund moves money: Dr 1200 (applied part) and/or Dr 2500 (never-applied part) → Cr 1100 PSP clearing.
- **Refunds of wallet top-up payments are refused (422).** They need an unspent-credit rule (a refund would debit the wallet and may not overdraw it). Owner decision.
- **platform-scope allow-list** now includes `modules/payments/` (finance refunds resolve the payment's organization; sweeper). Guard test updated.
- **Sweepers are not scheduled yet.** `RefundService.processPending` and `PaymentService.processPending` exist and are tested, but nothing calls them periodically: the worker depends only on `@nuzm/platform` and cannot import API services. The scheduling decision belongs with the S10b renewal scheduler (same constraint).

## B. Plan and changed files
- Migrations: `payments/0311__payments__refunds_topup_target` (+down), `billing/0320__billing__wallet_topups` (+down).
- Spec: `spec/openapi/openapi.yaml` (+2 operations: `createWalletTopup`, `adminCreateRefund` → **101** operations; `Payment`/`CreatePayment` changed), SDK regenerated; `spec/db/ownership.yaml` (`wallet_topups`).
- Code: `billing/internal/recipes.ts` (`refund`, `walletTopUp` replace the stubs), `billing/internal/wallet-topup.service.ts`, `payments/internal/refund.service.ts`, `payments/internal/payment.service.ts` (two payable targets), `payments/internal/psp/{psp,mock-psp}.ts` (`createRefund`, `retrieveRefund`), `invoicing` (`appliedOf`, `markRefunded`), controllers `admin-refunds.controller.ts`, `wallet-topups.controller.ts`, modules wiring, `platform-scope.spec.ts`.
- Tests: `recipes.spec.ts` (+3 tests, refund property 10,000 runs), `payments/refunds-topups.int.spec.ts` (22 integration tests).
- Docs: `docs/runbooks/refund-procedure.md`.

## C. Implemented features, API
| Area | What exists |
|---|---|
| Refund API | `POST /v1/admin/billing/refunds` `{paymentId, amount, reason, creditNoteId?}`: admin realm, MFA + step-up, `admin:billing:manage`, `Idempotency-Key` required. 201 finished, 202 pending, 200 replay |
| Over-refund protection | a refund is inserted under the payment's row lock and **reserves** its amount while pending (remaining = captured − refunded − pending); the PSP also refuses more than it captured |
| Idempotency | (requester, key) → one refund; same key + different body → 422 `idempotency_key_reuse`; the PSP gets the refund's own merchant reference `nuzm_rf_<id>` as its key |
| Reconcile before retry | an uncertain answer leaves the refund `pending`; the sweeper asks the PSP first and only re-sends when the PSP has no record |
| Ledger | one transaction per refund, key `payment:<id>:refund:<refundId>`, linked once; crash between PSP answer and ledger repaired by `complete` |
| Credit-note link | optional; must be issued, same invoice and currency; becomes `refunded` when refunds against it cover its total |
| Wallet top-up | `POST /v1/billing/wallet-topups` `{amount:{amount,currency}, paymentMethodId?, returnUrl}` → top-up + payment; configurable min/max (`WALLET_TOPUP_MIN_MINOR`/`MAX_MINOR`, default 1,000 / 10,000,000); credited only on capture (Dr 1100 / Cr 2100, idempotent `payment:<id>:capture`); retry via `POST /v1/billing/payments {walletTopupId}` |
| UI | none in this half (UI-M03-08/09/15 are S12) |

## D. Migrations and rollback
`payments/0311`: `payment_intents.invoice_id` nullable + `wallet_topup_id` + check "exactly one target"; `intent_guard` updated (null-safe identity); new `payments.refunds` (state machine pending→succeeded|failed, identity frozen, ledger link set once, never deleted/truncated, org RLS + platform read, column-level UPDATE grants). `billing/0320`: `billing.wallet_topups` (credited only together with its ledger link; immutable otherwise). Both have dev-only `.down.sql` (exercised: rollback ×2 then migrate, `db check` OK); production is forward-fix (financial records never dropped).

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run:
- lint, typecheck (19/19), build (11/11), `spec:lint` clean, `spec:drift` OK (**101** operations), `sdk:check` up to date, `scan:secrets` 848 files / 8 rules / 0 hits.
- Unit: api **258** (recipes +3 incl. the 10,000-run refund property), web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: **6 passed**.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 459** (22 new) = **542**; the generated cross-tenant suite (104 tests) covers the two new operations.
- New integration highlights: partial and full refund with ledger/audit/outbox assertions; 8 concurrent refunds on one payment → exactly 3 succeed and the PSP refunded exactly 9,000 of 10,000; timeout (money moved, answer lost) → pending → reconciled with **0 duplicate refunds**; PSP "pending" then finished; crashed request (row inserted, PSP never called) sent once by the sweeper; refund of a never-applied payment books Dr 2500; top-up with decline → retry; top-up timeout reconciled on read (1 charge, 1 ledger entry); 3-D Secure top-up with the webhook delivered 5× in parallel → 1 ledger entry; DB guards (amounts only grow, refunds immutable/undeletable).

## F. Security, tenant isolation, billing, residency verification
- Refunds are finance-only (support and customers refused), step-up on the admin route, idempotent, audited (`requested`, `succeeded`/`failed`); the organization is taken from the payment row, never from the body.
- RLS on `refunds` and `wallet_topups` (forced; org isolation + platform read); cross-tenant: another organization cannot pay your top-up (404).
- No card data path added: the top-up controller applies the same `containsCardData` refusal (422 `pan_not_allowed`).
- Money: integer minor units, strings in JSON, no floats; every ledger transaction balanced (recipe property, 10,000 runs).
- Residency: not evaluated (unchanged; M04).

## G. Human gates and live checks still needed
D-10 and HG-03-02 (no real PSP: refund behaviour against a real PSP is **NOT VERIFIED**), HG-03-04 (VAT timing on prepaid credit, credit-note/refund treatment), D-25, HG-04-01. Nothing was sent to a live PSP.

## H. Acceptance (S10a rows)
| Row | Status |
|---|---|
| Refunds: idempotent, ≤ remaining captured, async pending, ledger once | PASS (sandbox PSP) |
| Refund concurrency / uncertain result / no duplicate refund | PASS (sandbox PSP) |
| Credit-note link and status | PASS (service level with a stubbed note; real credit-note issue path covered in S08b) |
| Wallet top-up request, capture crediting, min/max | PASS (sandbox PSP) |
| Wallet VAT timing configurable per D-25 | PARTIAL: only VAT-at-consumption; `topup` refused (NOT BUILT) |
| Wallet consume/debit mode orchestration (rated usage → wallet) | NOT DONE (recipes exist since M02; orchestration moves to S10b) |
| Refund of a wallet top-up payment | NOT DONE (owner decision) |
| Refund listing API for UI-M03-15 | BLOCKED (spec gap, owner decision) |
| Live PSP refund | BLOCKED (D-10 / HG-03-02) |

## I. Handoff and open decisions
- **S10b:** `billing.subscriptions` (items JSON), renewal scheduler idempotent per period and period close, trial, cancel at period end, plan change with proration, `spec/billing/dunning-policy.yaml` + `billing.dunning_cases` (requests only, no data deletion), wallet-debit mode, notifications. Decide where scheduled jobs run (the worker cannot import API services); the same decision schedules the two existing sweepers.
- **Owner:** refund list/get endpoint; refund of top-ups (unspent-credit rule); VAT timing (D-25); D-10.
