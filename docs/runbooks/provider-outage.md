# Runbook — cloud provider outage (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED: written against the mock compute provider and fixtures; no real provider account exists (HG-05-01..03 PENDING). Vendor behaviour is not asserted. Endpoints marked *(planned)* are not yet in `spec/openapi/openapi.yaml`.

## Purpose
Handle an outage, throttling or degradation of an upstream provider (Alibaba, Huawei, Contabo, a node VPS, a data or email vendor) without creating duplicate billable resources, losing customer state or selling what cannot be delivered. Registrar-specific outage: `domains-registrar-outage.md`. Degraded DNS zone: `dns-degraded-zone.md`.

## Trigger / alert
- Provider account health `unhealthy` or circuit breaker `open` (`health.breaker` on `GET /v1/admin/provider-accounts/{id}`; scheduled sweep when `CLOUD_HEALTH_INTERVAL_SECONDS` is on).
- Operations in `waiting_provider` or `needs_reconcile` growing (`queue-recovery.md`); audit `instance.create.uncertain`, `provider.account.health_changed`, `provider.job.failed`.
- A provider status notice (record it in `GET /v1/admin/provider-incidents`, *planned*).

## Severity guidance (proposal)
SEV2 when one provider is down and customers cannot provision or reach resources; SEV1 when customer data is unreachable platform-wide or an uncertain-result storm risks duplicate billable resources; SEV3 for one account or one region with a workaround. See `incident-response.md`.

## Preconditions / access
Admin realm with MFA and step-up. Permissions seen in the spec: `admin:provider:read|manage`, `admin:flags:manage`, `admin:billing:read`. Provider-console access is outside this system and uses the least-privilege account recorded for the HG (never share secrets in a ticket).

## Steps
1. **Open an incident** (`incident-response.md`) and link the provider incident record.
2. **Confirm outside the system** (provider status page, support channel). Our probe is a signal, not proof.
3. **Read what the platform already did.** Calls refused by an open breaker were never sent; their failure is definitive and funds are released. A timeout after a call was sent is `uncertain`: the operation is parked as `needs_reconcile` and **must not be retried by hand** (`reconciliation.md`).
4. **Stop new risk, reversibly.**
   - Hide offers from that provider: set the provider account `status: disabled` (`PATCH /v1/admin/provider-accounts/{id}`, `If-Match`, fields documented in the spec). Offers also require a healthy account and a closed breaker (`provider-onboarding.md`); check with `GET /v1/admin/offers?orgId=<id>&includeIneligible=true`.
   - For a wider stop, switch the flag `cloud.provisioning` off (`PUT /v1/admin/feature-flags`). Existing resources keep their records.
5. **Do not delete or "clean up".** Suspected orphans follow `orphan-handling.md`; auto-delete stays off (`CLOUD_AUTO_DELETE_ORPHANS`).
6. **Watch the customer impact:** `GET /v1/admin/resources?driftState=...` for drift and orphan suspicion; operations list per organization `GET /v1/operations`. Metering: a resource reported `missing` twice stops metering (`reconciliation.md`): note the window for RC-03 later.
7. **Recovery.** When the provider confirms recovery: re-enable the account, run **Verify account** (`POST /v1/admin/provider-accounts/{id}/verification`, poll `GET /v1/admin/provider-jobs/{id}`) to refresh capabilities, regions and health. Let the reconciler finish parked operations (`CLOUD_RECONCILE_INTERVAL_SECONDS` on) or force one resource: `POST /v1/admin/resources/{id}/reconciliations` (202). Re-enable the flag only after the breaker is closed and a probe passes.
8. **Cost and money.** Ask finance to run RC-04 (provider cost vs ledger) and TR-01 (`reconciliation-variance.md`) for the window; provider bills are compared only where `fetchBilling` exists (otherwise skipped and reported: NOT VERIFIED live).

## Verification
Account `healthy`, breaker `closed`; no operation left in `needs_reconcile` older than the stuck threshold (`CLOUD_STUCK_AFTER_SECONDS`); TR-01 shows 0 orphaned billable resources and 0 unknown-state resources older than 1 h (M12 target); offers visible again for a test organization; a mock provisioning probe succeeds.

## Escalation
L2 on-call → L3 cloud domain owner. Owner or finance lead if spend caps or provider contracts are involved (HG-05-04). Security officer if a provider reports a compromise of our credentials: rotate the vault reference (`PATCH` account `credentialRef` resets verification).

## Communication draft
EN: "A cloud provider we use is experiencing problems. Creating new [service] in [region] is temporarily unavailable. Your existing resources and data are not deleted. We will update you by [time] UTC. Reference: [incident id]."
AR: "يواجه أحد مزوّدي الحوسبة السحابية الذين نعتمد عليهم مشكلات حاليًا. إنشاء [الخدمة] الجديدة في [المنطقة] غير متاح مؤقتًا. موارد حسابكم وبياناتكم الحالية لم تُحذف. سنوافيكم بالمستجدات قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."

## Records to keep
Incident timeline; audit events for flag, account status and verification; provider incident reference and timestamps (start, mitigation, recovery); reconciliation results (`cloud.resource_reconciliations`); finance note on any cost variance.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Planned drill: fault injection on the mock adapter (provider timeout and outage), expected 0 duplicate billable resources.
