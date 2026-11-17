# S14a report — Residency policy engine, transfer assessments, enforcement-hook registry (M04 sprint 14, first part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed**: S13a–S13d and S14a are all in the working tree and share files; commit them together. M04 continues with **S14b** (DSR workflow with `DsrHandler` registry, data export through `ExportSink`), then **S15** (controls, evidence, breach, validation register, compliance UI).

## A. Repository findings and assumptions
- **Decision rules (all PROPOSALS: D-14, D-16, HG-04-01; `spec/compliance/defaults.yaml` and `region-groups.yaml`).**
  1. **Public** data is always allowed. 2. A named **processor must be in the ROPA** and registered for the class (the processor id is the ROPA processor name), else deny. 3. A **verified in-Kingdom region** is always allowed. 4. Outside the Kingdom the effective mode is the **stricter** of the organization's mode (default `in_kingdom_only`, D-14) and the **platform floor** of the class: `in_kingdom_only` denies; `allow_listed` allows only listed countries; `unrestricted_with_assessment` answers `requires_assessment`. 5. An **approved, unexpired transfer assessment** that the policy references and that covers (class, country or group, processor) allows the transfer, except where the floor is `in_kingdom_only`: nothing overrides that (credentials).
  The floor is, per class, **the loosest mode the platform ever allows** (credentials: in-Kingdom only; the others: `unrestricted_with_assessment`). An organization may only tighten it: its mode needs no check (the engine always uses the stricter), but allow-list countries or exceptions for a class the floor keeps in the Kingdom are 422 `policy_below_floor`.
