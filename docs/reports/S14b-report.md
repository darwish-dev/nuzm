# S14b report — Data-subject requests and data exports (M04 sprint 14, second part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed**: S13a–S13d, S14a and S14b are all in the working tree and share files; commit them together. M04 continues with **S15** (control catalogue, evidence, breach cases, regulatory validation register, compliance UI) and then the M04 report and gate review.

## A. Repository findings and assumptions
- **Docs 05 §4 says exports are not a table**, so an export is a `platform.operations` record (kind `compliance.data_export`) plus an `ExportSink`; only DSR requests and tasks are tables (`compliance.dsr_requests`, `dsr_tasks`, migration `0505`).
- **Who runs the work.** The operations `claimDue` is, by RLS policy, for the `nuzm_worker` role only, and the API runs as `nuzm_app`. Following the billing scheduler (ADR-017, proposed) the executor runs **inside the API process** (`ComplianceJobs`): a request kicks its own operation right after it is made through a new `OperationsService.claimById` (one atomic conditional UPDATE under the organization's scope, with a lease), and an optional periodic tick (`DSR_SCHEDULER_INTERVAL_SECONDS`, off by default) finds open requests (read under the admin scope) and, **only if `WORKER_DATABASE_URL` is configured**, also claims any compliance operation across organizations with the worker role. Without that variable a lost export kick is recovered by asking again with the same `Idempotency-Key`. This is a deployment decision for the owner (ADR-017 stays PROPOSED).
- **Identity verification.** A member about themselves is verified by their session. An administrator asking about anyone else must supply a written `identityAttestation` (10–500 characters) or the answer is 422 `dsr_identity_unverified`. The platform does **not** check the identity itself; it records who attested what. Whether this satisfies the regulation is for counsel (HG-04-01).
- **Aggregate rule.** All tasks succeeded → `fulfilled`. At least one did real work and the others were refused or failed → `partially_fulfilled`. No real work and something refused or failed → `rejected` with the most specific reason (legal hold, mandatory retention, account is global, last owner, unsupported, processing failed). A handler that has **nothing about the subject** (`not_applicable`) is neutral: it neither fulfils the request nor turns a refusal into a partial result (found by the tests: a sole owner's erasure was first reported as partial).
- **Erasure never bypasses what must stay.** The legal-hold gate runs **before** a handler's `erase` (organization-wide or by dataset). Billing, invoicing and consent records are refused with `retention_mandatory` (periods are D-34 / HG-03-04). The global account row is refused with `account_is_global`. The last owner is never removed. Audit logs are append-only.
- **Delivery to the member.** `data-exports` needs `privacy:export:manage`, so a viewer who asked for their own data could not have fetched it. The request itself now carries `downloadUrl` and `GET /v1/compliance/data-subject-requests/{id}?download=<token>` returns the archive of **that request only** (a token of another request or another organization is 404, expired is 410). This adds a parameter to an existing route; no new path.
- **Archive protection.** gzip JSON sealed with AES-256-GCM using a random per-archive key that is itself field-encrypted (`FIELD_ENCRYPTION_KEYS`, S13d), AAD = organization and operation; the SHA-256 of the ciphertext is returned. The link is a sealed token (15 minutes), the archive lives 72 hours (proposals in `spec/compliance/defaults.yaml`). **Production has no sink until M08 (D-07)**: `422 no_export_sink`, nothing is written anywhere. Development and test use `LocalExportSink` (`EXPORT_LOCAL_DIR`, default `.local/exports`, git-ignored).
- **Free-text details** are sealed (`details_enc`, never returned, never in the audit trail); task records keep counts and flags only; a failing handler's message is kept in `dsr_tasks.error` for operators and never returned.
- **SLA timers:** warn at 70 %, escalate at 90 % of the time to the deadline, once each, in-app notifications to owners and admins plus audit events; `sweep(now)` takes the time as a parameter. The sweep also repairs a request whose operation was never created.
- **Spec issues / not built:** **SI-M04-1** the admin DSR queue (PA-13) has no endpoint in docs/04 beyond the proposal, so **UI-M04-15 and cross-organization queue handling are not built** (BLOCKED on that decision). Manual task completion, account-closure flow and handlers for modules that do not exist yet (M05+) are not built. Notices are in-app only (email is the dev logger).

## B. Plan and changed files
- Migration `compliance/0505__compliance__dsr` (+ down): permissions `privacy:dsr:self|manage`, `privacy:export:manage`; `dsr_requests` (immutable identity, forward-only status, closed rows frozen), `dsr_tasks`; forced RLS, admin-scope read, column-level UPDATE grants.
- Spec: `openapi.yaml` (+5 operations: 134 in total; schemas `OpenDsr`, `DsrRequest`, `DsrTask`, `DataExport`, pages), error codes `dsr_identity_unverified`, `legal_hold_active`, `retention_mandatory`, `no_export_sink`; `spec/compliance/defaults.yaml` (`dsr:`, `exports:`); `ownership.yaml` classification (972 columns now) and `details_enc: encrypted`; SDK regenerated; `.env.example`.
- Code: `apps/api/src/modules/compliance/internal/dsr/` (`types.ts`, `handlers.ts`, `builtin-handlers.ts`, `legal-gate.ts`, `dsr.service.ts`), `internal/exports/` (`export-sink.ts`, `export.service.ts`), `internal/jobs.ts`, `dsr.controller.ts`, `data-exports.controller.ts`, module wiring; `packages/platform/src/operations.ts` (`claimById`, `kinds` filter for `claimDue`).
- Tests: `internal/dsr/types.spec.ts` (13), `dsr.int.spec.ts` (35), cross-tenant fixture for the new `{id}` route.
- Docs: `docs/runbooks/dsr-handling.md`.

## C. Implemented features, API and UI screens
- **API (5 operations, 134 in total):** `POST`/`GET /v1/compliance/data-subject-requests`, `GET …/{id}` (with `?download=`), `POST`/`GET /v1/compliance/data-exports` (with `?download=`). Internal: `DsrRegistry` (modules register `DsrHandler { name, datasets, export, erase, rectify }`; built-in handlers for identity, tenancy, billing/invoicing and consent), `ExportService`, `ComplianceJobs`. **UI:** none in this part (UI-M04-02/03/04/06 are S15; UI-M04-15 waits for PA-13).

## D. Migrations and rollback
`0505` has a dev/staging `.down.sql`; production is forward-fix and requests and tasks are compliance evidence, never dropped. No data migration.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` (eslint + prettier) · `pnpm typecheck` | exit 0 · exit 0 |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 (api 529 unit, db 46, web 49, admin 41, …) |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · **134** routes all declared · up to date · 0 hits in 1828 files |
| `pnpm db:migrate` · `pnpm db:test-rls` · classification (**972** columns, 86 tables) · ROPA coverage · residency hooks · `zatca:guard` | all OK |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 709 passed** (672 before; **711** after the last two guard tests were added, a re-run of `dsr.int.spec.ts` alone: 35/35) |
The full set was run on the tree before two things were added: comment lines in `.env.example` and the two database-guard tests (the file was re-run alone, 35/35, after them). Browser E2E was **not run** (skipped by the owner for now; no UI in this part).

Highlights of `dsr.int.spec.ts`: 201 with a 30-day `dueAt`; missing and replayed `Idempotency-Key`; validation of type, subject and details; the attestation rule (viewer 403, none 422, short 422, valid 201); sealed details (ciphertext in the row, absent from the response and the audit trail); visibility (member sees own only, admin sees all, other organization sees nothing, RLS under the hood); access fulfilled with a download that contains only that member's data and no hash or secret; a token of another request or organization is 404, expired link and archive are 410; correction applied and refused; deletion partial (membership gone, billing and identity refused), rejected for the last owner with `retention_mandatory` outranking, blocked by an active **legal hold** (two people approve it through the real admin API) while access still works; a failing handler retried (success on the third attempt, and failed after three with the rest partially fulfilled and the error never leaked); processing a closed request twice does nothing; SLA warn/escalate with a fake clock, once each, with notifications and audit events; repair of a lost operation; claims (one execution, a lease, takeover after expiry, another organization cannot reach it); exports 202/200 replay, ciphertext at rest (not gzip, no plaintext, SHA-256 matches), readable archive through the link, another organization's token 404, tampered token 404, 410 expiry, `expired` status, no sink 422, quota 422 at five in progress and per organization.

## F. Security, tenant isolation, billing, residency
- Forced RLS on both tables; the admin-scope read exists only for the job discovery and the SLA sweep. Every service call is organization-scoped; a non-member gets 404 (existence is not revealed). The cross-tenant suite now covers the new `{id}` route.
- No billing or metering (a DSR is not billable). **Residency:** the archive sink and the notifications are the only outputs; the sink is local in development and absent in production until M08, so no personal data leaves the platform from this feature. The residency hook for the future in-region sink is listed under M08 in `residency-hooks.yaml`.
- Audit events: `compliance.dsr.opened|task_completed|closed|sla_warning|escalated`, `compliance.export.requested|downloaded`.

## G. Human gates and live checks still needed
- **HG-04-01:** counsel states the statutory deadlines, the retention basis for refused erasure (D-34), the wording of the refusal reasons and whether the written attestation is enough. **D-07 / M08:** the in-region export sink. **ADR-017 / owner:** where the executor runs and whether the API receives `WORKER_DATABASE_URL`. **PA-13:** the admin DSR queue.

## H. Acceptance checklist (rows touched in S14b)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-06 DSR 4 types pass; warning/escalation at the configured thresholds (fake clock) | **PASS as integration tests** against the real API and database (access, portability, correction, deletion; 70 %/90 % once each). The row asks for e2e: **no browser e2e exists** until the S15 screens | `dsr.int.spec.ts`, `types.spec.ts` |
| AC-M04-07 erasure refused with a documented reason under legal hold and mandatory retention (2/2 cases) | **PASS** (plus last owner and global account) | `dsr.int.spec.ts` |
| Data export (M04 §4 task 11; no AC row of its own): encrypted archive, signed expiring link, `no_export_sink` | **PASS** for the local sink; the in-region production sink is **BLOCKED (D-07, M08)** | `dsr.int.spec.ts` |
| AC-M04-12 RLS cross-tenant over compliance tables | **PARTIAL**: + requests, tasks, exports covered | cross-tenant suite, `dsr.int.spec.ts` |
| UI-M04-02/03/04/06 customer DSR and export screens | NOT STARTED (S15) | |
| UI-M04-15 cross-organization DSR queue | **BLOCKED (PA-13 / SI-M04-1)** | |
| AC-M04-08 append-only enforcement | **PARTIAL** as in the S13c report; S14b adds DB guards (requests immutable once closed, no delete or truncate, tasks frozen once finished, no skipped steps, runtime role cannot rewrite a deadline) with direct mutation tests | `dsr.int.spec.ts` |
| AC-M04-09..-11, -13 | NOT STARTED (S15) | |
| AC-M04-15..-17 | BLOCKED (HG-04-01/02/03) | |

## I. Next-milestone handoff and open decisions
- **S15:** control catalogue and mappings, evidence items, breach cases (state machine, notification clocks), regulatory validation register (never `validated` by the agent), compliance UI (consents, residency policy, ROPA, DSR, retention, holds, validations) in Arabic and English with e2e and screenshots, then the M04 report, demo script and gate review.
- **Handlers for later modules:** M05+ register their `DsrHandler` in `DsrRegistry` with the datasets they own (the legal-hold gate and the export use them automatically).
- Spec issues: SI-M04-1 (admin DSR queue), -5, -6, -7, -8, -9. Open decisions: D-07, D-14, D-15, D-16, D-34; ADR-017; HG-04-01.
