# M05 — Provider Framework & Compute (Alibaba Cloud, Huawei Cloud, Contabo)

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S16–S23 (8): S16 contract/catalog/vault · S17 routing/quotes/ops/reconciler · S18–S19 Alibaba · S20–S21 Huawei · S22 Contabo · S23 UX, cost reconciliation, acceptance (docs/06) |
| Depends on | M01 **H**, M02 **H**, M03 **H**, M04 **H** (docs/03) |
| Produces | `ProviderAdapter`/`ComputeAdapter` contracts + conformance kit, vault-ref credential handling, provider accounts/health, capability matrix + catalog, routing, `/v1/offers`, compute-kind quotes, durable provisioning, reconciler, compute API, three adapters, compute console + admin provider console |
| Gate | Gate Review per docs/03 §5; live rows BLOCKED unless HG evidence recorded |
| Reference | `09-provider-adapter-interfaces.md` §1, §2, §8 (authoritative contracts), `10` §3, `07` |

Response format: CLAUDE.md §10.

## 1. Objective
Deliver a capability-driven provider layer and verified compute offers. A customer sees and buys only inventory that is (account healthy ∧ region **verified** ∧ plan available ∧ capability supported ∧ residency allows ∧ entitlement/quota allows ∧ price present). Provisioning is durable, idempotent, authorized for cost, reconciled before any retry, and metered. Alibaba ECS and Huawei ECS adapters serve Saudi-region offers **only** if a probe against the live account proves the region (artefact: *verified-region report*); Contabo serves European VPS only for locations/plans the account and probe confirm.

## 2. Preconditions & mocked interfaces
| Item | Needed | If missing |
|---|---|---|
| M01 `platform.operations`, outbox, idempotency, audit | done | stop |
| M02 `commerce.quotes`, ledger posting, metering ingest, spend approvals, quota check | done | stop |
| M03 payment authorization / invoices | done | stop (H) |
| M04 `ResidencyPolicyService`, region-group registry | done | stop |
| Vault (D-12 OPEN) | `VaultClient` interface | Dev file-backed stub only in non-prod; production use BLOCKED until D-12 + HG-01-02 |
| Provider credentials (HG-05-01/02/03) | sandbox/test credentials in non-prod vault | Work against `mock-compute` and recorded fixtures; live rows BLOCKED |
| Provider bills for cost reconciliation | real bills/exports | Fixture-driven reconciliation only → rows `NOT VERIFIED` |

## 3. Requirement IDs closed
FR-CLD-01..10 (adapter contract; catalog/capability matrix; credential vault; routing; quotes; durable resource ops; reconciler; Alibaba; Huawei; Contabo). FR-UI: UI-M05-01..16.

