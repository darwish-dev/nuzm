# Runbook — Refund procedure (M03 S10a)

Audience: finance. Endpoint: `POST /v1/admin/billing/refunds` (admin realm, MFA + step-up, `admin:billing:manage`, `Idempotency-Key` required).
PSP in this repository: the deterministic sandbox PSP only (D-10 / HG-03-02 open). **No refund has ever been sent to a real PSP.**

## 1. Before you refund
1. Find the payment (`GET /v1/billing/payments?invoice=…` as the customer, or the finance payments screen when it exists, S12). Only `succeeded` / `partially_refunded` payments can be refunded.
2. Decide the legal side first. A refund moves money; it does **not** correct the invoice. If the invoice was wrong, issue a **credit note** (`POST /v1/billing/invoices/{id}/credit-notes` flow, `docs/runbooks/` invoice-correction path) and pass its id as `creditNoteId`. The credit note becomes `refunded` when the refunds against it cover its total.
3. Check the amount: it may not exceed *captured − refunded − pending refunds* (422 otherwise; the response states the remaining amount).

## 2. Request
```
POST /v1/admin/billing/refunds
Idempotency-Key: <a new uuid per intended refund>
{ "paymentId": "...", "amount": "4000", "reason": "customer request", "creditNoteId": "..." }
```
`amount` is in minor units (4000 = 40.00 SAR). Reuse the same `Idempotency-Key` to retry after a network error: you get the same refund back (200) and the PSP is not asked twice. A different body under the same key is refused (422).

## 3. Reading the answer
| Status | Meaning | What to do |
|---|---|---|
| 201 `succeeded` | PSP refunded; ledger entry posted once | Nothing |
| 201 `failed` (+ `failureCode`) | PSP refused; reservation released; nothing posted | Fix the cause, request a **new** refund (new key) |
| 202 `pending` | PSP has not finished or the answer was lost; the amount is reserved | Wait; the sweeper (`RefundService.processPending`) asks the PSP by merchant reference `nuzm_rf_<id>` and adopts the result. **Do not file the same refund again** |

## 4. A refund stays `pending`
1. Look up the row: `SELECT id, status, merchant_reference, created_at FROM payments.refunds WHERE status = 'pending'`.
2. The platform asks the PSP (`retrieveRefund`) before it ever sends anything again. If the PSP knows the reference, its answer is adopted; only if the PSP has **no** record is the request sent once more with the same reference (the PSP deduplicates by it).
3. Pending for more than an hour: contact the PSP with the merchant reference; do not create a second refund for the same amount (it would be refused anyway while the first one reserves the amount).

## 5. Wrong refund
A succeeded refund is final. Money returned by mistake is recovered by the customer paying again; the ledger is never edited (use the adjustment flow with a second approver for any bookkeeping correction).

## 6. Not supported yet
- Refunding a **wallet top-up** payment (needs the unspent-credit rule; owner decision).
- Listing refunds over the API (docs/04 defines only the POST; needed for the finance refunds screen, S12 — spec gap recorded in the S10a report).
