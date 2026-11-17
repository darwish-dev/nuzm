# S13a report — Compliance foundations: data classification, consents (M04 sprint 13, first part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M04 continues with **S13b** (ROPA, retention and legal hold, field-encryption retrofit), **S14** (residency policy engine, transfer assessments, DSR, data export) and **S15** (control register, evidence collectors, breach cases, validation register, compliance UI).

## A. Repository findings and assumptions
- **M04 does not depend on the M03 sign-off** (docs/03: M01 H, M02 S). The M03 gate review stays prepared and unsigned; nothing in S13a touches billing.
- **Classification is stricter than the prompt's wording.** The prompt asks for classes on "every M01–M03 column" and a CI check that fails when a personal/financial/credentials column has none. Implemented: **every column of every table** (863 columns in 78 tables, including the new `compliance` tables) carries an explicit class in `spec/db/ownership.yaml › classification.columns`; the CI check `pnpm compliance:classification-coverage` fails on (1) an unclassified column or table, (2) a stale entry, (3) an unknown class, (4) a column whose NAME looks personal, credential-bearing or financial but is classed `public`/`internal` without a justified exception (six exceptions are listed, each with a reason, e.g. the seller's own company name). A future migration therefore cannot add a column without classifying it.
- **The class assignments are a first proposal, not a legal determination.** The classes are the D-14 proposal set (`public, internal, customer-content, personal, financial, credentials`); the drafting used column-name rules and was then reviewed table by table. Judgement calls the owner or counsel should confirm: idempotency response bodies, notification bodies, operation input/results and the outbox payload are `personal`; PSP and webhook payloads and ZATCA responses are `financial`; the buyer on an invoice is `personal`; organization, project and workspace names are `customer-content`; session timestamps and `last_login_at` are `personal`.
- **Single class per column.** A column with mixed content takes the more restrictive class.
- **Consent purposes are a file, not a table** (docs/05 §4): `spec/compliance/purposes.yaml`, six PROPOSAL purposes. Every wording is `COUNSEL-TEXT-REQUIRED` (HG-04-01); the service reports `pendingCounsel`, and no screen may present the wording as approved. A consent must name the **current** `textVersion`, otherwise 422 (a consent for outdated text is not recorded).
- **No endpoint lists the purposes and their wording** (UI-M04-01 will need it). Not invented: recorded as **SI-M04-6** below; the service has an internal `catalog()` for a later, approved endpoint.
- **Subjects.** `subjectRef` is an opaque id: a member acting for themselves is `member:<userId>`, the organization itself is `org`, an end user is whatever opaque id the organization uses. An email or name is refused (422). Acting for anyone else needs `privacy:consent:manage` (owner, admin: docs/04's "org_admin").
- **Semantics.** History is append-only (trigger, no UPDATE/DELETE/TRUNCATE even for the database owner). The current state of (organization, subject, purpose) is the row with the highest `seq`; `seq` is allocated under an advisory lock in the writing transaction, so concurrent grants and withdrawals have one total order. Granting again with the same wording while already granted answers 200 with the existing record and writes nothing. Withdrawing records a `withdrawn` row pointing at the grant it ends; withdrawing through an older id still ends the CURRENT consent; withdrawing twice changes nothing. `GET` returns the current consent per (subject, purpose); `history=true` returns every row. `ConsentService.isAllowed()` is the question other modules ask and fails closed.
- **Roles.** docs/04 names `compliance_officer` and `security_officer`; the catalogue has `compliance_officer` and **`security`** (SI-M04-5, unchanged here).
- **Environment.** The usual local Postgres port was held by another session's stack, so this sprint used the project's own cluster on an alternate port (`NUZM_PGPORT=54339`, `DATABASE_ADMIN_URL` / `NUZM_TEST_ADMIN_URL` pointing at it). No browser test ran: S13a has no UI (the consent screen UI-M04-01 is S15).

## B. Plan and changed files
- Migration `compliance/0500__compliance__foundations` (+ down): schema, `data_classes` (seeded, tenant-less), `consents` (append-only, forced RLS), permissions `privacy:consent:self|manage`.
- Spec: `spec/db/ownership.yaml` (`classification`, `compliance.data_classes` in `tenant_less`), `spec/compliance/purposes.yaml`, `spec/openapi/openapi.yaml` (+3 operations, tag `compliance`; 120 in total), error code `consent_purpose_unknown`; SDK regenerated.
- Code: `packages/db/src/classification.ts` (+ CLI `classification`, manifest type), `apps/api/src/modules/compliance/` (`consents.controller.ts`, `internal/consent.service.ts`, `internal/purposes.ts`, module, index), registration in `app.module.ts`.
- Tests: `packages/db/src/classification.spec.ts` (15), `compliance/internal/purposes.spec.ts` (12), `compliance/consents.int.spec.ts` (23), cross-tenant fixture for `DELETE /v1/compliance/consents/{id}`.
- Tooling: root script `compliance:classification-coverage`, added to `verify:full`; `CLAUDE.md` command list.

## C. Implemented features, API and UI screens
- **API (3 operations, 120 in total):** `POST /v1/compliance/consents` (201 / 200 existing; Idempotency-Key), `GET /v1/compliance/consents` (current or history, filters purposeId, subject, status, pagination), `DELETE /v1/compliance/consents/{id}` (204). Permission `privacy:consent:self` (every org role); org-level and end-user subjects need `privacy:consent:manage`.
- **Audit:** `compliance.consent.granted`, `compliance.consent.withdrawn`.
- **UI:** none in this part (UI-M04-01 is S15).

## D. Migrations and rollback
`0500` creates `compliance.data_classes` and `compliance.consents`. The dev/staging `.down.sql` drops them and the two permissions; **production is forward-fix and consent history is never dropped** (compliance evidence). `db check` stays clean (RLS forced on `consents`; `data_classes` is listed `tenant_less`).

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 (all unit suites) |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 594** passed (was 568: +23 consent tests and 3 generated cross-tenant cases) |
| `pnpm db:test-rls` / `db check` | OK: ownership + RLS rules hold |
| `pnpm compliance:classification-coverage` | OK: 863 columns in 78 tables, all classified |
| `pnpm lint` · `pnpm typecheck` | exit 0 |
| `pnpm spec:lint` · `pnpm spec:drift` · `pnpm sdk:check` | clean · "120 implemented route(s) all declared" · up to date |
| `pnpm scan:secrets` · `pnpm zatca:guard` | 0 hits · exit 0 |
Highlights: 1,000 consent operations across 50 parallel subjects with **0 stale reads** after a withdrawal (AC-M04-05); ten simultaneous identical grants write exactly one row; a grant/withdraw race leaves `seq` contiguous with no two equal states in a row; the history rejects UPDATE, DELETE and TRUNCATE; another organization sees nothing, cannot withdraw (404) and cannot read the rows with a hand-written query (RLS). `pnpm verify:full` as one command and the browser E2E were **not run** in this sprint (ports held by another session; no UI); the parts that need no browser ran separately as above.

## F. Security, tenant isolation, billing, residency
- Forced RLS on `compliance.consents`; admin-scope read policy prepared for the cross-organization DSR queue (S14/S15); the generated cross-tenant suite covers the new route.
- `subject_ref` is opaque and classed `personal`; no email or name is stored; audit records ids and purpose, not values.
- No billing, no metering, no residency decision in this part (`ResidencyPolicyService` is S14).

## G. Human gates and live checks still needed
- **HG-04-01** counsel: the wording of every consent purpose, lawful bases, PDPL role (D-16); the real class handling per class (D-14). Until then every text is `COUNSEL-TEXT-REQUIRED` and every class policy is `PROPOSAL`.
- Owner review of the proposed column classes (§A).

## H. Acceptance checklist (rows touched in S13a)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-03 classification coverage | **PASS** for all current tables (863/863 columns classed; CI check wired into `verify:full`); the classes themselves are a proposal for owner/counsel review | `pnpm compliance:classification-coverage` |
| AC-M04-05 consent withdrawal effective on next `isAllowed`, 0 stale reads in 1,000 ops | **PASS** | `consents.int.spec.ts` |
| AC-M04-12 RLS cross-tenant over compliance tables | **PARTIAL**: `consents` covered; later tables follow their sprints | cross-tenant + RLS suites |
| AC-M04-01, -02, -04, -06..-11, -13..-14 | NOT STARTED (S13b, S14, S15) | |
| AC-M04-15..-17 | BLOCKED (HG-04-01/02/03) | |

## I. Next-milestone handoff and open decisions
- **S13b:** ROPA CRUD with processor registry and the CI check that every docs/09 adapter kind has a ROPA placeholder (AC-M04-04); retention engine and legal holds through the audit module (dry-run default, dual approval, no UPDATE/DELETE; AC-M04-08); field-encryption retrofit for `credentials` and selected `personal` columns using the new classification as input.
- **Spec issues (report to owner; docs 01–09 untouched):** **SI-M04-5** role names (`security` vs `security_officer`); **SI-M04-6** no operation lists consent purposes and their current wording (needed by UI-M04-01); the classification manifest format is new (`classification` in `spec/db/ownership.yaml`) and should be accepted by the owner; consent role mapping (`privacy:consent:self|manage`) is a proposal.
- Open decisions: D-14, D-15, D-16, D-17, D-34; HG-04-01, HG-04-02.
