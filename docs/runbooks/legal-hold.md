# Runbook — legal hold (M04 S13c)

A legal hold stops archival of the data it covers. It does **not** delete or copy anything. Only compliance officers and platform admins (`admin:compliance:manage`) can use it, with a recent MFA check, and it always takes **two different people**.

## When
Counsel or the DPO tells you that records must be preserved (litigation, a regulator's request, an incident investigation). Get the instruction in writing first and note its reference in the reason.

## Place a hold
1. The **requester** sends `POST /v1/admin/compliance/legal-holds` (admin console API) with an `Idempotency-Key`:
   `{"scope": {"orgId": "<organization id>", "dataset": "metering.usage_events"}, "reason": "<10-500 characters, include the counsel reference>", "approvers": ["<requester id>", "<second approver id>"]}`.
   The scope needs an organization, a dataset (`schema.table`), or both. An organization-only hold covers that organization in every dataset; a dataset-only hold covers the whole dataset.
2. The hold is `pending_approval` and has **no effect yet**. Tell the second approver its id (there is no list endpoint yet: spec issue SI-M04-7).
3. The **second approver** (a different compliance officer or platform admin; the requester cannot do this) sends `{"holdId": "...", "decision": "approve", "note": "..."}`. The hold becomes `active`. `reject` closes it without effect; the scope can then be requested again.

## What an active hold does
- The retention dry run (`GET /v1/admin/compliance/retention-policies?evaluate=true`) counts the covered rows as **held**, not eligible.
- `audit.detach_partition()` refuses a partition that contains rows of an organization under a hold, or any partition of a dataset under a dataset hold (`legal_hold_active`).
- Account erasure through data-subject requests (S14) will refuse covered data with `legal_hold_active`.

## Release
Only an active hold, by a **different person than the requester**, with a reason: `{"holdId": "...", "action": "release", "reason": "<10-500 characters>"}`. Record the counsel's release instruction in the reason. Releasing twice changes nothing.

## Checks
- Every step is audited (`compliance.legalhold.requested|created|rejected|released`).
- A hold's scope and people cannot be edited and a hold cannot be deleted (database triggers).

## Open points
There is no endpoint to list holds yet (SI-M04-7); the second approver learns the id out of band. Who may release (the prompt says "dual approval") is implemented as "a different person than the requester": the owner may require a second approver for release as well.
