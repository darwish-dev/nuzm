# S15 report — Controls, evidence, breach cases, regulatory validation register, compliance screens (M04 sprint 15)

Status: backend implemented and verified against real PostgreSQL; screens built and unit-tested but **never run in a browser** (E2E skipped by the owner, none written for these screens). **Not committed**: S13a–S15 are all in the working tree and share files; commit them together. Next: the M04 report and gate review ([M04-report.md](M04-report.md), [M04-gate-review.md](M04-gate-review.md), prepared, **not signed**).

## A. Repository findings and assumptions
- **No compliance claim anywhere.** `claims_compliance` is validated false by the loader, CHECKed false in the database, and `pnpm compliance:claims-guard` (part of `pnpm verify`) fails the build if controls.yaml is invalid or any screen, message, API text or spec text uses a claim word (English "compliant", "certified", "complies"; Arabic equivalents). I proved it fails on a planted claim and passes after removal; it also caught three comments of my own. Statuses are "mapped", "evidence collected", "reviewed by <role>".
- **Catalog.** `spec/compliance/controls.yaml` holds 12 controls in our own words, **no framework references** (HG-04-02), applicability always `to_confirm` (the loader refuses anything else: only a human with counsel decides, in the validation register). It is loaded by `pnpm compliance:sync-controls` (also run by `pnpm db:migrate`) under the admin role; the runtime role has SELECT only. Controls removed from the file stay (evidence may reference them) and are reported as orphaned.
- **Evidence.** Immutable. Manual items (document, attestation, external-report) are added by people; the signed-in person is the named human and nobody can attest for someone else. **Automated** items are written only by the collectors under the admin role: the API refuses the type (403) and a row-level policy refuses it for the runtime role. A unique index per (control, collector, hash) makes a re-run over identical input add nothing.
- **Eight collectors** (AC-M04-09 asks for six): ownership/RLS check, classification coverage, audit chain verification, migration lint, secret scan + lockfile digest, security-header snapshot, ROPA coverage, residency-hook registry. Honest limits, written into the evidence itself: the secret scan is a pattern scan (and the number of files walked is left out of the hash because it varies with build output); **no vulnerability database is queried**; the header snapshot reads the **application source**, not a running deployment or TLS; `audit.chain-verification` on the dev database verified **0 chains** (no audit rows there), so that sample is an empty-state result.
- **Validation register.** Versioned, immutable, nine open questions seeded from docs/10 §1. `validated` needs a document reference, a decided applicability and the caller as the named validator: 422 `validation_requires_evidence` from the API and CHECK constraints in the database. There is no automated path (the admin realm is for people). The platform creates the questions (created_by NULL); people answer them.
- **Breach cases.** Fixed edges `detected → triaged → assessed → notification_decision → notified → remediation → closed`; after the decision only the branch decided is allowed. The timeline is append-only (a trigger compares the old entries as a prefix of the new). The notification decision must be made by **a different person than the assessor** (403). `notified` records that people notified; **the platform sends nothing to anyone**. Timers (24/48/72 h from detection) are placeholders from `defaults.yaml`, shown only. The evidence pack reads the audit trail of the organizations named in the assessment (24 h before detection until now), needs a reason (10–300 characters) because it reads across organizations, is audited, and carries a digest that is stable for the same input.
- **Roles.** New platform permissions `admin:controls:manage` and `admin:breach:manage` for `compliance_officer`, `security` and `platform_admin`; validations use `admin:compliance:manage`. The prompt's `security_officer` is the catalogue's `security` (SI-M04-5).
- **PATCH is not in the spec** (SI-M04-2): a breach case is moved by `POST` with `{caseId, transition, baseVersion}`; the evidence pack is `?pack=true` on the list (no new path).
- **Screens.** Admin: Compliance section (Controls, Evidence, Validation, Breach cases with detail, timeline, next step and pack; read-only lists for ROPA, retention policies, transfer assessments). Customer: Privacy section (Consents, Data requests with list, new and detail, Data exports) and Settings → Data residency. All in Arabic (RTL) and English with the loading/empty/error/forbidden states of the shared kit.
- **Pre-existing test fixed.** `finrec/reports.int.spec.ts` failed 5 tests between 00:00 and 03:00 Riyadh time: its independent ledger query used a bare `::date` cast (database session zone, Riyadh) while the reports cut days in UTC. The query now converts the day with `AT TIME ZONE 'UTC'`. No application code changed.
- **Spec issues and gaps (not invented):** **SI-M04-6** no operation lists consent purposes and their wording, so the customer consent screen lists and withdraws but **cannot grant** (it says why on screen). **SI-M04-1/PA-13** no admin DSR queue → UI-M04-15 BLOCKED. **SI-M04-8** no endpoint for the platform floor or the evaluate-simulator → UI-M04-16 BLOCKED. **SI-M04-7** no legal-hold list and **no editing endpoints used by screens** → UI-M04-07, -11, -12 are read-only lists (ROPA review, hold requests and assessment decisions exist as API only). UI-M04-08 (coverage report) has no endpoint → not built.