- **A name proves nothing.** Until M05 supplies verified regions, regions come from **mock fixtures** (`spec/compliance/region-groups.yaml`, `MockRegionRegistry`); an unverified Saudi region (including `sa-pending`, the placeholder tag of today's usage data) is treated as outside the Kingdom and the decision says so. An unknown region or a bare country code carries no verification.
- **Fail closed everywhere.** Any failure to read the floor, the organization policy, the assessments, the ROPA or the region registry returns **deny** with a precaution reason (in both languages) and an audit event, on write **and** read paths (docs asks for write paths; read is denied too as the restrictive choice, CLAUDE.md §11). A failing audit write never turns a refusal into a pass.
- **Denials are explained and logged.** Reasons are non-technical, Arabic and English; every deny and failure writes `compliance.residency.evaluate_denied|failed` with a decision reference (`rd_…`, deterministic), the class, region, processor, purpose and policy versions (no personal data); allows are not logged (volume).
- **Cache.** The organization policy and the floor are cached in process for 5 seconds (`cache_ttl_seconds`) and invalidated by this service's own writes. Another process may serve a changed policy for at most that time (docs says "versioned invalidation"; true cross-process versioning needs a shared signal and is left to M12).
- **Transfer assessments.** Create, then a **different person** decides (API 403 and a database check); approved ones must expire in the future and within 730 days; an expired request cannot be approved (422 `assessment_expired`); scope, people and status transitions are immutable/guarded; an organization relies on an assessment by listing its id in its policy; expiry revokes it by itself (tested with a moved clock and with real time). The decider column is named `decided_by` (the prompt's `approved_by` would be wrong for a rejection).
- **Hook registry (AC-M04-14).** `spec/compliance/residency-hooks.yaml` lists 18 required call sites for M03 and M05..M12 with owner milestone, data classes, adapter kind and feature flag, plus the 6 tables that carry `data_region`. `pnpm compliance:residency-hooks` (in `verify:full`) checks that every such table and every docs/09 adapter kind is covered, that every milestone M05..M12 lists hooks, and that an `enforced` hook names a source file that really calls the residency service. **Nothing is enforced yet**: M03's PSP hook is `listed` (enforcing it now would block the sandbox PSP because the ROPA lists no PSP yet); ZATCA is `exempt` (regulator-mandated, logged). The SDK (`@nuzm/domain`: `assertResidency`, `@RequiresResidency`, `ResidencyDenied`) is ready for the owner milestones.
- **Spec issues (not invented):** **SI-M04-8** UI-M04-16 needs an endpoint to change the platform floor with dual control and an evaluate-simulator; docs/04 has neither, so the floor is seeded (and changes only by migration) and the simulator is not built. **SI-M04-9** no endpoint lists transfer assessments for the customer (an organization learns an assessment's id from the compliance team). docs/05 lists `compliance.policy_versions`; it was not needed (policies are versioned in their own tables).
- **Coverage tooling:** the ≥95 % evaluator branch coverage of AC-M04-01 could not be **measured**: adding the V8 coverage provider was refused in this environment. Every branch of the evaluator is asserted by the 112 evaluator tests, but the number is **NOT VERIFIED**.

## B. Plan and changed files
- Migration `compliance/0504__compliance__residency` (+ down): `residency_policies` (versioned, immutable, platform floor seeded), `transfer_assessments`, permissions `privacy:residency:read|manage`.
- Spec: `spec/compliance/{defaults,region-groups,residency-hooks}.yaml`; `openapi.yaml` (+4 operations; 129 in total); error codes `residency_denied`, `policy_below_floor`, `assessment_expired`; SDK regenerated; `ownership.yaml` classification of the new columns.
- Code: `packages/domain/src/residency.ts`; `apps/api/src/modules/compliance/internal/residency/` (`evaluator.ts`, `regions.ts`, `defaults.ts`, `policy-input.ts`, `residency.service.ts`, `assessment.service.ts`), `residency-policy.controller.ts`, `admin-transfer-assessments.controller.ts`; `packages/db/src/residency-hooks.ts` (+ CLI and root script).
- Tests: `evaluator.spec.ts` (112), `policy-input.spec.ts`, `residency.int.spec.ts` (26), `packages/domain/src/residency.spec.ts` (6 new), `packages/db/src/residency-hooks.spec.ts`.

## C. Implemented features, API and UI screens
- **API (4 operations, 129 in total):** `GET`/`PUT /v1/compliance/residency-policy` (ETag/If-Match; any member reads, owners and admins write), `GET`/`POST /v1/admin/compliance/transfer-assessments` (create or decide; Idempotency-Key; step-up). `ResidencyService.evaluate()` is the internal API for the other modules. **UI:** none in this part (UI-M04-05, -12, -16 are S15).

## D. Migrations and rollback
`0504` (dev/staging `.down.sql`; production is forward-fix and policies and assessments are never dropped).

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` · `pnpm typecheck` | exit 0 |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · 129 routes · up to date · 0 hits |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 |
| `pnpm db:test-rls` · classification (937 columns) · ROPA coverage · **residency hooks** · `zatca:guard` | all OK |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 672 passed** (643 before) |
Highlights: **72/72 matrix cells** asserted against a literal expected table (6 classes × 4 groups × 3 modes) plus 14 floor-versus-organization cases and 14 exception cases (valid, expired, exactly-now expiry, wrong class/region/organization/status/processor, unreferenced, platform-wide, floor override refused); the seeded floor equals `defaults.yaml`; the policy API (default, create, 428/412, below-floor, validation, tenant isolation, audit without the lists, RLS); an unknown processor denies and, once registered in the ROPA for the class, passes; **fail-closed injections**: floor, organization policy and ROPA unreadable, a read-path failure, a broken region registry, a missing floor row, and a failing audit write: all deny; assessments end to end including self-decision refused by the API and the database, replay, immutability, and expiry by real time; **performance: p50 0.023 ms, p95 0.036 ms, p99 0.079 ms over 5,000 sequential cached evaluations** (in process, the proposal is p95 < 20 ms; an uncached evaluation adds database round trips and was not benchmarked). No browser E2E (no UI); `pnpm verify:full` as one command was not run (ports held by another session), its parts ran separately.

## F. Security, tenant isolation, billing, residency
- Forced RLS on both tables (an organization reads its own and platform-wide assessments; only the admin scope writes them); the platform floor is the only row readable by every runtime role. Org policy writes are serialized per organization by an advisory lock. No billing or metering.

## G. Human gates and live checks still needed
- **D-14 / D-16 / HG-04-01:** counsel decides the real floor, the default mode, region groups and assessment rules (everything here is a proposal). **D-15 / M05:** verified provider regions replace the mock fixtures; until then no region proves it is in the Kingdom except by fixture.

## H. Acceptance checklist (rows touched in S14a)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-01 matrix 72/72 cells asserted; evaluator branch coverage ≥ 95 % | **72/72 PASS; coverage NOT VERIFIED** (no coverage provider) | `evaluator.spec.ts` |
| AC-M04-02 fail-closed on write paths (≥3 injections) | **PASS** (3 required + read path, registry, floor row, audit failure) | `residency.int.spec.ts` |
| AC-M04-14 hook registry lists every required call site for M05–M12 with owner milestone | **PASS** | `pnpm compliance:residency-hooks`, `residency-hooks.spec.ts` |
| AC-M04-12 RLS cross-tenant over compliance tables | **PARTIAL**: consents, ROPA, policies, holds, residency policies and assessments covered | integration suites |
| AC-M04-06, -07 (DSR), -09..-11, -13 | NOT STARTED (S14b, S15) | |
| AC-M04-15..-17 | BLOCKED (HG-04-01/02/03) | |

## I. Next-milestone handoff and open decisions
- **S14b:** DSR (`dsr_requests`, `dsr_tasks`, `DsrHandler` for identity, tenancy and billing/invoicing, orchestration as `platform.operations`, SLA timers with a fake clock, rejection catalogue, erasure refused under a legal hold or mandatory retention with `legal_hold_active` / `retention_mandatory`) and `POST/GET /v1/compliance/data-exports` through `ExportSink` (`no_export_sink` in production configuration). DSR free text must be sealed with `FieldCipher` (S13d).
- **Owner milestones** build their hooks from the registry and flip them to `enforced`; M03's PSP and invoice-archive hooks wait for the PSP choice (D-10) and the ROPA processors.
- Spec issues: SI-M04-5, -6, -7 (earlier) and **SI-M04-8, -9**. Open decisions: D-14, D-15, D-16, D-34; HG-04-01.
