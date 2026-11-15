# M04 — Saudi Compliance & Data Residency

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S13–S15 (3) |
| Depends on | M01 **H**; M02 **S** (docs/03) |
| Produces | `ResidencyPolicyService`, `ConsentService`, DSR workflow + `DsrHandler` registry, retention/legal-hold engine, ROPA, transfer assessments, control catalog/mappings/evidence collectors, breach-case workflow, regulatory validation register, compliance UI (customer + admin) |
| Gate | Gate Review per docs/03 §5; counsel inputs (HG-04-01/02) either evidenced or the dependent rows are BLOCKED |
| Reference docs | `10-saudi-compliance-track.md` (design), `07` (D-14/16/17/34, HG-04-xx), `05` (schemas), `04` §2.4 |

Response format: CLAUDE.md §10.

## 1. Objective
Make data residency, privacy rights and cybersecurity-control evidence enforceable and demonstrable. Deliver (a) a fail-closed residency decision service that later milestones must call, (b) consent/DSR/retention/legal-hold mechanics, (c) a control register with automated evidence collection that never claims compliance, (d) breach-case workflow, (e) the customer and admin compliance screens. Values that are legal determinations (deadlines, retention periods, applicability) are **configuration awaiting HG-04-01/02**; ship restrictive defaults.

## 2. Preconditions & mocked interfaces
| Item | State needed | If missing |
|---|---|---|
| M01 audit store, RLS harness, `platform.operations`, outbox, notifications, portal shells | done and gate-signed | stop |
| M02 `commerce`/metering | soft; M04 emits no billable meters | n/a |
| `cloud.provider_regions` (M05) | **not yet existing** | Residency uses `spec/compliance/region-groups.yaml` (country→group) with mock region fixtures; M05 later supplies verified regions. Table of mocks: `MockRegionRegistry` |
| Storage for DSR export archive (M08) | not yet existing | Local dev S3 emulator behind `ExportSink` interface; production sink BLOCKED until D-07 decided → data-export endpoint returns operation `failed(reason=no_export_sink)` in prod config |
| Counsel inputs (D-14, D-16, D-17, D-34) | OPEN | Restrictive defaults (§5) loaded from `spec/compliance/defaults.yaml`, flagged `PROPOSAL` |
| Other modules' `DsrHandler`s | only M01–M03 exist | Implement handlers for identity, tenancy, billing/invoicing (read-only export; erase refused where retention applies); later milestones register theirs |

## 3. Requirement IDs closed
FR-CMP-01..10 (consent; DSR; ROPA; retention/legal hold; residency policy engine; transfer controls; NCA control register; evidence; incident notification workflow; regulatory validation register). FR-UI items: UI-M04-01..16.

