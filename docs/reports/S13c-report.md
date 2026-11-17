# S13c report — Retention policies, legal holds, archival of append-only tables (M04 sprint 13, third part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed**: S13a, S13b and S13c are all in the working tree and share files (`ownership.yaml`, `openapi.yaml`, the CLI, the module); commit them together. M04 continues with **S13d** (field-encryption retrofit), then S14 and S15.

## A. Repository findings and assumptions
- **No deletion path.** The application never deletes or updates retained data. The only archival path is detaching a whole old partition of a registered append-only table through `audit.detach_partition()`, a **break-glass** function: not callable by the application or worker roles (permission denied, tested), not exposed by the API (`execute` is refused with 422). Production use is **BLOCKED** (D-12 break-glass vault, D-34 retention values, HG-04-01 legal basis); it was exercised only on throwaway test databases by borrowing the role from the database owner. CLAUDE.md §5 (deleting production data is a human act) is honoured by construction.
- **Retention policies are proposals.** One policy per data class plus two dataset overrides (`audit.audit_logs`, `metering.usage_events`) are seeded as `proposal`: 395 days for personal/internal, 2,190 days (6 years, "longest configured") for financial, 30 days for credentials and customer content, 3,650 for public. They come from docs/10 §5 and are **not legal values** (D-34, HG-04-01). A policy becomes `approved` only with a `documentRef` and records the human approver (database check). Policies are versioned and immutable (`baseVersion` rule as for the ROPA); the same content again changes nothing.
- **Audit log archival is not built (M12).** `audit.audit_logs` is hash-chained and not partitioned: removing old rows would break `verify_chain`. The retention job reports it (`execution: not-built`); docs/10 already assigns its archival to M12. The registry of archivable tables (`audit.archivable_tables`) contains only `metering.usage_events` (append-only, monthly partitions by `window_start`).
- **Dry run lives on the existing GET.** docs/04 defines `GET/PUT retention-policies`; the preview is an additive query (`evaluate=true`, optional `asOf`) on that GET and returns `preview: null` otherwise. It counts rows (never reads them), subtracts rows under an active legal hold, lists partitions that could be detached (counted through the parent with partition pruning, because runtime roles hold no grants on partitions), and is audited (`compliance.retention.job_run`).
- **Legal hold dual approval is real.** docs/04 says the body carries `approvers[2]`. A body field is not consent, so: the requester (one of the two named people) creates a `pending_approval` hold that has **no effect**; the named second approver must approve it with a second request (same endpoint, as the ZATCA onboarding does). Scope = an organization and/or a dataset (`schema.table`); one open hold per scope; scope and people are immutable; nothing is deleted. A hold blocks archival of the data it covers: an organization hold blocks any partition with that organization's rows, a dataset hold blocks the dataset.
- **Release** is "a different person than the requester, with a reason" (docs/10 says "only compliance role may create/release; dual approval" without defining release). The owner may require a second approver for release too.
- **Archived tables.** A detached partition is renamed `archived_<partition>`, loses all runtime grants, gets forced RLS that admits nothing and append-only triggers (a detached partition does not keep its parent's triggers: found by a test), and is allowed by `db check` and excluded from the classification catalog by that naming convention (it keeps its parent's classification). New events for an archived month fall into the default partition (never archived) until a new partition is created.
- **Spec issue SI-M04-7:** docs/04 has no endpoint to list legal holds, so the second approver learns the hold id out of band. Not invented. UI-M04-11 will need it.
- `legal_hold_active` and `retention_mandatory` (M04 §6 error codes) appear as database exception texts of the archival function; registering them as API codes is left to S14, where the DSR erasure path returns them.

## B. Plan and changed files
- Migration `audit/0502__audit__retention_legal_holds` (+ down; range 0500–0599, audit module extended by M04): `retention_policies` (versioned, immutable, seeded proposals), `legal_holds` (guarded state machine), `archivable_tables`, `detach_partition()`.
- Spec: `spec/openapi/openapi.yaml` (+3 operations; 125 in total), `spec/db/ownership.yaml` (new tables, classification of 29 columns, tenant-less listings), SDK regenerated.
- Code: `apps/api/src/modules/compliance/` (`admin-retention.controller.ts`, `admin-legal-holds.controller.ts`, `internal/retention.service.ts`, `internal/legal-hold.service.ts`), `packages/db/src/checks.ts` and `classification.ts` (archived-partition convention).
- Docs: `docs/runbooks/legal-hold.md`, `docs/runbooks/retention-archival.md`.
- Tests: `internal/retention.spec.ts` (31 unit cases), `admin-retention.int.spec.ts` (20 integration).

