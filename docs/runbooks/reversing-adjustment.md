# Runbook: reversing / adjusting a ledger entry

Status: implemented in S07b (`POST /v1/admin/billing/adjustments`, `AdjustmentService`), exercised in `commerce.int.spec.ts`. Not run on production data (none exists).

## Rules
- The ledger is never edited. An approved adjustment posts a **new** transaction: either the mirror image of one original transaction (`reverses`) or explicit balanced lines.
- Two people: finance files the request (`admin:billing:manage`), a **different** person with `admin:billing:approve` (finance or platform_admin) approves or rejects. The same person can never do both (service check and a table constraint). Both need an admin-realm session with recent MFA.
- A transaction can be reversed once (ledger unique index). The request must name a transaction that belongs to the stated organization.
- Customers never see adjustment requests (platform-scope RLS only).

## Procedure
1. Finance files the request: `POST /v1/admin/billing/adjustments` with `Idempotency-Key` and body `{orgId, reason, reverses}` or `{orgId, reason, lines:[{account:{code,org,subledger?}, direction, amountMinor, currency}, ...]}`. The response is the pending request (`status: pending`); nothing is posted yet. Re-sending with the same key returns the same request; the same key with a different body is `idempotency_key_reuse`.
2. A second person reviews and decides: `POST` the same path with `{adjustmentId, decision: "approve"|"reject", note?}`. Approval posts through `billing.post` with idempotency key `adjustment:<requestId>`, then marks the request approved with `transactionId`. A rejection posts nothing. A decision is final (409 afterwards).
3. Verify with `ledger-inspection.md` (balanced transaction, wallet projection refreshed by the `ledger.posted` consumer when the wallet account 2100 is touched). Audit has `billing.adjustment.requested` and `billing.adjustment.approved|rejected`.

## If an approval was interrupted
Approve again. The posting is idempotent: if the first attempt reached the ledger but died before updating the request, the retry finds the same transaction and only records the decision. Never post the lines by hand.

## Gaps
There is no list/read endpoint for requests yet (docs/04 defines only the POST); finance finds pending requests by id from the response or by SQL under break-glass. Proposed additions for the owner: `GET /v1/admin/billing/adjustments` and a separate `.../{id}/approvals` sub-resource.
