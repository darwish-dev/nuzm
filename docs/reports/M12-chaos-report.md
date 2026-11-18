# M12 chaos / failure drill report

Status: **PARTIAL.** Assertions run in the integration suites against a real PostgreSQL with faults injected at the adapter, lease and outbox boundary. **Nothing was run on real infrastructure (NOT VERIFIED / BLOCKED).** Registry: `apps/api/src/modules/ops/chaos/drills.ts`, checked by `chaos-drills.spec.ts` (every referenced test file and phrase must exist).

| Drill | Assertion | Evidence on this branch | Real infrastructure |
|---|---|---|---|
| CH-01 provider timeout / uncertain on provision | reconcile before retry, 0 duplicate billable resources | `cloud/compute-reliability.int.spec.ts` (AC-M05-23), `domains/domains-orders.int.spec.ts` (50 randomized fault runs, 0 duplicate registrations/charges) | NOT VERIFIED |
| CH-02 provider outage | circuit breaker, offers hidden, `waiting_provider` | `platform/operations.int.spec.ts`, `cloud/cloud.int.spec.ts` | NOT VERIFIED |
| CH-03 DB primary failover | recover ≤ 5 min, 0 acknowledged writes lost, 0 ledger imbalance | ledger invariants asserted continuously; failover itself not runnable (single local node) | BLOCKED (replicated staging DB) |
| CH-04 queue loss (queue = `platform.outbox`; Redis not used) | 0 lost events, duplicates deduped | `platform/outbox.int.spec.ts` | NOT VERIFIED |
| CH-05 duplicate / out-of-order PSP webhooks | 0 duplicate effects | `payments/refunds-topups.int.spec.ts`, `payments.int.spec.ts`, `common/idempotency.int.spec.ts` (50 parallel POSTs) | NOT VERIFIED |
| CH-06 registrar / email / cloud webhooks | 0 duplicate effects | `domains/domains-webhooks.int.spec.ts` (+ M08 email ×100) | NOT VERIFIED |
| CH-07 worker crash mid-operation | resume via lease expiry | `platform/operations.int.spec.ts` | NOT VERIFIED |
| CH-08 clock skew on ZATCA submit | rejected/deferred | **NOT BUILT** (no skew test) | BLOCKED (HG-03-03) |
| CH-09 vault unavailable | fail closed | **NOT BUILT** (D-12 open) | BLOCKED |
| CH-10 SSO replay / IdP failure | fail closed | `enterprise/saml/saml.spec.ts`, `enterprise.int.spec.ts` | NOT VERIFIED (local IdP) |

AC-M12-07 therefore stays **NOT VERIFIED**: the "0 duplicate / 0 lost / 0 imbalance" claims hold for the injected faults in the listed suites only.
