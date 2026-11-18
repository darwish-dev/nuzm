# S17 report — Offers, routing, compute quotes, durable provisioning, cost authorization, reconciler and the compute API skeleton (M05 sprint 17)

Status: implemented and verified against real PostgreSQL (project-local, port 54331) and unit/property suites. **Everything runs against the `mock-compute` simulator: every adapter-dependent row is `NOT VERIFIED`; live rows are BLOCKED (HG-05-01/02/03/04).** No UI (S23). Owner-directed exception: M05 started before the M03/M04 gate reviews were signed (see S16 report).

## A. Repository findings and assumptions

- Extension points used: M02 `QuotePricerRegistry` (a `compute` pricer plugs in; `QuoteService` gained an optional `itemsFrom()` and optional `residency`/`preferences` in the pricer result — a commerce-owner change, backwards compatible), `OrderService.createFromQuote` (consumes the quote: validity, quota group, spend limit/approval), `QuotaService`, `PriceBookService`, M01 `OperationsService` (new: `id` on create, `claimDue({kinds, onlyPending})`, `claimReconcile`, `releaseLease`, `resumeFromReconcile`, `failPermanently`) and M04 `ResidencyPolicyService` (new: `useRegionResolver()`; `resolveTarget` is async) with the hook SDK `assertResidency`.
- Decisions (none changes a public contract beyond the M05 prompt):
  - **Cost authorization** = the M02 order + (when the spend cap needs it) the existing approved spend approval, plus a new `commerce.authorizations.kind = 'hold'` for the first period amount (migration 0630; **not** a ledger posting) and an append-only `commerce.authorization_releases` row on definitive failure/cancellation.
  - **Spend approval** keeps the M02 semantics: above the cap the create is refused (registry `spend_approval_required`, **422**; the M05 table says 409 — registry kept) with the pending `approvalId` in the problem; once approved, the same quote proceeds. No operation exists before approval, so "reject → operation cancelled" is realised as "stays refused"; the cancel/definitive-failure → release path is tested separately.
  - `quota_exceeded` stays **422** (registry) although the M05 table says 429.
  - Customer price = M02 price book (D-23 OPEN): meters `compute.vcpu_hours` (730 h/month, PROPOSAL), `compute.memory_gb_hours`, `compute.disk_gb_months` must all have a price in the effective version, otherwise the plan has no Nuzm price and is hidden.
  - Instance/vCPU quotas (`compute.instances.max`, `compute.vcpu.max`) = entitlement meter groups `compute_instances` / `compute_vcpu` (via `billing.effective_limits`), PROPOSAL defaults 10 / 40 when an org has none; admission is serialized per organization with an advisory lock.
  - Provider regions in residency decisions resolve from `cloud.provider_regions` (verified_at + evidence; in a production profile only `live` evidence); `data_region` = the residency region GROUP of the verified region (`in_kingdom`, `eu`, …).
  - The quote is issued and expires against the wall clock; the module clock (provider-side observations) is separate (matters only in tests).
  - Audit names need three segments (`<domain>.<resource>.<action>`): `compute.instance.deleted`, `compute.instance.action`, `cloud.reconcile.drift_detected` (+ `.requested`, `.absence_proven`), `cloud.orphan.auto_deleted`; the others are as in the M05 prompt.
  - `POST /v1/webhooks/cloud/{provider}` answers 404 for every provider (no adapter implements webhook parsing yet); nothing is stored.
  - **Observed in M04 (not changed):** `RopaService.upsert` does not invalidate the residency service's processor cache, so a processor deregistration takes effect after the cache TTL; tests call `invalidate()`.
- Spec issues: SI-M05-1 resolved by implementing only `cloud.resources` (no `platform.resources_index`); SI-M05-2 (RC-xx ids) and SI-M05-4 (price visibility/margin) stay open for S23/D-23; SI-M05-5 open (no case-closing endpoint; see `docs/runbooks/orphan-handling.md`); SI-M05-6 recorded in S16.

## B. Plan and changed files

Spec first: `spec/openapi/openapi.yaml` (+13 operations, `CreateQuote` extended), `spec/openapi/errors.yaml` (+5 codes), `spec/db/ownership.yaml` (tables, tenant-less, classification), `spec/compliance/residency-hooks.yaml` (M05 hook **implemented**) and `encryption-retrofit.yaml`, docs/04 rows. Migrations `cloud/0610`, `compute/0620`, `commerce/0630`. Domain (`packages/domain/src/cloud/*`: resource states, offer eligibility, routing, absence proof, interval metering). Platform ops additions. API: `apps/api/src/modules/cloud/**` (offers, routing, compute pricer, instance service, provisioning executor, reconciler, metering sampler, quota guard, admin resources/offers/routing controllers, webhook stub, flags, images), `commerce` (pricer interface, quote service, quotes controller permission), `compliance` (region resolver). Tests: `compute-flow.int.spec.ts`, `compute-reliability.int.spec.ts`, `eligibility.property.spec.ts`, `packages/domain/src/cloud/cloud.spec.ts`, `testing/compute-kit.ts`. Docs: runbooks `reconciliation.md`, `orphan-handling.md`, `provider-onboarding.md` (extended), `residency-hooks.md` (updated).