## 4. Automatable engineering tasks
**S16 — contract, catalog, vault**
1. Create `packages/adapters/contracts` (types from docs/09 §1–§2, `contractVersion` 1.0.0) and `packages/adapters/conformance` kit; publish `spec/providers/capabilities.schema.json` capability ids: `compute.provision`, `compute.inspect`, `compute.delete`, `compute.action.start|stop|reboot|resize|snapshot`, `compute.metrics`, `compute.billing-export`, `compute.find-by-token`, `compute.quote-api`.
2. `mock-compute` adapter with fault injection: timeout **after** side effect, timeout before side effect, duplicate create, eventual consistency (inspect lags), rate-limit, partial capability set, region list changes, price changes; deterministic simulated clock.
3. Migrations: `cloud.providers`, `provider_accounts` (vault_ref only), `provider_regions`, `provider_plans`, `provider_capabilities`, `catalog_snapshots`.
4. Vault client + redaction library (canary-secret test); egress allow-list config per adapter.
5. Admin APIs: providers, provider-accounts (+ `verification`), capabilities, catalog-syncs, regions, plans. Health job (scheduled; circuit-breaker state exposed).
**S17 — routing, quotes, operations, reconciler**
6. Offer eligibility function and `GET /v1/offers` (kind=compute); region `verified_at` + `evidence_ref` required; stale verification (> configurable TTL, proposal 7 days) hides offers.
7. Routing: explicit (`provider`, `region`) and automatic (`country|geoGroup`, price, quota, capability, residency, account health); `cloud.routing_rules`; deterministic tie-break; decision recorded in quote (admin-visible).
8. Compute-kind support in `POST /v1/quotes` (M02 endpoint; extension via commerce owner PR): immutable quote, TTL, residency evaluation embedded, tax estimate.
9. Authorization: on create, consume quote → `commerce.authorizations` (hold for first billing period estimate); above spend limit → spend approval required (M02) before operation starts.
10. Durable provisioning workflow on `platform.operations`: `reserve_authorization → place → provision(token) → await/inspect → persist resource → emit events → finalize`; compensation: release authorization on definitive failure.
11. Reconciler: scheduled + on-demand + pre-retry; compares `cloud.resources`/operations to provider inspect/`findByToken`; states `in_sync | drift | orphan_suspected | missing`; **never retries provision unless `findByToken` proves absence**; orphan handling creates admin case, never auto-deletes billable resources without policy flag.
12. `cloud.resources`, `cloud.resource_reconciliations`, `compute.instances`, `instance_actions`, `images`, `snapshots` migrations; compute API (create/list/get/delete/actions/metrics).
**S18 — Alibaba I**
13. `alibaba-ecs` adapter: auth via vault ref (least-privilege RAM user), `probe()`, `listRegions`, `listPlans`, `listImages`; map to docs/09 contract; **no assumption about Saudi availability** — Saudi offers appear only if the live probe lists them. Fixture recorder for sandbox/live responses (redacted).
14. Generate **verified-region report** (`docs/reports/evidence/M05/verified-region-report-alibaba-<acct>-<date>.{json,md}`) from live probe output — only when HG-05-01 evidence exists; otherwise report states `NOT VERIFIED`.
**S19 — Alibaba II**
15. Provision (idempotency token via provider-supported mechanism or tag lookup; documented in adapter README with citation of the official doc page read), inspect, actions (per-probe), delete, metrics if supported, `fetchBilling`.
16. Conformance kit pass on recorded fixtures; live job definition `live-verify-alibaba` (human-triggered; see §5/LV protocol).
**S20–S21 — Huawei I/II** 17–20. Same sequence for `huawei-ecs` (probe, verified-region report, lifecycle, billing fetch, conformance, `live-verify-huawei`).
**S22 — Contabo**
21. `contabo-vps` adapter: per-account **plan-specific capability detection** (each action individually probed; unsupported → disabled); location list from account/API with `geoGroup=EU` mapping from verified country; create/inspect/delete + only the actions the probe supports; `fetchBilling` if supported (else cost capture via manual import path, flagged).
**S23 — UX, cost recon, acceptance**
22. Provider cost capture: adapters' `fetchBilling` → `metering.provider_cost_records`; finrec hook for reconciliation class **RC-04 (provider cost vs provider bills; defined in docs/11 — confirm ID there)** extended via finrec owner PR; margin report input.
23. Compute console + admin provider console screens; e2e; runbooks; report.

## 5. Human approvals & external gates
| ID | Item | Agent does meanwhile | Default |
|---|---|---|---|
| HG-05-01 | Alibaba account(s), RAM user, Saudi-region eligibility confirmation | Build against mock + fixtures; no live calls | PENDING → live rows BLOCKED |
| HG-05-02 | Huawei account(s), IAM user, eligibility confirmation | same | PENDING |
| HG-05-03 | Contabo account + API credentials; confirmed plan/location access | same | PENDING |
| HG-05-04 | Provider quota increases and spend caps | LV jobs configured with agent-side spend cap but cannot run | PENDING |
| D-12 | Secrets/KMS product | dev stub | OPEN |
| D-15 | Control-plane hosting location | Not required for adapters | OPEN |
| D-23 | Pricing/margin policy (offer price = provider cost + margin rules) | price composer reads price book v1 placeholder; offers without a Nuzm price are hidden | OPEN |
**Live verification protocol (human-triggered only):** LV-1 owner enables job `live-verify-<provider>` with spend cap and records HG evidence; LV-2 dedicated test account/project, resources tagged `nuzm-live-verify`; LV-3 steps: probe → create smallest eligible plan → inspect → each supported action → snapshot if supported → delete → fetch billing record; LV-4 teardown verifier proves zero residual resources (fails job otherwise and pages owner); LV-5 redacted raw evidence indexed in `docs/reports/evidence-index.md`; LV-6 result labelled `LIVE-VERIFIED` (with evidence ids) or `NOT VERIFIED`; the agent never labels live rows PASS from mock runs and never runs LV jobs unprompted.

