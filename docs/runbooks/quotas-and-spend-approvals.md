# Runbook: quotas, spending limits and spend approvals

Status: written against S07a, exercised in `quotas-spend.int.spec.ts`. Not run on production data (none exists). Quota limits and caps are placeholders until HG-02-01 / D-23.

## Quotas
- Limits come from the effective entitlements (`billing.effective_limits(org)`: assigned or default plan version, newest override per group). A group is measured by exactly one meter (`billing.quota_meters`: compute, storage, network, email, ai today). A group with a limit but no meter shows `measured: false`: it is **not** enforced. Add a mapping row (forward migration) when its measuring meter is decided.
- State per group and UTC month (`billing.quotas`, a rebuildable projection): `ok` below 80 %, `soft` from 80 %, and at 100 % `soft` (mode soft) or `hard` (mode hard). `hard` blocks only NEW consumption through `QuotaService.assertAllowed` (callers: quotes in S07b, resource workers later). Nothing is ever deleted.
- Evaluation runs after every API ingest for the organizations touched and on `GET /v1/quotas`. Usage that arrives through the worker outbox (`usage.recorded`) is evaluated at the next read or API ingest: **no sweeper exists yet** (gap, see S07a report).
- Each newly crossed threshold (80, 100) is announced once: audit `billing.quota.threshold_crossed` and an in-app notification `billing.quota_threshold` to members whose role has `billing:manage`.
- Raising a limit for one organization: `EntitlementService.setOverride(orgId, {kind:'meter_limit', key:<group>, limit, mode})` (admin tooling; docs/04 defines no endpoint). The newest override wins.
- Rebuild the projection: `DELETE FROM billing.quotas WHERE org_id = '<org>'` as the table owner, then call `GET /v1/quotas` (or any evaluation) for that organization. Thresholds already announced in the deleted rows will be announced again; tell the owner first.

## Spending limits
- One cap per organization and optionally per project (`PUT /v1/billing/spending-limits`, `billing:manage`). Replacing needs `If-Match` (428/412). Creating or lowering a cap below this month's spend (rated usage + approved spend) is refused (422 `spend_approval_required`).
- Rated usage has no project attribution before M05: project caps currently see approved spend only.
- Alert thresholds are stored but **no spend alerts are sent yet** (gap).

## Spend approvals
- Requested by any member with `spend:request` (developer and above) for one quote or operation; one open request per subject; expires after `SPEND_APPROVAL_TTL_HOURS` (default 24).
- Four-eyes: applies when the amount is above the organization's `fourEyesAboveMinor`, or always when it is not set. The requester can then never decide the request (service check and a table constraint).
- Deciding needs `billing:manage`, a session with recent MFA (step-up), no impersonation, no API key. A decision is final; the row is never updated again or deleted.
- `SpendService.evaluate/assertAllowed` is the enforcement point for quotes (S07b): over the cap, a covering approved approval for exactly that subject is required.
- An approval request for a quote id is not verified against `commerce.quotes` until S07b creates that table.

## Incidents
- Approver cannot decide: check `billing:manage` on their role, MFA freshness, and whether they are the requester under four-eyes.
- A cap needs to go below current spend urgently: raise the cap first or decide/deny the pending approvals; there is intentionally no override.
