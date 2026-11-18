# Runbook — payment service provider (PSP) outage (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED: only the deterministic sandbox PSP (`psp-mock`) exists; D-10 and HG-03-02 are PENDING, so no live PSP behaviour is asserted. The mechanics of uncertain results, webhooks and half-done captures are in `psp-incident.md`: read it first. This runbook is the outage-level procedure.

## Purpose
Keep customers, invoices and the ledger correct while payments cannot be taken or confirmed, and recover without double charges.

## Trigger / alert
Payment attempts ending `uncertain` or `processing` in bulk; PSP status notice; checkout or hosted-field failures; no PSP webhooks for longer than normal; RC-01 `missing_settlement` or `unknown_psp_line` after the outage; payment-sandbox synthetic probe failing (planned, S57).

## Severity guidance (proposal)
SEV1: payments unavailable for all customers, or any double-charge evidence. SEV2: elevated failure rate or confirmations delayed. SEV3: one payment method or one region.

## Preconditions / access
Finance and platform admin in the admin realm with MFA; dunning changes need step-up. The platform never holds card data; do not ask customers for card numbers in any channel.

## Steps
1. **Open an incident** (`incident-response.md`); confirm the outage on the PSP's own status channel.
2. **Never retry blindly.** An attempt that timed out is `uncertain`; the next read or pay request asks the PSP about the merchant reference first and adopts an existing charge (`psp-incident.md`). Only if the PSP has no record is one new attempt made.
3. **Protect customers from wrongful restrictions.** Place affected dunning cases on hold: `PATCH /v1/admin/billing/dunning/{id}` `{action: hold, reason}` (finance, step-up). Release with `resume` after recovery. Dunning retries and day-based restrictions are in `dunning.md`.
4. **Subscriptions.** Renewals that fail go `past_due`; do not edit subscription rows by hand (`subscription-lifecycle.md` §3). They settle on the next `runDue` after recovery.
5. **Webhook backlog.** Expect late or duplicate events; follow `webhook-storm.md`. Stored-but-unprocessed events are re-run by `PaymentService.processPending()` (scheduler on).
6. **Wallet top-ups and refunds** in flight: reconcile through the payment read (`GET /v1/billing/payments/{id}` asks the PSP for unfinished payments). Refund status: `GET /v1/admin/billing/refunds?status=pending`.
7. **Recovery.** When the PSP confirms recovery: run one test payment in the sandbox or, once live, the smallest approved test (finance decision), then release holds. Run RC-01, RC-02 and RC-06 for the outage window (`reconciliation-variance.md`).
8. **Late successes.** A "succeeded" after a recorded failure becomes `succeeded_after_terminal_failure` for finance; the customer is refunded or the invoice applied only by a finance decision with the PSP, never automatically.

## Verification
No payment left in `processing` older than the PSP's confirmation window without a PSP answer; 0 duplicate charges (RC-01/RC-02 clean); holds released; dunning cases reflect actual state; wallet projection equals the ledger (RC-06).

## Escalation
Finance lead (owner); PSP support contact (to be filled when the PSP is selected, D-10); L2 on-call for processing faults; security officer for suspected fraud; counsel via compliance officer if customers are overcharged and a notice is required.

## Communication draft
EN: "Card payments are temporarily unavailable or delayed. Your invoices will not be treated as overdue because of this and your services continue. Please do not retry payments repeatedly; we will confirm when payments are working. Reference: [incident id]."
AR: "المدفوعات بالبطاقة متوقفة أو متأخرة مؤقتًا. لن تُعامَل فواتيركم كمتأخرة بسبب ذلك وستستمر خدماتكم. نرجو عدم تكرار محاولات الدفع، وسنؤكد لكم عند عودة المدفوعات للعمل. المرجع: [رقم الحادثة]."

## Records to keep
Incident timeline; list of held dunning case ids and release times; payment ids with `uncertain` or late-success handling and the finance decision; RC-01/02/06 run ids; PSP incident reference.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Related automated evidence (sandbox): 1,000 injected timeouts gave 0 duplicate charges (`payments.int.spec.ts`, per `psp-incident.md`).