## 6. API specifications (doc 04 §2.5, exact)
Common: org context from token; POST create/charge requires `Idempotency-Key`; async returns `202` + `operationId`; problem+json.
| Endpoint | Portal / authz | Key fields | Behaviour / errors |
|---|---|---|---|
| GET `/v1/offers` | C A R; permission `offers:read` | query `kind=compute`, `country`, `region`, `geoGroup`, `provider`, `minVcpu`, `minMemoryMb`, `cursor`, `limit` → `{items:[{offerId, kind, country, dataRegion, plan{vcpu,memoryMb,diskGb,bandwidth?}, price{amount,currency,period}, capabilities[], verifiedAt}], nextCursor}` | Only eligible inventory; provider identity & `providerRegionId` hidden for C (visible X); 422 `invalid_filter` |
| POST `/v1/quotes` (kind=compute; endpoint owned by M02) | C A R; `compute:quote:create` | `{kind:'compute', offerId \| routing{mode, country\|region\|geoGroup\|provider}, spec{imageId, diskGb?, count}, term}` → `Quote{id, expiresAt, lines, taxEstimate, residency{decision,policyVersion}}` | Immutable; 403 `residency_denied`; 422 `no_eligible_offer` |
| POST `/v1/compute/instances` | C A R; `compute:instance:create` | `{quoteId, name, projectId, environmentId?, sshPublicKeys[], tags}` → `202 {instance{id,status:'provisioning'}, operationId}` | Re-evaluates residency + capability + quota at execution (TOCTOU); 409 `quote_expired\|quote_consumed`, 409 `spend_approval_required{approvalId}`, 403 `residency_denied`, 429 `quota_exceeded`, 422 `unsupported_capability` |
| GET `/v1/compute/instances`, `/{id}` | C A R; `compute:instance:read` | `Instance{id,status,dataRegion,country,plan,publicIps,createdAt,capabilities[],operationId?}` | Other-org id → 404 |
| DELETE `/v1/compute/instances/{id}` | C A R; `compute:instance:delete`; `If-Match` | → `202` operation | 409 `deletion_protected`; reconcile-before-delete when state uncertain |
| POST `/v1/compute/instances/{id}/actions` | C A R; `compute:instance:act` | `{type:'start\|stop\|reboot\|resize\|snapshot', params}` → `202` | Only types in instance capability set else 422 `unsupported_capability`; 409 `invalid_state`; idempotent per key |
| GET `/v1/compute/instances/{id}/metrics` | C A R | window params → series | 422 `unsupported_capability` if provider has none |
| GET/POST `/v1/admin/providers`, GET `/v1/admin/providers/{id}` | X; `provider_admin` | provider registry | |
| GET/POST `/v1/admin/provider-accounts`, GET/PATCH `…/{id}`, POST `…/{id}/verification` | X; `provider_admin` | `{providerId, name, credentialRef:'vault://…', scopeNote}`; verification → `202` op producing capability report + region report | Credential values never accepted; only refs |
| GET `/v1/admin/provider-accounts/{id}/capabilities`, POST `…/catalog-syncs`, GET `…/regions`, GET `…/plans` | X | capability matrix with `state, probedAt, evidenceRef` | Sync is async op |
| GET/POST `/v1/admin/routing-rules` | X | rule `{priority, match, action, enabled}` | versioned; audited |
| GET `/v1/admin/resources`, POST `/v1/admin/resources/{id}/reconciliations` | X | resource + drift state; forced reconcile → `202` | |
| POST `/v1/webhooks/cloud/{provider}` | provider | signed event | Verified, deduped by provider event id, `2xx` after durable record; unsupported providers 404 |
| GET `/v1/operations/{id}`, `/v1/resources` | (M01) | used here | |

