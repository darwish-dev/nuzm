# S32 report — decision records, adapters, managed PostgreSQL/MySQL

Status: **DONE for the autonomous scope; live rows BLOCKED** · Branch `claude/m08-data-email-b74780` · Written 2026-11-18 · Dev-reference mocks only: **NOT VERIFIED (local reference)**; production providers BLOCKED (D-05..D-09 OPEN, HG-08-01 PENDING).

## A. Repository findings and assumptions
- Base `integration/main-m04-s12d` has no `packages/adapters` contracts and no M05/M07 code (owner-directed exception, see `M08-upstream-interface-assumptions.md`). M05's S16 contracts were READ (never copied) and mirrored under the same names in `packages/adapters/data/src/upstream.ts`.
- Migration range is 1000–1199 (manifest), not 900–999. ADRs are numbered 050–054.
- No provider row is seeded; nothing is enabled by default.

## B. Plan and changed files
- New package `@nuzm/adapter-data`: five contracts (`DatabaseAdapter`, `CacheAdapter`, `ObjectStorageAdapter`, `TransactionalEmailAdapter`, `MailboxAdapter`), capability ids, five conformance suites, five mock adapters with fault injection, `self-operated-database` (compute port + signed allow-listed node agent), `provider-*` skeletons.
- `apps/api/src/modules/data`: provider selection service + admin API, quote pricer, `DatabaseService`, durable `DatabaseFlow` (create/delete/backup), `DataJobs`, `DataMetering`, `DatabaseBindingPort`.
- Spec: OpenAPI (`/v1/databases`, `/v1/databases/{id}`, backups, `/v1/admin/data-providers`), manifest, classification, residency hooks. ADR-050..054 (Proposed).

## C. Implemented features, API and UI screens
- `GET/POST /v1/admin/data-providers` (configure, probe, record_adr, request_enable, enable, disable) with `blockers`; two-person rule and live-probe/ADR/evidence gates enforced in the service AND by CHECK constraints.
- `POST/GET /v1/databases`, `GET/PATCH/DELETE /v1/databases/{id}`, `POST/GET …/backups` (202 + operation, quote → order → instance → operation). Vault REFERENCE only.
- UI: see the M08 report (UI built after the backend by a separate pass).

## D. Migrations and rollback
- `1000__data__providers_databases_backups` (+ `.down.sql`, DEV ONLY; production is forward-fix: customer resources are never dropped).

## E. Tests run with actual results
- `packages/adapters/data`: conformance suites (database ×2 engines, cache, object storage, transactional email, mailbox) all cases pass against the mocks; negative tests prove the suites detect a broken adapter; `self-operated-database` passes the same database suite against a fake compute + fake agent; agent protocol tests (signature, node binding, expiry, replay, allow-list, argument injection).
- `apps/api/src/modules/data/databases.int.spec.ts`: 31 integration cases (see the M08 report for the totals of the final run).

## F. Security, tenant isolation, billing, residency verification
- AC-M08-02: ≥10 negative tests + CHECK-constraint tests: no provider can be enabled without accepted ADR + live probe + evidence (+ second person). Mock evidence is never live: `probe_not_live`.
- Isolation: >200 generated attack cases against databases/backups/restores/rotations, 0 successes; RLS checks under the application role.
- Residency: EU provider region denied at quote (403); fail-closed hook enforced in `database-flow.ts`.
- Billing: quote is a monthly estimate from the price book (no price ⇒ `kind_not_available`); order via `OrderService`; meters `database.instance_hours`, `database.storage_gb_months`, `database.backup_gb_months` exact with deterministic event ids.

## G. Human gates and live checks still needed
- D-05 (ADR-050) accept/reject; HG-08-01 (credentials, probe run, evidence), HG-05-01/02 (verified Saudi ECS for the self-operated family), D-34 retention, D-31 tolerance. Every live row is BLOCKED; mock results are NOT VERIFIED.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M08-01 (adapter conformance on dev-reference/fixtures) | PASS (dev-reference; NOT VERIFIED live) |
| AC-M08-02 (provider enable gates, negative ×10) | PASS |
| AC-M08-12 (managed DB on verified Saudi infrastructure) | BLOCKED (D-05, HG-05-01/02) |

## I. Next-sprint handoff and open decisions
- S33 builds on `DatabaseFlow`: restore, verification, rotation, Redis. Open: D-05/D-06 decisions, in-place restore approval endpoint (PA-21).
