# M04 Milestone Report — Saudi Compliance & Data Residency

Format: CLAUDE.md §10. Sprint reports: [S13a](S13a-report.md) · [S13b](S13b-report.md) · [S13c](S13c-report.md) · [S13d](S13d-report.md) · [S14a](S14a-report.md) · [S14b](S14b-report.md) · [S15](S15-report.md).

Status: **NOT SIGNED. Prepared 2026-11-18 for the owner's gate review.** Nothing in M04 states that Nuzm meets any regime. Counsel inputs (HG-04-01), NCA/CST applicability (HG-04-02) and third-party assessments (HG-04-03) are **PENDING**: every value that is a legal determination is a restrictive **proposal** flagged as such, and no regulatory validation is `validated`. **All seven sprints are uncommitted in the working tree.** The browser screens were **never run in a browser**.

## A. Repository findings and assumptions
- Approved documentation governs (HG-00-01, 2026-11-15); M01/M02 signed with deferrals; **M03 is prepared but unsigned** ([gate review](M03-gate-review.md), "hold for owner"). M04 proceeded on the owner's "move to next" under docs/03 §5 (mocked-interface work allowed).
- **Conflicts and gaps recorded (never silently reconciled):** SI-M04-1 no admin DSR queue endpoint (PA-13); SI-M04-2 no transition endpoint for breach cases (POST on the same resource used); SI-M04-3 docs/05 has no tables for purposes, exports, breach timeline (replaced by `purposes.yaml`, `platform.operations` + `ExportSink`, a JSON timeline); SI-M04-4 event topics beyond `compliance.dsr.opened` undefined; SI-M04-5 role names (`security_officer` in docs/04, `security` in the catalogue); SI-M04-6 no operation lists consent purposes and wording; SI-M04-7 no list of legal holds; SI-M04-8 no endpoint for the platform floor and the evaluate-simulator; SI-M04-9 no customer list of transfer assessments. docs/05 overrides the prompt: exports are operations, not a table.
- **Every legal value is a proposal:** deadlines (DSR 30 days, warn 70 % / escalate 90 %; breach 24/48/72 h), retention periods, residency floor, region groups, consent and refusal wording (`COUNSEL-TEXT-REQUIRED`), classification classes. They live in `spec/compliance/*.yaml` and `defaults.yaml`; counsel's values load from owner-signed config only.
- **Mocks never convert BLOCKED to PASS:** regions come from mock fixtures until M05 (an unverified Saudi region counts as outside the Kingdom); the export sink is local in development and **absent in production** (422 `no_export_sink`) until D-07/M08.
- Design choices needing the owner: the compliance jobs run in the API process like the billing scheduler (ADR-017 still PROPOSED), with cross-organization discovery only if the API is given `WORKER_DATABASE_URL`; identity verification of a request about someone else is a **written attestation** by an administrator, not a check the platform performs; "not applicable" tasks are neutral when closing a request.

## B. Plan and changed files
| Sprint | Content |
|---|---|
| S13a | classification manifest and coverage check; `compliance` schema; consents (append-only) and purposes |
| S13b | ROPA (versioned, four-eyes review), adapter and class coverage check |
| S13c | retention policies, legal holds (dual approval), dry-run, archival by partition detach under break-glass |
| S13d | field-level encryption retrofit (AES-256-GCM, keyring, vault references) |
| S14a | residency decision service (fail closed), transfer assessments, enforcement-hook registry |
| S14b | DSR workflow and handlers, SLA timers, data exports through `ExportSink` |
| S15 | control register, evidence and collectors, regulatory validation register, breach cases, compliance screens |
Migrations `0500, 0501, 0502 (audit), 0503 (invoicing), 0504, 0505, 0506` (all inside `0500–0599`). Specs: `spec/compliance/{purposes,region-groups,residency-hooks,defaults,controls}.yaml`, `openapi.yaml` (117 → **142** operations), error codes `consent_purpose_unknown`, `residency_denied`, `policy_below_floor`, `assessment_expired`, `dsr_identity_unverified`, `legal_hold_active`, `retention_mandatory`, `no_export_sink`, `validation_requires_evidence`. Runbooks `field-encryption`, `legal-hold`, `retention-archival`, `dsr-handling`, `breach-handling`, `compliance-evidence`, `residency-hooks`, `demo-m04`.

## C. Implemented features, API and UI screens
- **Privacy:** consents with immediate withdrawal; DSR (access, correction, deletion, portability) with identity step, SLA timers, refusal reasons in Arabic and English, legal-hold and mandatory-retention checks; encrypted exports with signed expiring links.
- **Data protection:** classification of 1035 columns with CI coverage; ROPA for every adapter kind and data class; retention and legal holds; field encryption of credentials and sealed personal data.
- **Residency:** one fail-closed decision service (72-cell matrix asserted), versioned organization policy tighten-only over a platform floor, transfer assessments with four-eyes and expiry, a hook registry of every call site M05–M12 must add.
- **Controls and incidents:** 12 own-wording controls, 8 collectors with hashed immutable evidence, manual evidence, validation register, breach-case workflow with a human notification decision and an evidence pack. **No claim of compliance anywhere**; a CI guard enforces it.
- **API:** 25 new operations (117 → 142). **Screens:** see §H (all unrun in a browser).

## D. Migrations and rollback
Seven forward migrations, each with a dev/staging-only `.down.sql`; production is forward-fix. Consents, ROPA versions, requests, evidence, validations and breach cases are compliance records, **never dropped** in a production profile.

