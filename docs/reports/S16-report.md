# S16 report — Provider contracts, conformance kit, mock adapter, vault interface, provider registry and capability matrix (M05 sprint 16)

Status: implemented and verified against real PostgreSQL (project-local, port 54331) and unit/contract suites. **Everything adapter-related is mock/fixture based: NOT VERIFIED against any vendor. Live rows are BLOCKED (HG-05-01/02/03).** Owner-directed exception: M05 was started before the M03/M04 gate reviews were signed (the owner asked for it explicitly; recorded here and in the M05 report).

## A. Repository findings and assumptions

- Base: integration branch `integration/m03-s12d-m04` (M03 + M04 complete, gate reviews UNSIGNED). M05 migration range in `spec/db/ownership.yaml` is **0600–0799** (M04 used 0500s). `cloud` and `compute` schemas were already listed in the manifest (created by M05).
- Decisions taken (all recorded; none changes a public contract beyond what the M05 prompt lists):
  - **SI-M05-3** (role names): the prompt's `provider_admin` is not defined in docs 01–09; no role was invented. New platform permissions `admin:provider:read|manage` are held by `platform_admin` (`security`, `support`, `finance` read).
  - **SI-M05-6** (new): `platform.operations` is org-scoped (`org_id NOT NULL`, RLS), but provider verification and catalog syncs are platform-level jobs. They are recorded in tenant-less `cloud.provider_jobs` with the same state vocabulary (reuses `@nuzm/domain` `assertTransition`) and are polled with the new `GET /v1/admin/provider-jobs/{id}` (the `operationId` of the 202 answers). Row added to docs/04.
  - New tables beyond the §7 list: `cloud.evidence_items` (append-only redacted evidence; `evidence_ref = evidence:<id>`), `cloud.provider_jobs`. Both are in the ownership manifest.
  - Errors added to the registry: `invalid_filter`, `credential_value_rejected`, `unsupported_capability`, `no_eligible_offer`. Existing `quota_exceeded` is **422** in the registry (the M05 prompt says 429); the registry (higher precedence) is kept.
  - Adapter packages live in `packages/adapters/{contracts,runtime,conformance,mock-compute}` (workspace glob `packages/adapters/*` added).