## C. Implemented features, API and UI screens

- **Offers** `GET /v1/offers` (perm `offers:read`; flag `cloud.provisioning`): only eligible inventory; keyset paging by price; customer view hides provider identity/region/cost; `provider`/`region` filters are admin-only (422 `invalid_filter` for customers). `GET /v1/admin/offers?orgId=` (admin view, `includeIneligible` lists the failing conditions).
- **Routing** (`cloud.routing_rules`, versioned immutable rows, audited): explicit (provider+region) and automatic (country|geoGroup); rules `prefer|exclude|pin` with match on country/geoGroup/mode; deterministic tie-break (rank, price, provider key, account id, region id, plan ref); the decision is stored in the quote (internal) and never shown to customers. `GET/POST /v1/admin/routing-rules`.
- **Compute quotes** via `POST /v1/quotes` (`kind: compute`, perm `compute:quote:create`): offerId or routing, spec `{imageId, diskGb?, count}`, term month; three priced lines, provisional tax estimate, embedded residency decision (`decision`, `policyVersion`, `dataRegion`; audited hook), immutable, TTL 15 min.
- **Compute API**: `POST/GET /v1/compute/instances`, `GET/DELETE …/{id}` (If-Match, 409 `deletion_protected`, reconcile-before-delete), `POST …/{id}/actions` (capability-gated, idempotent per key; resize via an eligible offer in the same placement), `GET …/{id}/metrics` (422 when unsupported). Cross-tenant ids → 404.
- **Durable provisioning** (`platform.operations` kinds `compute.instance.create|delete|action`): steps `reserve_authorization → place (TOCTOU re-check of eligibility, residency (mutation, audited), capability, quota entitlement, price) → provision(token) → inspect → persist → finalize`; uncertain → `UNKNOWN` + `needs_reconcile`; definitive failure → compensation (resource FAILED, hold released, order failed). The provider is **never** called again after an uncertain result except through the reconciler's proven-absence rule.
- **Reconciler** (`docs/runbooks/reconciliation.md`): states `in_sync | drift | orphan_suspected | missing` plus operation-level results; forced reconciliation `POST /v1/admin/resources/{id}/reconciliations` (202 + job); cross-org inventory `GET /v1/admin/resources` (audited).
- **Metering**: running intervals (`compute.instance_intervals`, one open interval per instance by unique index) → hourly sampler → usage events through the outbox (`compute.vcpu_hours`, `compute.memory_gb_hours`, `compute.disk_gb_months`), deterministic event ids, `emitted_until` in the same transaction. Egress is **not** metered (no provider probe exposes per-resource traffic): NOT VERIFIED. Snapshot size is unknown without a provider answer: snapshot metering NOT VERIFIED.
- **Hooks**: `M05.offers-quote-provision` implemented (offer filtering via `evaluate`, quote and provision via `assertResidency` with `mutation: true`); `cloud.resources`, `compute.instances`, `compute.snapshots`, `compute.instance_intervals` carry `data_region`.
- UI: none (S23).

## D. Migrations and rollback

- `cloud/0610`: `routing_rules` (append-only), `resources` (canonical states CHECK + transition/actor trigger, RLS by org + platform read), `resource_reconciliations` (append-only, tenant-less), `provider_jobs` gains kind `reconcile` + `subject_id`.
- `compute/0620`: schema, permissions (`offers:read`, `compute:quote:create`, `compute:instance:create|read|act|delete`), `instances`, `instance_actions`, `snapshots`, `instance_intervals`, `images` (tenant-less catalogue).
- `commerce/0630`: authorization kind `hold` (one per order), `authorization_releases` (append-only, one per authorization).
- Down scripts are dev/staging only; production is forward-fix (documented in each file). Verified by running the whole chain on fresh databases in every test run.

## E. Tests run, with actual results (this worktree, 2026-11-18)

Environment: own Postgres :54331 (own cluster); all commands from this worktree with `DATABASE_ADMIN_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL`, `NUZM_TEST_ADMIN_URL` on :54331; `pnpm test:e2e` / `pnpm verify:full` **not run**; Redis not used. The machine was heavily loaded by other sessions during the runs (load average ≈ 100).