## E. Tests run with actual results
Last full verification (S15, 2026-11-18): `pnpm lint` exit 0 · `typecheck` exit 0 · `build` exit 0 · `turbo test` exit 0 · spec lint, drift (**142**), SDK check, secret scan (0 hits), `db:migrate`, `db:test-rls`, classification (1035 columns), ROPA coverage, residency hooks, **claims guard**, `zatca:guard` all OK · collectors run twice: all `same`. **Integration:** db 43, platform 32, worker 8, api 746 tests with 741 passing in the full run; the 5 failures were a pre-existing time-of-day bug in `finrec/reports.int.spec.ts` (a UTC/Riyadh date mismatch, test-only fix), that file then passed alone 15/15; **the full integration run was not repeated after the fix**. **Not run:** browser E2E, axe, RTL screenshots, `pnpm verify:full` as one command, the evaluator branch-coverage measurement (no coverage provider could be installed).

## F. Security, tenant isolation, billing, residency
- Forced RLS on every org table; platform registers are admin-scope only; the runtime role cannot write the control catalog or automated evidence. The cross-tenant suite covers consents and requests; exports and the other compliance tables have their own isolation tests; AC-M04-12 stays PARTIAL.
- Residency fails closed on any failure; denials are logged without personal data. No personal data leaves the platform from any M04 feature (local sink only; no regulator or customer notification is ever sent).
- No billing or metering hooks (as the prompt specifies).

## G. Human gates and live checks still needed
HG-04-01 counsel memo (PDPL role, lawful bases, transfer rules, retention, DSR and breach deadlines, DPO) · HG-04-02 NCA/CST applicability and framework control references · HG-04-03 assessments (out of scope for the agent) · D-07 export sink · D-12/D-14/D-15/D-16/D-17/D-34 · ADR-017 · PA-13 · the first browser run of all new screens · counsel review of the Arabic and English wording.

## H. Acceptance checklist
| ID | Status | Evidence |
|---|---|---|
| AC-M04-01 policy matrix 72/72; branch coverage ≥ 95 % | **72/72 PASS; coverage NOT VERIFIED** | `evaluator.spec.ts`, [S14a](S14a-report.md) |
| AC-M04-02 fail-closed on write paths (≥ 3 injections) | **PASS** | `residency.int.spec.ts` |
| AC-M04-03 classification coverage 100 % | **PASS** (1035/1035; classes are a proposal) | `pnpm compliance:classification-coverage` |
| AC-M04-04 ROPA for every adapter kind and class in use | **PASS** | `pnpm compliance:ropa-coverage` |
| AC-M04-05 consent withdrawal, 0 stale reads in 1,000 ops | **PASS** | `consents.int.spec.ts` |
| AC-M04-06 DSR 4 types e2e; timers on a fake clock | **PASS as integration tests; no browser e2e** | `dsr.int.spec.ts` |
| AC-M04-07 erasure refused under legal hold and mandatory retention | **PASS** | `dsr.int.spec.ts` |
| AC-M04-08 append-only, 0 UPDATE/DELETE on audit ledger-class tables | **PARTIAL** (`audit_checkpoints` has a trigger but no mutation test of its own; `access_reviews` is M12) | integration suites, [S13c](S13c-report.md) |
| AC-M04-09 ≥ 6 collectors, identical hash on re-run | **PASS** (8; limits stated in the evidence) | CLI runs, `controls.spec.ts` |
| AC-M04-10 0 claiming controls; CI rule; UI never says it | **PARTIAL** (CI guard + DB CHECK PASS; e2e half NOT RUN) | `compliance:claims-guard` |
| AC-M04-11 breach state machine 100 % valid/invalid edges | **PASS** | `state.spec.ts`, `controls-breach.int.spec.ts` |
| AC-M04-12 RLS cross-tenant, 0 leaks over compliance org tables | **PARTIAL** | cross-tenant and per-feature suites |
| AC-M04-13 UI-M04-01..16 e2e + axe | **NOT VERIFIED** (no e2e, no axe) | see below |
| AC-M04-14 hook registry lists every call site M05–M12 | **PASS** | `pnpm compliance:residency-hooks` |
| AC-M04-15 counsel values from owner-signed config | **BLOCKED (HG-04-01)** | |
| AC-M04-16 NCA/CST applicability with human validator | **BLOCKED (HG-04-02)**; register built, no row validated | |
| AC-M04-17 third-party assessment | **BLOCKED (HG-04-03)**; not satisfiable by the agent | |
Screens (built, unit-tested, **not run in a browser**): UI-M04-01 consents **PARTIAL** (list and withdraw; grant needs SI-M04-6) · -02 requests, -03 new, -04 detail, -05 residency, -06 exports, -09 controls, -10 evidence, -13 validations, -14 breach cases: built · -07 ROPA, -11 retention, -12 assessments: **read-only lists** (edit flows exist as API only) · -08 data-class coverage: **not built** (no endpoint) · -15 DSR queue **BLOCKED (PA-13)** · -16 platform floor and simulator **BLOCKED (SI-M04-8)**.

## I. Next-milestone handoff and open decisions
M05 calls `evaluate()` for offers, quotes and provisioning, supplies verified regions, registers its hooks and its `DsrHandler`; M06–M12 per the hook registry; M08 the real `ExportSink` (D-07); M12 incident tooling, the access-review collector and the audit archive extension. Open: HG-04-01/02/03, D-07, D-12, D-14, D-15, D-16, D-17, D-34, ADR-017, SI-M04-1..9. **M03 is also still unsigned** (see its gate review).
