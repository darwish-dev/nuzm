# Runbook: reversing / adjusting a ledger entry

Status: the **ledger service** (`LedgerService.reverse`, recipe `adminAdjustment`) is implemented and tested in S05. The HTTP endpoint `POST /v1/admin/billing/adjustments` (finance request + second approver) is **not built yet** (planned S07), so today a reversal can only be run by an engineer through the service with a ticket. This runbook describes the target process and what is verifiable now.

## Rules
- Never edit or delete ledger rows. A reversal posts the mirror image of the original and references it.
- A transaction can be reversed once (unique index). A repeat with the same idempotency key returns the first result.
- Every reversal needs a reason, an actor, and (once the endpoint exists) a second approver. It writes an audit event in the same database transaction.
- Customer-visible credits are `credit grant` recipes, not reversals.

## Procedure (target, S07)
1. Finance raises an adjustment request with the original transaction id, reason and amount (full reversal only in v1).
2. A second finance/platform admin approves. The system posts the reversal with key `reverse:<originalId>`.
3. Verify with `ledger-inspection.md` (transaction balanced; wallet projection updated by the `ledger.posted` consumer).
4. Tell the customer through the normal channel; no silent changes.

## Today
Engineers use `LedgerService.reverse(originalId, reason, idempotencyKey, actorUserId)` from a script run under the admin scope, with the approving ticket recorded in the incident note. Do not run it against production without the owner's explicit approval.