- Environment: own Postgres on :54331 (`NUZM_PGPORT=54331`), `DATABASE_ADMIN_URL`/`DATABASE_URL`/`WORKER_DATABASE_URL`/`NUZM_TEST_ADMIN_URL` pointed at it; Redis not installed and not used; `pnpm test:e2e` / `pnpm verify:full` **not run** (ports belong to another session).
- **Deviation in how `pnpm verify` was run:** `pnpm test` (turbo) includes the `@nuzm/e2e` Playwright package, which needs `127.0.0.1:4000` (occupied by the other session's E2E; it failed with “http://127.0.0.1:4000/healthz is already used”). The same steps were therefore run as `pnpm lint && pnpm typecheck && pnpm exec turbo run test --filter='!@nuzm/e2e' && pnpm build && pnpm spec:lint && pnpm spec:drift && pnpm sdk:check && pnpm scan:secrets && pnpm zatca:guard` (everything `verify` runs except the browser package).

## B. Plan and changed files

Spec first: `spec/providers/capabilities.schema.json`, `spec/providers/providers.yaml` (registry seed + egress allow-lists, real vendors **empty**), `spec/db/ownership.yaml` (tables, tenant-less, classification), `spec/openapi/openapi.yaml` (10 operations, tag `cloud`), `spec/openapi/errors.yaml`, `spec/compliance/encryption-retrofit.yaml` (`vault_ref`), docs/04 row. Then migration `packages/db/migrations/cloud/0600__cloud__providers_accounts_catalog.{sql,down.sql}`. Then code: `packages/adapters/*` (4 packages), `apps/api/src/modules/cloud/**` (module, 3 admin controllers, 4 services, adapter registry), `apps/api/src/app.module.ts`, `platform-scope.spec.ts` (allow-list gains `modules/cloud/`), `packages/sdk/src/schema.ts` (regenerated). Docs: `docs/runbooks/provider-onboarding.md`, `packages/adapters/**/README.md`, this report, `docs/reports/evidence/M05/mock-compute-conformance.json`.

## C. Implemented features, API and UI screens

- **Contracts** (`@nuzm/adapter-contracts`, contractVersion 1.0.0): `AdapterBase`, `ComputeAdapter`, results (`succeeded|accepted|failed|uncertain`), normalized errors (10 categories + retryable table), capability ids (12; kept in sync with the JSON schema by a test), `VaultClient` interface + `vault://` reference check, `Redactor` (key-name layer + value layer incl. base64/URL forms), egress allow-list/SSRF guard (https only, no IP literals/private/loopback, empty list = no calls), idempotency token `sha256(orgId|operationId|stepId)`, opaque org tag.
- **Runtime** (`@nuzm/adapter-runtime`): `FileVaultClient` (non-production stub; **refuses `NODE_ENV=production`: production BLOCKED on D-12 / HG-01-02**), `MemoryVaultClient`, `TokenBucket`, `CircuitBreaker` (half-open single trial), `GuardedCompute` wrapper (per-account limiter + breaker; a timeout of a mutating call becomes `uncertain`, an open breaker/limiter refusal is a definitive “not sent” failure; all results redacted), simulated clocks.
- **Conformance kit** (`@nuzm/adapter-conformance`): 15 cases C01–C15 (contract version, probe honesty/side-effect freedom, claimed⇒works / unsupported⇒rejected, catalog shape, idempotent replay, timeout after/before side effect with `findByToken`, delete idempotency, unsupported action rejection, error normalization, rate limiting, lookup-unsupported ⇒ never `null`, eventual consistency, canary redaction, token determinism). The kit has teeth: four deliberately non-conforming adapters fail the intended cases (tested).
- **`mock-compute`**: deterministic simulator with fault injection (timeout after/before the side effect, duplicate create, eventual-consistency lag, rate limit, outage, partial capability set, region list change, price change) on a simulated clock. Evidence kind is always `mock`.
- **Cloud module (API)**: provider registry; provider accounts (vault references only; credential values rejected with 422 `credential_value_rejected` before storage; `If-Match` on PATCH; audited); verification job (vault ref → probe → capability matrix with evidence → regions with evidence → plans → health), catalog-sync job, capability matrix (unknown shown/treated as unsupported), regions (`listed|verified|withdrawn`), plans (provider cost as integer minor units), health sweep with circuit-breaker state exposed (`CLOUD_HEALTH_INTERVAL_SECONDS`, default off). Real vendors have no adapter: their accounts fail verification with `adapter_not_available` (nothing invented).
- Endpoints (all admin realm, platform permissions): `GET/POST /v1/admin/providers`, `GET /v1/admin/providers/{id}`, `GET/POST /v1/admin/provider-accounts`, `GET/PATCH …/{id}`, `POST …/{id}/verification`, `GET …/{id}/capabilities`, `POST …/{id}/catalog-syncs`, `GET …/{id}/regions`, `GET …/{id}/plans`, `GET /v1/admin/provider-jobs/{id}`. **No UI** (S23).

## D. Migrations and rollback

`0600` creates schema `cloud` and tables `providers` (seeded: mock, alibaba, huawei, contabo, cloudpanel), `provider_accounts` (CHECK `vault_ref LIKE 'vault://%'`, no secret column), `evidence_items` (append-only), `provider_regions` (CHECK: `verified` ⇒ `verified_at` ∧ `evidence_ref` ∧ `evidence_kind`), `provider_plans` (price columns all-or-none), `provider_capabilities` (CHECK: `supported` ⇒ `evidence_ref`; capability id enumerated), `catalog_snapshots` (append-only), `provider_jobs`; RLS forced on all with a single platform-scope policy; grants least-privilege; permissions seeded. `.down.sql` is dev/staging only; production is forward-fix (documented in the file).

## E. Tests run, with actual results (this worktree, 2026-11-18)

| Command | Result |
|---|---|
| `pnpm --filter "@nuzm/adapter-*" test` | contracts **19**, runtime **10**, mock-compute **20** (15 conformance cases + summary + 4 negative-kit tests), conformance (no own specs) — all passed |
| `CONFORMANCE_REPORT_DIR=docs/reports/evidence/M05 pnpm --filter @nuzm/adapter-mock-compute test` | kit report `mock-compute-conformance.json`: **15/15 passed, liveStatus NOT VERIFIED** |
| `pnpm exec vitest run --config vitest.integration.config.mts src/modules/cloud` (apps/api, real PG :54331) | `cloud.int.spec.ts` **19 passed** (registry, permissions, vault-ref-only incl. canary and DB CHECK, CRUD+ETag, verification, idempotent job key, matrix change + audit, region withdrawn, catalog sync price change, adapter-less provider, unresolvable vault ref, canary through an adapter error, DB constraints, runtime-role RLS, health/breaker open→closed, sweep, customer realm refused) |
| `pnpm db:migrate`, `pnpm db:test-rls` | `applied: 600:providers_accounts_catalog`; `db check OK: ownership + RLS rules hold` |
| `pnpm compliance:classification-coverage` | OK: 100% of columns covered (98 tables, 1103 columns) |
| Filtered verify (see §A): `lint` OK, `typecheck` OK, unit tests: api **315**, domain 141, web 67, admin 65, db 16, runtime 10, contracts 19, mock-compute 20, worker 5, ui 7, i18n 9, sdk 4, platform 4, telemetry 3 — all passed; `build` OK; `spec:lint` clean; `spec:drift` OK (186 routes, 186 declared); `sdk:check` up to date; `scan:secrets` OK (823 files, 0 hits) after replacing an AWS-looking example string in a test; `zatca:guard` OK | `pnpm verify` itself NOT run to completion here (needs port 4000; see §A) |
| Full `pnpm test:integration` | NOT run for S16 alone; run once at the end of S17 (it covers S16 too) — see S17 report |

## F. Security, tenant isolation, billing, residency verification

- Credentials: references only. Tests: credential values/secret-looking fields → 422 and **nothing stored**; DB CHECK refuses a raw value; canary secret injected into a vault resolution and an adapter error is absent from job result/error, audit events, and **every `cloud.*` table** (`row_to_json … LIKE`) and the HTTP responses. Production vault: `UnconfiguredVault` answers `blocked` in production.
- Tenant isolation: S16 tables are tenant-less admin tables (RLS forced, platform-scope policy only); the runtime role without scope sees 0 rows and cannot insert; DELETE is not granted. Customer-realm sessions get no access to `/v1/admin/**`.
- Egress: allow-lists live in `spec/providers/providers.yaml` and are empty for real vendors; guard unit-tested (SSRF cases). No adapter performs network I/O in S16.
- Billing/residency: none in S16 (offers, quotes and provisioning are S17).

## G. Human gates and live checks still needed

HG-05-01 (Alibaba), HG-05-02 (Huawei), HG-05-03 (Contabo) credentials and eligibility; HG-05-04 quotas/spend caps; D-12 secrets/KMS product (production vault); owner sign-off of M03/M04 gate reviews (M05 started as an owner-directed exception). No live call was made; no credential was created or used; nothing is labelled LIVE-VERIFIED.

## H. Acceptance checklist

| Row | Status | Evidence |
|---|---|---|
| AC-M05-01 `mock-compute` passes 100% of conformance cases | **PASS (mock; NOT VERIFIED live)** | `docs/reports/evidence/M05/mock-compute-conformance.json` 15/15; negative-kit tests |
| AC-M05-13 canary secret absent from logs/evidence/DB dumps | **PARTIAL** — PASS for the cloud tables, job results, audit and HTTP responses (S16 scope); API/worker logs and a full DB dump scan complete in S17/S23 | `cloud.int.spec.ts` canary tests |
| AC-M05-21 offers only for regions with `evidence_ref` | PASS for the constraint half (DB CHECK tests); the offers half arrives with S17 | `cloud.int.spec.ts` “DB constraints” |
| AC-M05-15/16/17/18/19/20 live rows | **BLOCKED** (HG-05-01/02/03/04) | — |
| All other AC rows | not in S16 scope (S17/S23) | — |

## I. Handoff

### What M06 (CloudPanel hosting) and M07 (domains/DNS) can rely on after S16
- **Adapter framework**: `@nuzm/adapter-contracts` (types, capability vocabulary, normalized errors, redaction, egress guard, idempotency token) and `@nuzm/adapter-runtime` (guard wrapper, limiter, breaker). Domain-specific contracts (HostingAdapter, RegistrarAdapter) must conform to docs/09 §1 and extend `AdapterBase`; they register in `AdapterRegistry` (today typed for `ComputeAdapter`; widening it to other kinds is an additive change for the first non-compute milestone).
- **Conformance kit**: the compute cases C01–C15 are reusable patterns; M06/M07 add their own kind’s cases to the same kit (the runner/report format is generic). Reports are always `liveStatus: NOT VERIFIED`.
- **Vault refs**: `VaultClient` interface, `vault://` validation, `FileVaultClient` (dev/test only; production BLOCKED on D-12 / HG-01-02), account tables hold references only; classification and the retrofit register already list `cloud.provider_accounts.vault_ref`.
- **Provider tables and admin APIs**: `cloud.providers` (`cloudpanel`/hosting is seeded), `provider_accounts`, `provider_regions` (verified-with-evidence rule), `provider_plans`, `provider_capabilities`, `catalog_snapshots`, `evidence_items`, `provider_jobs`; verification/catalog-sync jobs; health + circuit-breaker state; capability matrix semantics (unknown = unsupported).
- **Not usable yet** (arrives with S17): routing, `/v1/offers`, compute quotes, durable provisioning on `platform.operations`, `cloud.resources`/reconciler, `compute.*`, cost authorization, metering of instances, ResidencyPolicyService region resolver backed by `cloud.provider_regions`. **M06 hard-depends on S17** (CloudPanel nodes are compute instances); M07 needs only S16 + routing/reconciler from S17 for registrar adapters.

### Open
D-12, D-15, D-23, HG-05-01..04. SI-M05-1, -2, -4, -5 remain open for S17/S23 (see S17 report).