## 7. Database migrations
Owners per docs/05: `cloud` and `compute` created in M05; `commerce`, `finrec`, `platform` extended via owner PR. Migration range reserved in `spec/db/ownership.yaml` at S16.
| Table | Key columns / constraints |
|---|---|
| `cloud.providers` | id, key (`alibaba`,`huawei`,`contabo`,`cloudpanel`,…), kind, status |
| `cloud.provider_accounts` | id, provider_id, name, `vault_ref`, health_state, last_health_at, spend_cap_minor, verified_at; **no secret columns** (CHECK vault_ref like `vault://%`) |
| `cloud.provider_regions` | account_id, provider_region_id, country_code, **verified_at, evidence_ref NOT NULL when `verified`**, state; unique (account_id, provider_region_id) |
| `cloud.provider_plans` | account_id, region_id, plan_ref, vcpu, memory_mb, disk_gb, bandwidth, provider_price_minor, currency, period, availability, last_seen_at |
| `cloud.provider_capabilities` | account_id, capability_id, state (`supported|unsupported|unknown`), probed_at, evidence_ref |
| `cloud.catalog_snapshots` | account_id, taken_at, content_hash, payload_ref |
| `cloud.routing_rules` | id, version, priority, match jsonb, action jsonb, enabled |
| `cloud.resources` | id, org_id, kind, provider_account_id, provider_ref, state, data_region, provider_region_id, created_by_operation_id, last_seen_at, drift_state; RLS; unique (provider_account_id, provider_ref) |
| `cloud.resource_reconciliations` | resource_id, run_at, observed jsonb, result, action_taken |
| `compute.instances` | id, org_id, project_id, environment_id, resource_id (opaque), name, plan jsonb, status, capabilities jsonb, quote_id (opaque), deletion_protected, version; RLS; index (org_id, status) |
| `compute.instance_actions` | instance_id, type, params, operation_id, status; unique (instance_id, idempotency_key) |
| `compute.images`, `compute.snapshots` | catalogue per account; snapshot ref + size for metering |
RLS on all `org_id` tables; provider/catalog tables tenant-less, admin-only. Idempotency uniqueness: (org_id, operation_kind, idempotency_key). Reversal: dev/staging down scripts; production forward-fix; no destructive column drops without expand/contract.

## 8. UI screens
| ID | Portal | Route | Purpose | States / roles |
|---|---|---|---|---|
| UI-M05-01 | C A R | `/compute/offers` | Browse verified offers with country/geoGroup/spec filters | empty "no verified offers", price display, org members |
| UI-M05-02 | C A R | `/compute/instances/new` | Wizard: offer → image → keys → quote review (cost, tax, residency result) → confirm | quote expired, residency denied, spend-approval-required |
| UI-M05-03 | C A R | `/compute/instances` | Instance list | provisioning/failed/drift badges |
| UI-M05-04 | C A R | `/compute/instances/[id]` | Overview, capabilities-based action menu, operation timeline | unsupported actions hidden, uncertain-state banner |
| UI-M05-05 | C A R | `/compute/instances/[id]/metrics` | Metrics (if supported) | unsupported empty-state |
| UI-M05-06 | C A R | `/compute/instances/[id]/snapshots` | Snapshots (if supported) | |
| UI-M05-07 | C A R | `/billing/spend-approvals` (M02 screen extended) | Approve provisioning above limit | approver roles |
| UI-M05-08 | X | `/providers` | Provider registry & health | circuit state |
| UI-M05-09 | X | `/providers/accounts` | Accounts list, add (vault ref), run verification | credential never shown |
| UI-M05-10 | X | `/providers/accounts/[id]` | Capability matrix, regions with verified evidence, catalog sync, plans | `unknown` shown as unsupported |
| UI-M05-11 | X | `/providers/routing` | Routing rules editor + dry-run simulator | |
| UI-M05-12 | X | `/cloud/resources` | Inventory across orgs, drift/orphan filters, force reconcile | audited cross-org read |
| UI-M05-13 | X | `/cloud/operations` | Operations monitor (stuck, needs_reconcile) | |
| UI-M05-14 | X | `/finance/provider-costs` | Provider cost records, RC-04 results, margin view | variance highlighted |
| UI-M05-15 | X | `/providers/live-verification` | LV job status, evidence index, LIVE-VERIFIED/NOT VERIFIED labels (owner triggers) | agent cannot trigger |
| UI-M05-16 | A | `/agency/clients/[clientId]/compute` | Read view of client's compute (delegation per M11; hidden until M11 flag) | feature flag |

## 9. Security, compliance & tenant-isolation requirements
- Credentials: vault refs only; adapter logs redacted; canary-secret test; per-adapter egress allow-list; least-privilege provider users documented (what permissions needed — from official docs, cited).
- Tenant isolation: all org tables RLS; provider tags carry opaque org hash (not name); cross-tenant resource lookup by id returns 404; reconciler never exposes other orgs' resources.
- Residency: `evaluate()` at offer filtering (class `customer-content`), quote, and provisioning; `data_region` persisted; snapshots inherit region; policy changes re-evaluated at next mutation.
- Audit: `provider.account.created|verified`, `provider.capability.changed`, `routing.rule.changed`, `quote.created`, `instance.create.requested|succeeded|failed`, `instance.action`, `instance.deleted`, `reconcile.drift_detected`, `orphan.case.opened`.
- PII: SSH public keys (class `internal`), IPs (`personal` in some contexts → class `personal`; retention per M04).
- Destructive actions (delete) require `If-Match` and `deletion_protected=false`; reconciler never deletes automatically unless explicit admin flag + audit.
- Webhook verification and replay window; unknown providers rejected.

