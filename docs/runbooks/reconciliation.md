# Reconciliation (M05 S17)

Status: implemented and tested against the `mock-compute` simulator only. **No vendor behaviour is asserted**; live rows stay BLOCKED (HG-05-01..03).

## Why
A provider call can end *uncertain* (timeout, ambiguous failure): the resource may or may not exist. Retrying blindly can create a second billable resource. The platform therefore **never retries a provision on its own after an uncertain result**: the resource becomes `UNKNOWN`, the operation `needs_reconcile`, and only the reconciler decides.

## Canonical resource states (docs/05 §9)
`DRAFT, QUOTED, AWAITING_PAYMENT, PROVISIONING, ACTIVE, FAILED, DELETING, DELETED, UNKNOWN`. The database refuses any other value and any transition outside the table (`cloud.resources` trigger = `RESOURCE_TRANSITIONS` in `@nuzm/domain`; a test compares all 144 actor/pair combinations). **Only the reconciler may leave `UNKNOWN`** (`app.resource_actor = 'reconciler'`).

## What it does
| Situation | Check | Outcome (`cloud.resource_reconciliations.result`) |
|---|---|---|
| create ended uncertain (UNKNOWN or PROVISIONING with a parked operation) | `findByToken(sha256(orgId\|operationId\|stepId))`, then `inspect` | found + running → `adopted` (operation succeeds, **no second create**); found, not yet running → `adopted` (wait); not found → `absence_pending` until absence is **proven** |
| absence proven (≥ 2 absent observations made after the provider consistency window, spaced ≥ gap, no sighting in between) | — | `absence_proven`: ONE retry with the same token (bounded by the operation's attempts; exhausted → failed, authorization released) |
| provider has no lookup-by-token | cannot prove absence | `cannot_prove_absence` every cycle; after `CLOUD_CASE_AFTER_CYCLES` an admin case is opened; **never retried** |
| delete ended uncertain | `inspect` | gone → deletion completed; still there → delete re-issued (idempotent) |
| start/stop/resize ended uncertain | `inspect` | had taken effect → completed; had not → re-issued once (idempotent) |
| reboot/snapshot ended uncertain | `inspect` | outcome unprovable: **not repeated**, operation failed, admin case |
| ACTIVE resource (scheduled) | `inspect` | `in_sync`; provider state differs → `drift` (provider state recorded, audited); absent → `missing` (second consecutive observation also stops metering) |
| FAILED/DELETED record that has a provision token | `findByToken` | billable resource found → `orphan_suspected` + admin case; **never deleted** unless the explicit flag is on |
| create operation cancelled before it ran | — | `compensated`: resource FAILED, hold released (`operation_cancelled`), order failed |

A single "not found" is never proof (eventual consistency): the window (`CLOUD_CONSISTENCY_WINDOW_SECONDS`, default 120) and the gap (`CLOUD_ABSENCE_GAP_SECONDS`, default 30) come from `reconcileConfigFromEnv()`; the pure rule is `absenceProven()` in `@nuzm/domain`.

## Running it
- Scheduled: `CLOUD_RECONCILE_INTERVAL_SECONDS` (≥ 5; default 0 = off) runs `ReconcilerService.sweep()` inside the API process: due backoff retries of compute operations, then every due resource (UNKNOWN; PROVISIONING/DELETING older than `CLOUD_STUCK_AFTER_SECONDS`; ACTIVE not seen for `CLOUD_DRIFT_INTERVAL_SECONDS`, default 900; recent FAILED/DELETED with a token).
- On demand: `POST /v1/admin/resources/{id}/reconciliations` → 202 + job id (poll `GET /v1/admin/provider-jobs/{id}`; result = outcome). Audited `cloud.reconcile.requested`.
- Before risky actions: delete and actions on an instance whose state is uncertain reconcile first (`pre_delete`, `pre_action`).
- Worker: the sweep currently runs in the API process (like the M04 compliance scheduler). Moving it to `apps/worker` is a registration change (`OperationsService.claimDue({kinds, onlyPending})` and `claimReconcile` are in `@nuzm/platform`); not done in S17.

## Audit events
`instance.create.uncertain|succeeded|failed`, `instance.delete.uncertain|failed`, `compute.instance.deleted`, `compute.instance.action`, `cloud.reconcile.requested`, `cloud.reconcile.absence_proven`, `cloud.reconcile.drift_detected`, `orphan.case.opened`, `cloud.orphan.auto_deleted`. (The `<domain>.<resource>.<action>` audit type needs three segments, so the two-segment names of the M05 prompt are prefixed.)