| Command | Result |
|---|---|
| Filtered verify (the steps of `pnpm verify` except the `@nuzm/e2e` Playwright package, which needs port 4000 held by another session): `pnpm lint && pnpm typecheck && pnpm exec turbo run test --filter='!@nuzm/e2e' && pnpm build && pnpm spec:lint && pnpm spec:drift && pnpm sdk:check && pnpm scan:secrets && pnpm zatca:guard` | **exit 0**. Unit tests: api **318**, domain **180** (+39 cloud: state machine over all pairs, 17 eligibility failure cases, routing, absence proof, 5 metering timelines), web 67, admin 65, db 16, contracts 19, runtime 10, mock-compute 20, worker 5, ui 7, sdk 4, platform 4, telemetry 3. `spec:lint` clean; `spec:drift` OK **199** routes declared = implemented; `sdk:check` up to date; `scan:secrets` OK (864 files, 0 hits); `zatca:guard` OK |
| `pnpm db:migrate && pnpm db:test-rls && pnpm compliance:classification-coverage` | all OK (`db check OK: ownership + RLS rules hold`; classification 100% of columns, incl. the new tables) |
| `pnpm test:integration` (all packages, real PostgreSQL) | db **43/43**, platform **32/32**, worker **8/8**, api **766 passed, 2 failed of 768**. The 2 failures are the M03 invoice/credit-note **PDF render** tests (`invoices.int.spec.ts`), which hit their 30 s timeout while the host was at load average ≈ 100; the same file passes alone: **25/25**. Everything M05 passed |
| `compute-flow.int.spec.ts` | **30** passed: offers (7), quotes (4), lifecycle (6), TOCTOU/compensation (6), spend approval (2, incl. cleanup), tenant isolation (3), DB state machine over 2×72 pairs, metering sampler |
| `compute-reliability.int.spec.ts` | **16** passed: timeout-after (adopt, no 2nd create), vendor without dedupe, timeout-before (proof then one retry), eventual consistency, no-lookup provider, rate-limit retry, delete/action uncertainty, drift/missing, forced reconcile, orphans, cancel, **50 and 100 parallel same-key creates**, **20 parallel creates vs quota 7**, **1,000 randomized fault runs** |
| `cloud.int.spec.ts` (S16) | 19 passed |
| `eligibility.property.spec.ts` | 3 passed: **10,000** random facts/policy states (eligible ⇔ oracle, 0 violations) and **4,000 × ≤6 = well over 10,000** random catalogue entries (every returned offer satisfies every condition; > 500 eligible and > 500 ineligible states reached), routing permutation invariance |
| 1,000 randomized fault runs, seed 20261118, **vendor without token dedupe** (worst case), faults on provision/findByToken/inspect | evidence `docs/reports/evidence/M05/random-fault-runs.json`: **violations 0**, **replays after a side effect 0**, **max billable resources per token 1**, 1000/1000 ended `ACTIVE` with exactly one provider resource; the schedule parked 473 operations for reconciliation, 1,137 backoff re-runs, 164 adoptions by the reconciler and 94 retries after proven absence |

## F. Security, tenant isolation, billing, residency verification

- Tenant isolation: instance/resource/snapshot/interval/release tables are RLS-forced; org B receives 404 for org A's instance on GET/DELETE/actions/metrics, an empty list, 0 rows under its own RLS context for every new table, and cannot insert a row for org A. Admin cross-org inventory reads are audited.
- Provider identity: absent from customer offers, quotes, instances, operations (result, error, steps) — asserted by text scan in the tests; provider tags hold only an opaque org hash and the instance id.
- Money: integer minor units only; the hold and release are not ledger postings; one hold per order and one release per authorization are DB constraints; quotes immutable (trigger).
- Residency: offers filtered with `evaluate`; quote and provision with the audited hook; a policy/processor change between quote and provision is denied at execution (TOCTOU test); unverified regions are never placed; `data_region` persisted on resources/instances/snapshots/intervals/usage.
- Secrets: nothing new stores credentials; adapters resolve vault references only (S16); results/errors visible to customers are scrubbed of provider detail.

## G. Human gates and live checks still needed

HG-05-01/02/03 (accounts, RAM/IAM users, eligibility), HG-05-04 (quota/spend caps), D-12 (production vault), D-15, D-23 (pricing/margin), owner sign-off of M03/M04 gate reviews, ROPA processor entries for each real provider (compliance officer; offers stay hidden until then), live-verification jobs (S19/S21/S22). No live call was made; no credential created or used; nothing is labelled LIVE-VERIFIED.

## H. Acceptance checklist