## 10. Metering & billing hooks
Meters: `compute.vcpu_hours`, `compute.memory_gb_hours`, `compute.disk_gb_months`, `compute.snapshot_gb_months`, `network.egress_gb`.
| Emit point | Event |
|---|---|
| Instance `running` interval open/close (from operation results and reconciler observations) | usage events with `resource_id`, interval, `event_id = hash(resource_id, interval_start)` for dedupe; hourly sampler closes open intervals |
| Disk allocation | `compute.disk_gb_months` accrual per hour fraction |
| Snapshot create/delete | `compute.snapshot_gb_months` |
| Egress | **only** when the provider exposes per-resource traffic via probe; otherwise meter disabled, plan states "bandwidth included/not metered", row `NOT VERIFIED` |
Quota checks: M02 quota check on `compute.instances.max`, `compute.vcpu.max` before accepting create (429 `quota_exceeded`). Cost side: `fetchBilling` → `metering.provider_cost_records` (provider currency + SAR conversion rate recorded). Ledger postings only through M02 service.

## 11. Automated tests
- **Conformance kit** (every adapter, mock + fixtures): capability probe honesty (claimed ⊆ probed), idempotent provision with replayed token, `findByToken` after timeout, delete idempotency, unsupported action rejection, error normalization table, rate-limit handling, secret redaction.
- **Eligibility property test:** ≥10,000 randomized catalog/account/region/capability/residency states; invariant: offer returned ⇒ all conditions true; 0 violations.
- **Timeout reconciliation:** inject timeout-after-side-effect 1,000 randomized runs; invariant: ≤1 billable resource per idempotency key; reconciler adopts the orphan instead of re-provisioning.
- **Concurrency:** 50 parallel POST with same `Idempotency-Key` → 1 operation, 1 authorization, 1 instance; 50 parallel different keys against quota limit → exactly limit succeed.
- **Quote:** immutable, TTL expiry, consumed once, price drift between quote and provision → fail `price_changed` not silent charge.
- **Residency TOCTOU:** policy tightened between quote and provision → denied at execution.
- **Spend approval:** above limit blocks; reject → operation cancelled, authorization released; approve → proceeds.
- **Drift:** resource deleted at provider → `missing` within configured interval (fake clock); orphan found by tag → case opened.
- **Webhook:** duplicate event id, bad signature, replay outside window.
- **Metering replay:** fixture timeline (start/stop/resize) yields exact expected `vcpu_hours`; duplicate events no double count.
- **Cross-tenant:** RLS suite; instance id of org B returns 404 for org A; admin reads audited.
- **E2E (mock):** offer → quote → create → running → stop → resize (if capability) → snapshot → delete; UI-M05-01..07 flows; axe ar/en.
- **Contract:** OpenAPI conformance for all §6 endpoints; `spec:drift` clean.
- **Security:** canary secret not found in logs/evidence/DB; SSRF guard on adapter endpoints; dependency scan.
- **Load (proposal):** 200 concurrent offers queries p95 < 300 ms; 50 concurrent provisions with mock adapter without lost operations.