## C. Implemented features, API and UI screens
- **API (3 operations, 125 in total):** `GET /v1/admin/compliance/retention-policies` (current or history; `evaluate=true` dry run), `PUT …/retention-policies` (set a version), `POST /v1/admin/compliance/legal-holds` (create, decide or release). Permissions `admin:compliance:read|manage`, step-up on writes, Idempotency-Key on holds. Audit: `compliance.retention.policy_set|job_run|partition_detached`, `compliance.legalhold.requested|created|rejected|released`.
- **UI:** none in this part (UI-M04-11 is S15).

## D. Migrations and rollback
`0502` (dev/staging `.down.sql`; production is forward-fix: policies and holds are compliance evidence and are never dropped; detached archives are not re-attached or dropped by the script). Reviewer action: read `detach_partition()` before any production use.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` · `pnpm typecheck` | exit 0 |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · 125 routes declared · up to date · 0 hits |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 |
| `pnpm db:test-rls` · classification · ROPA coverage · `zatca:guard` | all OK (911 columns in 82 tables classified) |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 634 passed** (612 before) |
Highlights: policy versions, stale/missing/premature base versions, approved-needs-document, only managers write, no UPDATE/DELETE/TRUNCATE; hold create/decide/reject/release with every four-eyes rule (requester cannot approve or release, only the named approver decides, support cannot be the approver, duplicates 409, replay idempotent), scope and people immutable; dry run counts with and without an active hold and writes nothing but its own audit event; `detach_partition` refused for the app and worker roles, for one person, for ineligible people, for unregistered tables, the default partition, a foreign table, a partition newer than the cutoff, and while a legal hold covers it; after release it detaches, rows are kept, the runtime roles cannot read them, the parent keeps accepting new data, the audit event names both people, and the audit chain still verifies. No browser E2E (no UI); `pnpm verify:full` as one command was not run (ports held by another session), its parts ran separately.

## F. Security, tenant isolation, billing, residency
- Forced RLS (admin scope) on policies and holds; admin realm and step-up on every write; separation of duties in the database function and in the API.
- The break-glass function is `SECURITY DEFINER` with a pinned search path, revoked from PUBLIC, granted only to `nuzm_admin_breakglass`; it validates both people, the policy and the holds itself, so a mistake in the caller cannot widen it.
- No billing, metering or residency decision.

## G. Human gates and live checks still needed
- **D-34 / HG-04-01:** real retention values (every seeded value is a proposal) and the legal basis; counsel review of the hold procedure.
- **D-12:** break-glass credentials and session auditing before any production archival. **Production archival is BLOCKED**; nothing was archived anywhere but test databases.
- Owner decision on release approval (single vs dual) and on SI-M04-7.

## H. Acceptance checklist (rows touched in S13c)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-08 append-only: 0 successful UPDATE/DELETE on audit ledger-class tables | **PARTIAL**: `audit_logs` (M01 `audit.int.spec.ts`), `retention_policies`, archived partitions and the hold guard (S13c) are tested; `audit_checkpoints` has its trigger but no mutation test of its own; `access_reviews` is M12 | integration suites |
| AC-M04-07 erasure refused under legal hold / mandatory retention | NOT STARTED (S14); the hold gate exists and blocks archival (tested) | |
| AC-M04-12 RLS cross-tenant over compliance tables | **PARTIAL**: consents, ROPA, policies, holds covered | RLS and integration suites |
| AC-M04-15 counsel values loaded from owner-signed config | **BLOCKED** (HG-04-01): seeded values are proposals | |
| AC-M04-01, -02, -06, -09..-11, -13, -14 | NOT STARTED (S14, S15) | |

## I. Next-milestone handoff and open decisions
- **S13d:** field-encryption retrofit for `credentials` and selected `personal` columns, using the classification and vault key references (D-12).
- **S14** consumes the holds (erasure gate, `legal_hold_active`, `retention_mandatory`); **M08** provides the export sink for cold storage of archives; **M12** builds audit-log archival with chain anchors and the production break-glass.
- Spec issues: SI-M04-5 (role names), SI-M04-6 (purposes endpoint), **SI-M04-7** (no list of legal holds). The additive `evaluate`/`asOf` query on the retention GET needs the owner's acceptance.