| Row | Status | Evidence |
|---|---|---|
| AC-M05-01 mock conformance 100% | PASS (mock; NOT VERIFIED live) | S16 kit report `docs/reports/evidence/M05/mock-compute-conformance.json` |
| AC-M05-02 eligibility property test ≥ 10,000, 0 violations | **PASS** | `eligibility.property.spec.ts` |
| AC-M05-03 no verified Saudi region → `country=SA` returns 0 | **PASS (API)**; UI empty state in S23 | `compute-flow.int.spec.ts` (region withdrawn → 0; stale verification → 0; restored → 2) |
| AC-M05-04 timeout injection 1,000 runs → 0 duplicate billable resources | **PASS (mock)** | `random-fault-runs.json` |
| AC-M05-05 50 parallel same-key creates → 1 instance/operation/authorization | **PASS** | `compute-reliability.int.spec.ts` |
| AC-M05-06 quote cases (≥ 6) | **PASS** | immutable (trigger), TTL/expired, consume-once, price change at API (409 `price_changed`, quote not consumed) and at execution (fails, hold released), residency embedded, no-eligible-offer, kind permission |
| AC-M05-07 residency denial at quote and at provision | **PASS** | quote: audited hook denial → 403 `residency_denied` (gate replaced for the case); provision: processor deregistered between quote and run → denied at execution, provider never called |
| AC-M05-08 spend-approval flow (approve/reject/expire) | **PARTIAL**: blocked above the limit (422 with approvalId) and proceeds after approval (one order per approval); reject and expiry paths are M02's and were not re-tested here; e2e in S23 | `compute-flow.int.spec.ts` |
| AC-M05-09 unsupported action → 422 and hidden in UI | **PASS (API)**; UI hiding in S23 | `compute-flow.int.spec.ts` (action and metrics) |
| AC-M05-10 drift/missing within ≤ 2 cycles (fake clock) | **PASS** | `compute-reliability.int.spec.ts` (drift, then missing×2 with due-sweep selection, metering stopped) |
| AC-M05-11 metering replay exact on 5 fixture timelines; duplicates no effect | **PASS** for the exact quantities (domain, 5 timelines incl. start/stop/resize) and for emission (integration: events once, unique ids, reruns add nothing); ingest into `metering.usage_events` is the worker consumer (M02) and was not re-run here | `cloud.spec.ts`, `compute-flow.int.spec.ts` |
| AC-M05-12 RLS 0 leaks on `cloud.resources`, `compute.*`; cross-tenant id → 404 | **PASS** | `compute-flow.int.spec.ts`, `cross-tenant.int.spec.ts` (generated coverage now includes the compute routes) |
| AC-M05-13 canary secret absent from logs/evidence/DB | PARTIAL: PASS for cloud tables/audit/job results/HTTP (S16); API-wide log and full DB dump scan not run | S16 |
| AC-M05-14 UI-M05-01..16 e2e + axe | **NOT STARTED** (S23) | — |
| AC-M05-15..20 live rows | **BLOCKED** (HG-05-01/02/03/04; RC-04 needs real bills) | — |
| AC-M05-21 Saudi offers only for regions with `evidence_ref` | **PASS** | DB CHECK + offers tests (production profile: only `live` evidence, domain test) |
| AC-M05-22 100 parallel same-key creates → 1 resource, 1 authorization | **PASS** | `compute-reliability.int.spec.ts` |
| AC-M05-23 timeout → `UNKNOWN`, reconcile via `findByToken`/`inspect`, never a second create | **PASS (mock)** | `compute-reliability.int.spec.ts` (`existed:false` for every provision call; adoption; proof rule; no-lookup provider never retried) |
| AC-M05-24 only canonical resource states (state-machine test) | **PASS** | domain table test + DB trigger test over all pairs for both actors |

## I. Next-milestone handoff and open decisions

### What M06 and M07 can rely on now (S16 + S17)
- **Compute provisioning for M06**: `POST /v1/quotes` (compute) → `POST /v1/compute/instances` → `compute.instances` / `cloud.resources` (canonical states, `data_region`), actions (start/stop/reboot/resize/snapshot per capability), delete, metrics; `ProvisioningService`, `OfferService`, `RoutingService`, `ReconcilerService` and `InstanceService` are exported from `modules/cloud` (public index). CloudPanel nodes should be created through this path (a node is a compute instance); M06 adds its own `HostingAdapter` conforming to docs/09 §1 and registers it in `AdapterRegistry`.
- **Framework for M07/M08**: adapter registry, guard, vault refs, conformance kit, provider tables/jobs, verified regions, residency region resolver, reconciler pattern (token + lookup + proven absence) and the operations additions in `@nuzm/platform`.
- **Not available**: real vendor adapters (S18–S22), cost capture/RC-04 and the UI (S23), webhooks, case-closing endpoint, moving the sweep into `apps/worker`.

### Open
D-12, D-15, D-23, HG-05-01..04, SI-M05-2/4/5, ROPA processor registration per real provider, the 422-vs-429/409 registry decisions noted in §A.