## 4. Automatable engineering tasks
**S13 — foundations**
1. Add `classification` annotations to `spec/db/ownership.yaml` for every M01–M03 column/resource kind; CI check `compliance:classification-coverage` fails if any column holding personal/financial/credentials data lacks a class (D-14 proposal classes: `public, internal, customer-content, personal, financial, credentials`).
2. Create `compliance` schema migrations: `data_classes`, `ropa_entries`, `consents`; seed `data_classes`; load purposes from `spec/compliance/purposes.yaml` (text ar/en placeholders marked `COUNSEL-TEXT-REQUIRED`).
3. `ConsentService` (grant/withdraw/isAllowed), append-only consent history, API `/v1/compliance/consents`.
4. ROPA CRUD (admin) with processor/sub-processor registry fields (name, role, region, data classes, contract ref); CI check: every external adapter kind in docs/09 has a ROPA entry placeholder.
5. Retention engine: extend `audit.retention_policies` and `audit.legal_holds` via **audit owner PR**; policy-driven jobs (dry-run default); archival of append-only tables by partition detach under break-glass role with audit event — never row UPDATE/DELETE.
6. Retrofit tasks: identify M01–M03 columns needing field-level encryption (class `credentials`, selected `personal`) and implement via key refs (vault).
**S14 — residency + DSR**
7. Region-group registry and `ResidencyPolicyService.evaluate()` per doc 10 §3; policy versioning; platform floor vs org policy; fail-closed; in-process cache with versioned invalidation; p95 < 20 ms (proposal).
8. `compliance.transfer_assessments` workflow (create → review → approve/reject; approver ≠ requester; expiry; scope class × region × processor); exceptions referenced from policy.
9. Enforcement-hook SDK: `@RequiresResidency({...})` decorator + `assertResidency()` helper in `packages/domain`; catalog test enumerates every table with `data_region` and requires a registered hook call-site (initially none exist → test asserts the **registry of required hooks**, with M05+ milestone owners listed; unimplemented hooks fail only when the owning milestone's feature flag is enabled).
10. DSR workflow: `dsr_requests`, `dsr_tasks`, `DsrHandler` interface (`export`, `erase`, `rectify`), orchestration as `platform.operations`, identity verification step, SLA timers (configurable) with notifications, rejection reasons catalogue; legal-hold and mandatory-retention checks.
11. Data export (`/v1/compliance/data-exports`): async operation → encrypted archive + expiring signed link via `ExportSink`.
**S15 — controls, evidence, breach, UI**
12. `control_catalog` loader from `spec/compliance/controls.yaml` (schema validation; `claims_compliance` must be false); `control_mappings`; admin APIs.
13. Evidence collectors (≥6): CI digest, RLS/ownership test digest, audit hash-chain verification, migration-lint digest, dependency/secret scan digest, config snapshot (headers/TLS). Evidence items hashed (SHA-256) and immutable.
14. `breach_cases` workflow per doc 10 §6 with timeline stored as JSON on the case plus audit events; evidence-pack generator (affected orgs/tables from audit, time window).
15. `regulatory_validations` register with DB constraint: status `validated` requires `document_ref` and `validated_by` (human user id, non-agent).
16. Compliance UI (customer + admin), i18n ar/en, e2e + axe checks.
17. Documentation: compliance runbooks (DSR handling, legal hold, breach), hook guide for later milestones, M04 report.

## 5. Human approvals & external gates
| ID | Item | Agent does meanwhile | Default status |
|---|---|---|---|
| HG-00-01 | Docs approved | nothing | must be GRANTED before S13 |
| HG-04-01 | Counsel memo: PDPL role, lawful bases, transfer rules, retention, DSR/breach deadlines, DPO | Ships restrictive defaults flagged `PROPOSAL`; loads real values only from owner-signed config | PENDING → dependent rows BLOCKED |
| HG-04-02 | NCA/CST applicability + filings | Builds register and evidence; sets all applicability `to_confirm` | PENDING |
| HG-04-03 | Third-party assessments/certifications | Prepares evidence export only | PENDING (out of M04 scope; GA gate) |
| D-14 | Residency default stance | Uses proposal in doc 07 | OPEN |
| D-15 | Control-plane hosting location | Residency tests use mock regions | OPEN |
| D-16 | PDPL roles/DPO | Placeholders | OPEN |
| D-17 | NCA/CST scope | Placeholder controls | OPEN |
| D-34 | Retention periods | Proposals in doc 10 §5, configurable | OPEN |
The agent may not mark any HG GRANTED; owner records evidence in `docs/reports/`.

## 6. API specifications (doc 04 §2.4, exact)
All endpoints: problem+json errors; org context from token; POST requires `Idempotency-Key`.
| Endpoint | Portal / authz | Key request → response | Behaviour |
|---|---|---|---|
| POST `/v1/compliance/consents` | C A R; any member for self, `org_admin` for org-level | `{purposeId, granted:true, localeShown, textVersion, subjectRef?}` → `Consent` | Append-only; idempotent per key; 409 if purpose unknown |
| GET `/v1/compliance/consents` | C A R | filters `purposeId, subject, status` → page | |
| DELETE `/v1/compliance/consents/{id}` | C A R | → 204 (records `withdrawn` entry; row retained) | Applies immediately |
| POST `/v1/compliance/data-subject-requests` | C A R; subjects: members for self; `org_admin` for end-users of org | `{type: access\|correction\|deletion\|portability, subjectRef, details}` → `201 DsrRequest{status:'received', dueAt}` + `operationId` | Emits `compliance.dsr.opened`; identity verification task created |
| GET `/v1/compliance/data-subject-requests`, `/{id}` | C A R (own org); admin realm token reads cross-org (assumption A-M04-1, see §15 spec issue) | → `DsrRequest{status, tasks[], dueAt, outcome, reasonCode?}` | |
| GET/PUT `/v1/compliance/residency-policy` | C A R; PUT `org_admin`; If-Match required | `{mode, allowedCountriesByClass, exceptions:[assessmentId]}` → `ResidencyPolicy{version}` | Org may only tighten platform floor → 422 `policy_below_floor`; every PUT audited |
| GET/POST `/v1/compliance/data-exports` | C A R; `org_admin` | POST `{scope: org\|user, subjectRef?}` → `202` + operation; GET list/status with `downloadUrl` (expiring) | Async; in-region sink; 422 `no_export_sink` if unavailable |
| GET/POST `/v1/admin/compliance/ropa` | X; role `compliance_officer` | ROPA entry fields | Versioned |
| GET/POST `/v1/admin/compliance/controls` | X; `compliance_officer`, `security_officer` | catalog (read), mapping create | `claims_compliance` always false |
| GET/POST `/v1/admin/compliance/evidence` | X | POST: manual evidence `{controlId, type, documentRef, attestedBy}`; GET: includes automated | Automated rows created only by collectors |
| GET/PUT `/v1/admin/compliance/retention-policies`; POST `/v1/admin/compliance/legal-holds` | X; `compliance_officer`; legal hold requires dual approval (second approver in body) | policy `{dataClass, retainDays, archiveAfterDays, basis}`; hold `{scope, reason, approvers[2]}` | Writes `audit.*` tables through audit module |
| GET/POST `/v1/admin/compliance/transfer-assessments` | X | `{class, region, processorId, risk, mitigations, expiresAt}`; decision requires different approver | |
| GET/POST `/v1/admin/compliance/regulatory-validations` | X | `{regime, question, applicability, status, documentRef?, validatedBy?}` | `validated` requires human + doc ref |
| POST/GET `/v1/admin/compliance/breach-cases` | X; `security_officer`, `compliance_officer` | `{summary, detectedAt, severity, linkedIncidentId?}`; transitions via POST to same resource with `{transition}` body (PATCH not in spec; see §15) | State machine; timers configurable |
Errors (codes in `spec/openapi/errors.yaml`): `consent_purpose_unknown`, `dsr_identity_unverified`, `policy_below_floor`, `residency_denied`, `legal_hold_active`, `retention_mandatory`, `no_export_sink`, `assessment_expired`, `validation_requires_evidence`.

## 7. Database migrations
Owner schema `compliance` (creates, M04); `audit` extended through audit module PR. Migration range reserved in `spec/db/ownership.yaml` at S13.
| Table | Key columns | Notes |
|---|---|---|
| `compliance.data_classes` | id, key, label_ar/en, default_policy | tenant-less reference; seeded |
| `compliance.consents` | id, org_id, subject_ref, purpose_id (text from purposes.yaml), state, text_version, locale, source, created_at | **append-only**; index (org_id, subject_ref, purpose_id, created_at desc) |
| `compliance.ropa_entries` | id, org_id null (platform-level entries have null; platform-level rows tenant-less, listed in manifest), activity, purpose, data_classes[], processors jsonb, regions[], retention_ref, version | |
| `compliance.residency_policies` | id, org_id, version, mode, allowed jsonb, exceptions uuid[], effective_from, created_by | unique (org_id, version); platform floor row has org_id null |
| `compliance.transfer_assessments` | id, org_id null, data_class, region_group/country, processor_id, risk, mitigations, status, requested_by, approved_by, expires_at | CHECK requested_by <> approved_by |
| `compliance.dsr_requests` / `dsr_tasks` | request: id, org_id, subject_ref, type, status, due_at, outcome, reason_code; task: request_id, handler, status, result_ref, error | RLS; index (org_id, status, due_at) |
| `compliance.control_catalog` / `control_mappings` | catalog tenant-less; mappings (control_id, module, feature, evidence_requirement) | CHECK claims_compliance=false |
| `compliance.evidence_items` | id, control_id, type, source, content_hash, collected_at, collector, document_ref, attested_by | immutable (trigger) |
| `compliance.breach_cases` | id, severity, state, summary, detected_at, timeline jsonb, linked_incident_id (opaque id; no FK) | |
| `compliance.regulatory_validations` | id, regime, question, applicability, status, document_ref, validated_by, validated_at | CHECK (status<>'validated' OR (document_ref IS NOT NULL AND validated_by IS NOT NULL)) |
| `audit.retention_policies`, `audit.legal_holds` | per doc 05 (audit owner) | holds immutable except release record |
RLS: all `org_id` tables policy `org_id = current_setting('app.org_id')::uuid`; tenant-less tables listed explicitly in manifest and admin-realm only. **Not in doc 05 and therefore NOT created:** `consent_purposes`, `data_exports`, `breach_case_events` — replaced by `spec/compliance/purposes.yaml`, `platform.operations` + `ExportSink`, and `breach_cases.timeline` (see §15). Reversal: migrations drop new tables in reverse order in dev/staging; production = forward fix; `audit.*` additions are expand-only (nullable columns).

## 8. UI screens
All screens: ar (RTL) + en, loading/empty/error/forbidden states, keyboard accessible, e2e + axe.
| ID | Portal | Route | Purpose | Key states / roles |
|---|---|---|---|---|
| UI-M04-01 | C A R | `/privacy/consents` | View/grant/withdraw consents | withdrawn banner; members |
| UI-M04-02 | C A R | `/privacy/requests` | DSR list with SLA countdown | overdue badge; org_admin |
| UI-M04-03 | C A R | `/privacy/requests/new` | Create DSR (type, subject, details) | validation, identity step |
| UI-M04-04 | C A R | `/privacy/requests/[id]` | DSR detail, tasks, outcome | rejected-with-reason view |
| UI-M04-05 | C A R | `/settings/data-residency` | View/edit residency policy (tighten only), exceptions list | floor-violation error; org_admin edit |
| UI-M04-06 | C A R | `/privacy/exports` | Request/download data export | pending/expired/no-sink |
| UI-M04-07 | X | `/compliance/ropa` | ROPA list/edit | versions |
| UI-M04-08 | X | `/compliance/data-classes` | Classification catalogue and coverage report | coverage % |
| UI-M04-09 | X | `/compliance/controls` | Control catalog, mappings, status ("mapped", never "compliant") | filters by framework |
| UI-M04-10 | X | `/compliance/evidence` | Evidence list, add manual evidence, collector runs | hash display |
| UI-M04-11 | X | `/compliance/retention` | Retention policies, legal holds (dual approval) | hold active warnings |
| UI-M04-12 | X | `/compliance/transfer-assessments` | Assessment workflow | approver ≠ requester |
| UI-M04-13 | X | `/compliance/validations` | Regulatory validation register | validated needs doc+human |
| UI-M04-14 | X | `/compliance/breach-cases` | Breach list + detail + timeline + evidence pack | state transitions |
| UI-M04-15 | X | `/compliance/dsr-queue` | Cross-org DSR queue and task handling (assumption A-M04-1) | SLA sorting |
| UI-M04-16 | X | `/compliance/residency` | Platform floor policy, matrix viewer, evaluate-simulator | simulator read-only |

## 9. Security, compliance & tenant-isolation requirements
- RLS on all org-scoped compliance tables; admin realm required for tenant-less tables; cross-org admin reads audited with reason field.
- Residency service fail-closed; decisions logged; policy changes dual-controlled for platform floor (two admins).
- PII classification: `subject_ref` stored as opaque id/hash; DSR free-text `details` classed `personal`, encrypted at field level; exports encrypted with per-export key (vault ref).
- Audit events: `consent.granted|withdrawn`, `dsr.opened|task.completed|closed`, `residency.policy.updated`, `residency.evaluate.denied`, `transfer.assessment.approved|expired`, `legalhold.created|released`, `retention.job.run`, `control.mapping.changed`, `evidence.added`, `breach.transition`, `validation.changed`.
- No agent-writable path can set `validated`, grant HG, or set `claims_compliance=true` (CI test).
- Break-glass archive operation requires admin MFA + second approver.

## 10. Metering & billing hooks
No billable meters in M04 (DSR/export not billed — proposal; D-23 may revise). Hooks: DSR export storage is internal cost; emit no metering events. Quota check: max 5 concurrent export operations per org (proposal, configurable).

## 11. Automated tests
- **Policy matrix:** 6 data classes × 4 region groups (`in_kingdom, gcc, eu, other`) × 3 modes (`in_kingdom_only, allow_listed, unrestricted_with_assessment`) = **72 cells**, each with expected `allow|deny|requires_assessment` in a table-driven fixture; plus floor-vs-org tightening cases (≥12) and exception cases (valid, expired, wrong scope, requester=approver) (≥8). Coverage target 100% of matrix cells asserted; branch coverage of evaluator ≥ 95%.
- Fail-closed: service/config unavailable → deny on write path (test with injected failure).
- Consent: grant/withdraw/idempotent replay; consumer checks; concurrent grant/withdraw ordering.
- DSR e2e for 4 types with a fake clock: warning at 70%, escalation at 90%; legal hold blocks erasure; mandatory retention returns `retention_mandatory`; handler failure → task retry then `partially_fulfilled`.
- Export: encrypted archive decrypts only with vault key; link expiry; cross-tenant link denied.
- Retention: dry-run vs execute on fixtures; legal-hold exclusion; append-only tables never UPDATE/DELETE (trigger test); archive via detach with audit.
- Controls: schema validation rejects `claims_compliance:true`; mapping CRUD; evidence immutability; `validated` constraint.
- Collectors: each of ≥6 produces hashed evidence in CI; re-run idempotent.
- Breach: all state-machine transitions valid/invalid (100% edges); timers configurable.
- Cross-tenant: RLS suite over every `org_id` compliance table; DSR task cannot read other org data; admin cross-org reads audited.
- Classification coverage: CI check passes at 100% of annotated columns.
- UI: e2e for UI-M04-01..16; axe 0 critical/serious in ar and en; RTL visual snapshots.
- Performance: evaluate() p95 < 20 ms at 1k rps in-process benchmark (proposal).

## 12. Deliverables
Code + migrations + OpenAPI updates (`spec/openapi/compliance.yaml`), `spec/compliance/{controls,purposes,region-groups,defaults}.yaml`, collectors, UI, hook guide `docs/runbooks/residency-hooks.md`, runbooks (DSR, legal hold, breach), `docs/reports/M04-report.md` with actual outputs, demo script: (1) tighten org policy → provisioning mock denied; (2) file deletion DSR under legal hold → refused with reason; (3) add evidence → control shows "evidence collected"; (4) open breach case → evidence pack.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Default |
|---|---|---|---|
| AC-M04-01 | Policy matrix: 72/72 cells asserted, evaluator branch coverage ≥ 95% | test report | PENDING |
| AC-M04-02 | Fail-closed on write paths verified (≥3 failure injections) | test log | PENDING |
| AC-M04-03 | Classification coverage = 100% of columns flagged personal/financial/credentials in manifest | CI output | PENDING |
| AC-M04-04 | ROPA entry exists for 100% of adapter kinds in docs/09 and 100% of data classes in use | CI output | PENDING |
| AC-M04-05 | Consent withdrawal effective on next `isAllowed()` call (0 stale reads in concurrency test of 1,000 ops) | test log | PENDING |
| AC-M04-06 | DSR 4 types e2e pass; timer warning/escalation fire at configured thresholds (fake clock) | e2e report | PENDING |
| AC-M04-07 | Erasure refused with documented reason under legal hold and mandatory retention (2/2 cases) | test log | PENDING |
| AC-M04-08 | Append-only enforcement: 0 successful UPDATE/DELETE on `audit.*` ledger-class tables in mutation test | test log | PENDING |
| AC-M04-09 | ≥6 evidence collectors produce hashed evidence; re-run yields identical hash for identical inputs | collector logs | PENDING |
| AC-M04-10 | 0 control rows with `claims_compliance=true`; CI rule present; UI never displays "compliant" (grep + e2e) | CI/e2e | PENDING |
| AC-M04-11 | Breach state machine: 100% valid transitions pass, 100% invalid rejected | test report | PENDING |
| AC-M04-12 | RLS cross-tenant suite: 0 leaks across all `org_id` compliance tables | RLS report | PENDING |
| AC-M04-13 | UI-M04-01..16 e2e pass; axe 0 critical/serious in ar and en | e2e + axe | PENDING |
| AC-M04-14 | Residency hook registry lists every required call-site for M05–M12 with owner milestone | registry file | PENDING |
| AC-M04-15 | Counsel-determined values (deadlines, retention, roles) loaded from owner-signed config | HG-04-01 evidence | BLOCKED until HG-04-01 |
| AC-M04-16 | NCA/CST applicability recorded for each regime with human validator | HG-04-02 evidence | BLOCKED until HG-04-02 |
| AC-M04-17 | Third-party assessment/certification | HG-04-03 | BLOCKED (not satisfiable by agent) |

## 14. Handoff
M05 must call `evaluate()` for offers/quotes/provisioning and supply verified region records; M06–M12 per doc 10 §3 hook table; M08 supplies `ExportSink` real implementation after D-07; M12 extends retention/audit archive and incident tooling; open items: D-14/16/17/34, HG-04-01/02.

## 15. Compliance hooks checklist
- [ ] Residency: service live, hook registry published, retrofits for M01–M03 listed
- [ ] Consent/PII: classification annotations 100%, field encryption for `credentials`
- [ ] Audit: events in §9 emitted; admin cross-org reads logged
- [ ] Retention: policies seeded as PROPOSAL, legal hold dual-approval, append-only preserved
- [ ] Docs: runbooks reviewed by compliance owner (human)

**Spec issues found (report to owner; agent must not edit docs 01–09):** SI-M04-1 no admin DSR queue endpoint (A-M04-1 assumes admin-realm privileged read of `/v1/compliance/data-subject-requests`); SI-M04-2 no state-transition endpoint for breach cases (POST on same resource used); SI-M04-3 doc 05 has no tables for consent purposes, data exports, breach timeline, residency exceptions; SI-M04-4 event topics for consent/DSR beyond `compliance.dsr.opened` not defined; SI-M04-5 role catalogue (`compliance_officer`, `security_officer`) not defined in docs 01–09 (M01 must add).

## Completion instruction
Do not mark M04 DONE until every acceptance row is evidenced. Rows depending on HG-04-01/02/03 stay BLOCKED until the owner records evidence; mocks never convert BLOCKED to PASS. The agent may not mark any HG GRANTED, set a regulatory validation to `validated`, or claim compliance with any regime. Deliver `docs/reports/M04-report.md` in the CLAUDE.md §10 format.