## 12. Deliverables
Code (packages/adapters/*, cloud/compute modules, worker jobs), migrations, `spec/openapi/{cloud,compute}.yaml`, `spec/providers/capabilities.schema.json`, adapter READMEs citing official documentation pages with read dates, UI, runbooks (`provider-onboarding.md`, `reconciliation.md`, `live-verification.md`, `orphan-handling.md`), `docs/reports/M05-report.md`, evidence folder `docs/reports/evidence/M05/`, demo script: add mock account → verify → offers → quote → provision with injected timeout → reconciler adopts → metering → delete.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Default |
|---|---|---|---|
| AC-M05-01 | `mock-compute` passes 100% of conformance cases | kit report | PENDING |
| AC-M05-02 | Eligibility property test: ≥10,000 states, 0 violations | test log | PENDING |
| AC-M05-03 | With no verified Saudi region, `GET /v1/offers?kind=compute&country=SA` returns 0 items and UI shows empty state | e2e | PENDING |
| AC-M05-04 | Timeout fault injection: 1,000 runs → 0 duplicate billable resources | test log | PENDING |
| AC-M05-05 | 50 parallel same-key creates → exactly 1 instance/operation/authorization | test log | PENDING |
| AC-M05-06 | Quote immutability/TTL/consume-once/price-change cases (≥6) pass | test log | PENDING |
| AC-M05-07 | Residency denial at quote and at provision (TOCTOU) | test log | PENDING |
| AC-M05-08 | Spend-approval flow (approve/reject/expire) pass | e2e | PENDING |
| AC-M05-09 | Unsupported action → 422 and hidden in UI for 100% of capability-less fixtures | e2e | PENDING |
| AC-M05-10 | Drift/missing detected within configured interval (≤ 2 reconcile cycles) | test log | PENDING |
| AC-M05-11 | Metering replay exact (0 diff) on 5 fixture timelines; duplicates no effect | test log | PENDING |
| AC-M05-12 | RLS suite 0 leaks on `cloud.resources`, `compute.*`; cross-tenant id → 404 | RLS report | PENDING |
| AC-M05-13 | Canary secret absent from logs, evidence, DB dumps | scan | PENDING |
| AC-M05-14 | UI-M05-01..16 e2e pass, axe 0 critical/serious (ar, en) | e2e+axe | PENDING |
| AC-M05-15 | Alibaba verified-region report from live account | report + HG-05-01 | **BLOCKED until HG-05-01** |
| AC-M05-16 | Alibaba provision/inspect/actions/delete live | LV evidence | **BLOCKED until HG-05-01, HG-05-04** (`NOT VERIFIED` otherwise) |
| AC-M05-17 | Huawei verified-region report from live account | report + HG-05-02 | **BLOCKED until HG-05-02** |
| AC-M05-18 | Huawei lifecycle live | LV evidence | **BLOCKED until HG-05-02, HG-05-04** |
| AC-M05-19 | Contabo capability probe + EU location verified before any sale | LV evidence | **BLOCKED until HG-05-03** |
| AC-M05-20 | Provider bill reconciliation (RC-04) on real bills/exports | finrec report | **BLOCKED until HG-05-01..03**; fixture logic PASS only |
| AC-M05-21 | Saudi offers shown only for regions with evidence_ref (constraint test) | DB test | PENDING |
| AC-M05-22 | 100 concurrent requests with the same `Idempotency-Key` create exactly 1 resource and 1 authorization/charge | concurrency test output | PENDING |
| AC-M05-23 | Provider timeout moves the resource to `UNKNOWN`, reconciles via `findByToken`/`inspect`, and never issues a second create | fault-injection test output | PENDING |
| AC-M05-24 | Resource lifecycle uses only the canonical states in docs/05 §9 (state-machine test rejects others) | unit test | PENDING |

## 14. Handoff
M06 consumes compute instances as CloudPanel nodes (`ComputeAdapter` + provisioning API); M07/M08 consume provider framework, routing and reconciler; M08 data self-operated families run on M05 compute; M10 sandbox runners use compute with isolation (D-21). Open: D-12, D-15, D-23, HG-05-01..04.

## 15. Compliance hooks checklist
- [ ] Residency `evaluate()` on offers, quotes, provisioning, snapshots; `data_region` set on all resources
- [ ] PII/class annotations for new columns in manifest; SSH keys/IPs classified
- [ ] Audit events (§9) emitted; reconciler admin actions audited
- [ ] Retention: operation/reconciliation logs follow M04 policies; verified-region evidence retained with evidence index
- [ ] ROPA entries for each provider processor (Alibaba, Huawei, Contabo) created as PROPOSAL, region data from probe

**Spec issues found:** SI-M05-1 docs/05 has both `platform.resources_index` and `cloud.resources` (overlapping inventory); SI-M05-2 reconciliation class IDs (RC-xx) are not defined in docs 01–09 (expected from docs/11); SI-M05-3 permission/role names not defined in docs 01–09 (M01 role catalogue); SI-M05-4 `/v1/offers` price visibility/margin source depends on D-23 and M02 price book, not specified in doc 04; SI-M05-5 no endpoint for orphan case management besides admin resources.

## Completion instruction
Do not mark M05 DONE until every acceptance row is evidenced. Rows depending on HG-05-01..04 remain BLOCKED/NOT VERIFIED until the owner records evidence; mock or fixture runs never convert them to PASS. Never invent provider API methods, regions, plans or prices; cite official documentation for each adapter call. The agent may not mark any HG GRANTED or start a live-verification job without the owner's trigger. Deliver `docs/reports/M05-report.md` in the CLAUDE.md §10 format.