## B. Plan and changed files
- Migration `compliance/0506__compliance__controls_breach_validations` (+ down): `control_catalog`, `control_mappings`, `evidence_items`, `regulatory_validations`, `breach_cases` (+ seeds, permissions, guards, forced RLS under the admin scope); `ownership.yaml` (tenant-less list, 1035 classified columns).
- Spec: `spec/compliance/controls.yaml`, `defaults.yaml` (`breach:`), `openapi.yaml` (+8 operations, 142 in total), error code `validation_requires_evidence`, SDK regenerated; `.env.example` unchanged here.
- Packages/scripts: `packages/db/src/{controls,collectors}.ts` + CLI (`sync-controls`, `collect-evidence`), `scripts/compliance-claims-guard.ts`, root scripts, `CLAUDE.md` command list.
- API: `internal/controls/{controls,evidence}.service.ts`, `internal/validations.service.ts`, `internal/breach/{state,breach.service}.ts`, four admin controllers, module wiring.
- UI: admin `lib/compliance.ts`, `components/Compliance{Tabs,Panels}.tsx`, seven pages, nav entry; web `lib/privacy.ts`, `components/Privacy{Tabs,Panels}.tsx`, six pages, nav entry; 259 new message keys in both languages.
- Tests: `controls.spec.ts` (9), `state.spec.ts` (5), `controls-breach.int.spec.ts` (27), admin `compliance.spec.ts` + `CompliancePanels.spec.tsx` (20), web `privacy.spec.ts` + `PrivacyPanels.spec.tsx` (20).
- Docs: runbooks `breach-handling`, `compliance-evidence`, `residency-hooks`, `demo-m04`.

## C. Implemented features, API and UI screens
- **API (8 operations, 142 in total):** `GET`/`POST /v1/admin/compliance/{controls, evidence, regulatory-validations, breach-cases}`.
- **UI:** see §A; the screen-by-screen status is in [M04-report §H](M04-report.md).

## D. Migrations and rollback
`0506` has a dev/staging `.down.sql`; production is forward-fix (evidence, validations and breach cases are compliance records, never dropped). No data migration; the catalog is data loaded from a file.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` (eslint + prettier) · `pnpm typecheck` · `pnpm build` (both Next apps) | exit 0 · exit 0 · exit 0 |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 (db 55, web 69, admin 61, i18n 9, api unit, …) |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · **142** routes all declared · up to date · 0 hits in 3303 files |
| `pnpm db:migrate` · `db:test-rls` · classification (**1035** columns, 91 tables) · ROPA · residency hooks · **claims guard** · `zatca:guard` | all OK (controls: 12 loaded, idempotent) |
| `pnpm compliance:collect-evidence` twice | all 8 collectors: second run `new=0 same=1` for every one |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 746 tests: 741 passed and 5 failed in the full run**; the 5 were the pre-existing time-of-day failure in `finrec/reports.int.spec.ts` (§A), fixed, file re-run alone **15/15**; the full integration run was not repeated after that fix |
Not run: browser E2E, axe, RTL screenshots; `pnpm verify:full` as one command. Lint was re-run clean after the last edits (unused imports and one expression statement).

Highlights of `controls-breach.int.spec.ts`: role matrix on all four registers (support and customers refused); mapping validation, replay, uniqueness, append-only, `claims_compliance=true` refused by the database, catalog unwritable by the runtime role and invisible outside the admin scope; evidence types, the named-human rule, replay and key reuse, keyset paging, runtime role refused automated evidence by row-level security, collectors' idempotent insert, CHECKs on automated and manual shapes, immutability; seeded questions, answer → validated with every refusal (no document, undecided applicability, someone else named), database CHECKs, versions/409/replay/history; breach: validation, replay, every skip refused, the four-eyes decision, the notify branches, a closed case frozen, six audited transitions, guard triggers (timeline edit, skipped state, rewritten summary, delete, truncate), overdue timers on a fake clock, and the evidence pack (reason required, audited, stable digest).

## F. Security, tenant isolation, billing, residency
- All five tables are tenant-less registers under forced RLS, admin scope only; the runtime role cannot write the catalog or automated evidence. Cross-organization reads (the pack) need a reason and are audited. No billing or metering. No personal data is added; the pack contains audit metadata, not row contents.
- Customer screens call the existing org-scoped, RLS-protected endpoints; no new customer data path.
- The claims guard runs in `pnpm verify`.

## G. Human gates and live checks still needed
- **HG-04-01** counsel (deadlines, retention, wording, breach timers and recipients, DPO), **HG-04-02** NCA/CST applicability and framework control references, **HG-04-03** assessments. Nobody has validated anything; no validation row is `validated`.
- **Owner/compliance owner:** supply framework references for the catalog; review the control wording; decide whether the collectors' scope descriptions are acceptable.
- **First browser run** of the new screens, with axe and Arabic/English screenshots, before AC-M04-13 can be answered.

## H. Acceptance checklist (rows touched in S15)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-09 ≥ 6 collectors, hashed evidence, identical hash on re-run | **PASS** (8 collectors; two CLI runs all `same`; unit tests of hashing) | `controls.spec.ts`, CLI output |
| AC-M04-10 0 control rows claiming compliance; CI rule; UI never displays "compliant" (grep + e2e) | **PARTIAL**: file validation, DB CHECK and the CI claims guard PASS; the **e2e half is NOT RUN** | `controls.spec.ts`, `controls-breach.int.spec.ts`, `compliance:claims-guard` |
| AC-M04-11 breach state machine: all valid transitions pass, all invalid rejected | **PASS** (all 49 ordered pairs: 7 valid, 42 invalid; API and database) | `state.spec.ts`, `controls-breach.int.spec.ts` |
| AC-M04-13 UI-M04-01..16 e2e + axe | **NOT VERIFIED** (no e2e, no axe run) | |
| AC-M04-12 RLS cross-tenant | PARTIAL (unchanged: the S15 tables are tenant-less; their isolation from the runtime role is tested) | |
| AC-M04-15..17 | BLOCKED (HG-04-01/02/03) | |

## I. Next-milestone handoff and open decisions
- Owner decisions: supply framework references; accept the eight collectors and their stated limits; accept the breach placeholders; spec issues SI-M04-1, -2, -5, -6, -7, -8 and the missing endpoints for the read-only screens.
- M05 supplies verified regions and registers its hooks; M08 the export sink (D-07); M12 incident tooling and the access-review collector.
