# S13b report — Record of processing activities (ROPA) (M04 sprint 13, second part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed**, and S13a ([S13a-report](S13a-report.md)) is not committed either: both are in the working tree and share files (`ownership.yaml`, `openapi.yaml`, the CLI), so they are best committed together. M04 continues with **S13c** (retention policies, legal holds, archival of append-only tables), **S13d** (field-encryption retrofit), then S14 and S15.

## A. Repository findings and assumptions
- **Scope.** M04 §4 task 4 only (ROPA CRUD with the processor registry, and the CI check that every adapter kind has an entry). Tasks 5 (retention) and 6 (encryption retrofit) are large enough to be their own parts: S13c and S13d.
- **Versioned and immutable.** An entry is identified by a stable `entryKey` (`activity:billing-and-invoicing`, `adapter:psp`). A change inserts version n+1; the current version is the highest; no row is ever updated or deleted (trigger, also against the database owner). The database also guards that versions are contiguous, that the kind and adapter kind never change, and that every data class (on the entry and on each processor) exists in `compliance.data_classes`.
- **Four-eyes review.** An API write has status `draft` or `reviewed`; `placeholder` exists only in the seed. A `reviewed` version approves the **previous content unchanged** and must be written by a **different person** than the author of that version; a new entry cannot start as reviewed; `reviewed` needs `reviewed_by` (database check). Nothing an agent can reach sets `reviewed`: it is a human act in the admin console realm.
- **Seeded placeholders (migration 0501).** 11 adapter entries (one per kind of docs/09 §1) and 5 platform activities (identity and access, organizations and projects, billing and invoicing, audit and security logging, public information). They **name no processor and no region**: no provider has been chosen (D-10, D-05..D-09). Their activity text, purpose and data classes are proposals for the DPO/counsel (HG-04-01, D-16).
- **Coverage check (AC-M04-04), `pnpm compliance:ropa-coverage`** (in `verify:full`): reads the adapter kinds from `docs/09-provider-adapter-interfaces.md` §1 (read, never edited), the data classes in use from the classification manifest, and the current ROPA versions; it fails on an adapter kind without an entry, an adapter entry for a kind that docs/09 no longer lists, and a data class in use that no entry lists (all six are covered).
- **Idempotency without the org-scoped interceptor.** The generic `Idempotency-Key` interceptor needs an organization; this endpoint is admin-realm. The key is stored on the version row (unique per entry): the same key and content replays the same version (200), the same key with other content is 422 `idempotency_key_reuse`. Concurrent saves of the same version: one wins, the rest are 409.
- **Permissions.** New `admin:compliance:manage` (compliance officer, platform admin). `admin:compliance:read` (already held by the compliance officer) is also given to the platform admin and to `security` (docs/04's `security_officer`; SI-M04-5). Support and finance have no access. Writes need a recent MFA check (step-up).
- **Not built:** organization-level ROPA entries (a customer as controller; the column `org_id` exists and is NULL for platform entries; RLS admits only the admin scope for now). The guard `platform-scope.spec.ts` allow-list now includes `modules/compliance`.

## B. Plan and changed files
- Migration `compliance/0501__compliance__ropa` (+ down): table, guard triggers, RLS, permissions, 16 placeholder entries.
- Spec: `spec/openapi/openapi.yaml` (+2 operations: `listRopaEntries`, `saveRopaEntry`; 122 in total), `spec/db/ownership.yaml` (classification of the new columns); SDK regenerated.
- Code: `apps/api/src/modules/compliance/` (`admin-ropa.controller.ts`, `internal/ropa.service.ts`, module wiring, index), `packages/db/src/ropa-coverage.ts` (+ CLI `ropa-coverage`), `apps/api/src/platform-scope.spec.ts`, root script `compliance:ropa-coverage`.
- Tests: `internal/ropa.spec.ts` (24 unit cases), `packages/db/src/ropa-coverage.spec.ts` (8), `admin-ropa.int.spec.ts` (16 integration).

## C. Implemented features, API and UI screens
- **API (2 operations, 122 in total):** `GET /v1/admin/compliance/ropa` (current versions; `history=true` with `entryKey`; filters kind, adapterKind, status; pagination) and `POST /v1/admin/compliance/ropa` (create or new version; `baseVersion`; Idempotency-Key; 201/200). Audit: `compliance.ropa.created|versioned|reviewed`.
- **UI:** none in this part (UI-M04-07 ROPA list/edit is S15).

## D. Migrations and rollback
`0501` (range 0500–0599). The dev/staging `.down.sql` drops the table, its function and the permissions; production is forward-fix and the record of processing is never dropped.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` · `pnpm typecheck` | exit 0 |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · 122 routes declared · up to date · 0 hits |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 |
| `pnpm db:test-rls` | OK |
| `pnpm compliance:classification-coverage` | OK: 881 columns in 79 tables |
| `pnpm compliance:ropa-coverage` | OK |
| `pnpm zatca:guard` | exit 0 |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8 passed; **api 611 passed, 1 failed** |
The one failure was `invoices.int.spec.ts › renders a credit note PDF`: the headless-Chrome renderer answered "service unavailable" while the whole suite was loading the machine; the same file **passed 25/25 on its own** straight afterwards. It is unrelated to S13b (no invoicing code changed) and is reported here rather than hidden; treat it as a known flake of the PDF renderer under load. Highlights of the new tests: seeded placeholders for all 11 adapter kinds read from docs/09; create/replay/version/stale/409 paths; the author cannot review and a changed review is refused; five parallel saves of one version: one 201, four 409; UPDATE, DELETE, TRUNCATE, skipped versions and unknown data classes are refused by the database; the application role sees zero rows without the admin scope. No browser E2E (no UI), and `pnpm verify:full` as one command was not run (ports held by another session); its parts ran separately.

## F. Security, tenant isolation, billing, residency
- Forced RLS (admin scope only); admin realm and step-up on writes; every write audited with the actor; no personal data is stored (vendor names and contract references only).
- No billing, metering or residency decision. The ROPA is the registry the residency engine (S14) will consult: `processorId` in `evaluate()` must exist in the ROPA, otherwise deny.

## G. Human gates and live checks still needed
- **HG-04-01 / D-16:** the DPO/counsel completes and reviews the placeholders (processors, regions, retention references, wording). Until then every entry is a `placeholder`.
- Provider selection (D-05..D-10) decides which processors will be listed.

## H. Acceptance checklist (rows touched in S13b)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-04 ROPA entry for 100 % of adapter kinds in docs/09 and 100 % of data classes in use | **PASS** (entries are placeholders awaiting the DPO) | `pnpm compliance:ropa-coverage`; 11/11 kinds, 6/6 classes |
| AC-M04-12 RLS cross-tenant over compliance tables | **PARTIAL**: `consents` and `ropa_entries` covered | RLS and integration suites |
| AC-M04-01, -02, -06..-11, -13..-14 | NOT STARTED (S13c, S14, S15) | |
| AC-M04-15..-17 | BLOCKED (HG-04-01/02/03) | |

## I. Next-milestone handoff and open decisions
- **S13c:** retention policies and legal holds through the audit module (`audit.retention_policies`, `audit.legal_holds`), dry-run-by-default retention jobs, dual-approval legal holds, archival of append-only tables by partition detach under the break-glass role with an audit event (never row UPDATE/DELETE); AC-M04-08. **S13d:** field-encryption retrofit for `credentials` and selected `personal` columns from the classification, via vault key references.
- Spec issues: SI-M04-5 (role names); docs/04 gives no field list for the ROPA POST (the field set here follows M04 §7: activity, purpose, data classes, processors, regions, retention reference, version, plus status and review); organization-level ROPA is not specified.
- Open decisions: D-14, D-16, D-34; HG-04-01.
