# Evidence index (M12 decision package): reconciliation, DR, load, chaos, security, compliance

Prepared by the agent 2026-11-18. Each row lists a file or code path that **exists in this worktree** (checked with `ls`) and an honest status per category. A file existing is not evidence that a control works live. Live evidence is owner-recorded and is labelled `LIVE-VERIFIED` only with evidence (CLAUDE.md §5); fixtures, mocks and simulators never support that label. This index contains no recommendation to launch.

Note: `docs/reports/evidence-index.md` (the older M05 index, EV-M05-A01..A07) is a different file. This file is the M12 decision-package index.

## Category status summary

| Category | Status on 2026-11-18 | Basis |
|---|---|---|
| Reconciliation, fixtures (RC-01..06 financial) | PASS on fixtures for M03 (AC-M03-10); M12 re-run NOT VERIFIED until the parent's report exists | `S12a-report.md`, `M03-report.md` §H |
| Reconciliation, technical (TR-01..04) | NOT VERIFIED: code and tests exist; the parent's report is pending; TR-02 hosting reconciler not built (BR-076) | `apps/api/src/modules/ops/technical-reconciliation.service.ts` |
| Reconciliation, live provider/PSP data | BLOCKED (HG-05-01..03, HG-07-01, HG-03-02) | `blocked-register.md` BR-019, BR-033, BR-041, BR-061, BR-116 |
| DR / restore | NOT VERIFIED (runbooks drafted, no exercise recorded); at-scale DR on staging BLOCKED (no staging, D-15) | `docs/runbooks/dr-restore.md`; BR-008, BR-069, BR-122 |
| Load | NOT VERIFIED (harness code exists; no run recorded in any report); at-scale run BLOCKED (no staging) | `apps/api/src/ops/load/`; DEF-M01-07, DEF-M02-02 deferred |
| Chaos / failure drills | NOT VERIFIED (drill registry and spec exist; no report); at-scale BLOCKED | `apps/api/src/modules/ops/chaos/` |
| Security, internal | NOT VERIFIED / PARTIAL: secret scan and production dependency audit run once; SAST not run; DAST BLOCKED | `M12-security-assessment-pack/internal-scans.md` |
| Security, independent pen test | BLOCKED (HG-12-01, D-28) | `pen-test-*.md` |
| Compliance control evidence | Engineering collectors exist; owner-supplied rows BLOCKED (HG-04-01..03) | `compliance-evidence-status.md` |
| Provider live evidence (compute, registrar, data, email) | BLOCKED / NOT VERIFIED: no real accounts | `docs/reports/evidence/M05/`, `M06/`, `M08/` |
| Enterprise SSO/SCIM | NOT VERIFIED against real IdPs (AC-M12-02 BLOCKED, HG-12-02); local tests only | `apps/api/src/modules/enterprise/*.int.spec.ts` |

## Reports written by the parent session (will exist; not present when this index was written)

| File | Purpose | Exists today |
|---|---|---|
| `docs/reports/M12-report.md` | Milestone report (CLAUDE.md §10), regression commands and results | Not yet |
| `docs/reports/M12-load-report.md` | Load results (AC-M12-06) | Not yet |
| `docs/reports/M12-chaos-report.md` | Chaos drill results (AC-M12-07) | Not yet |
| `docs/reports/M12-dr-report.md` | DR exercise results (AC-M12-08) | Not yet |
| `docs/reports/M12-reconciliation-report.md` | RC-01..06 and TR-01..04 results (AC-M12-12/13) | Not yet |
| `docs/reports/M12-metering-coverage.md` | Metering coverage matrix (AC-M12-15) | Not yet |

Until those files exist the corresponding rows are not evidenced. Whatever they report, results from fixtures, mocks, local services or a reduced scale stay labelled as such; "extrapolation is not accepted as evidence" (M12 §2).

## Reconciliation evidence

| Item | Path | Status |
|---|---|---|
| Financial reconciliation fixtures RC-01..06 (M03) | `docs/reports/S12a-report.md`; `docs/reports/M03-report.md` §H AC-M03-10 | PASS on sandbox/simulated data; RC-04 bills skipped |
| Runbook: reconciliation | `docs/runbooks/reconciliation.md` | Draft |
| Runbook: break handling | `docs/runbooks/reconciliation-break-handling.md` | Draft |
| Runbook: variance (M12) | `docs/runbooks/reconciliation-variance.md` | Draft, not exercised |
| Runbook: billing close (M12) | `docs/runbooks/billing-close.md` | Draft, not exercised |
| Provider cost capture and RC-04 | `docs/runbooks/provider-cost-capture.md`; `docs/reports/evidence/M05/` | Fixture only; real bills BLOCKED |
| TR-01..04 service and tests | `apps/api/src/modules/ops/technical-reconciliation.service.ts`; `apps/api/src/modules/ops/ops.int.spec.ts` | Present in working tree; results are the parent's to report |
| Variance thresholds | `docs/07` D-31 | OPEN |

## DR evidence

| Item | Path | Status |
|---|---|---|
| Recovery exercise store | `packages/db/migrations/ops/1740__ops__incidents_alerts_dr_slo_launch.sql` (`ops.recovery_exercises`); `apps/api/src/modules/ops/recovery-exercises.service.ts` | Schema and service exist; no exercise row recorded in any report |
| Runbooks | `docs/runbooks/dr-restore.md` (M12), `db-failover.md` (M12), `db-restore.md`, `restore-db-from-dump.md`, `site-recovery.md`, `drain-and-migrate.md` | Drafts; M01 notes restore and break-glass NOT VERIFIED |
| Targets | `docs/07` D-30 decided 2026-11-15: 99.9 %, RPO 15 min, RTO 4 h | Targets, not measurements |
| Restore time budget for hosting | `docs/reports/M06-report.md` AC-M06-06 | NOT MEASURED |

## Load evidence

| Item | Path | Status |
|---|---|---|
| Harness, scenarios, CLI | `apps/api/src/ops/load/runner.ts`, `scenarios.ts`, `cli.ts`, `runner.spec.ts` | Code exists; no run result recorded in any report |
| Deferred earlier load items | `M01-deferrals.md` DEF-M01-07; `M02-deferrals.md` DEF-M02-02, DEF-M02-07; M07 AC-M07-09 NOT RUN | DEFERRED / NOT RUN |

## Chaos evidence

| Item | Path | Status |
|---|---|---|
| Drill registry and spec | `apps/api/src/modules/ops/chaos/drills.ts`, `chaos-drills.spec.ts` | Code exists; no report |
| Earlier randomized fault evidence (mock providers) | `docs/reports/evidence/M05/random-fault-runs.json`; `docs/reports/evidence/M06/capacity-fuzz.json` | Mock evidence, NOT VERIFIED live |

## Security evidence (internal; not independent)

| Item | Path |
|---|---|
| Pack index and ground rules | `docs/reports/M12-security-assessment-pack/README.md` |
| Threat models | `threat-model-control-plane.md`, `threat-model-shared-hosting.md`, `threat-model-sandbox.md`, `threat-model-delegation.md`, `threat-model-payments-zatca.md`, `threat-model-enterprise-sso-scim.md` (same directory) |
| ASVS 4.0.3 L2 self-assessment | `asvs-l2-matrix.md` |
| Tenant-isolation sweep (description; result is the parent's) | `tenant-isolation-sweep.md`; `apps/api/src/modules/tenancy/tenant-sweep.int.spec.ts` |
| Internal scans, with exact commands and results | `internal-scans.md` (secret scan: 1389 files, 0 hits; `pnpm audit --prod --audit-level=high` exit 0; one moderate advisory) |
| Pen-test scope, rules of engagement (DRAFT), tracker (empty) | `pen-test-scope.md`, `pen-test-rules-of-engagement.md`, `pen-test-remediation-tracker.md` |
| Enterprise SSO/SCIM and audit assurance tests | `apps/api/src/modules/enterprise/enterprise.int.spec.ts`, `audit-assurance.int.spec.ts` |

## Compliance evidence

| Item | Path |
|---|---|
| Collector runbook | `docs/runbooks/compliance-evidence.md` |
| Control catalog | `spec/compliance/controls.yaml` |
| M04 report and gate review | `docs/reports/M04-report.md`, `M04-gate-review.md`; sprint reports `S13c-report.md`, `S14a-report.md`, `S15-report.md` |
| Compliance runbooks | `docs/runbooks/dsr-handling.md`, `legal-hold.md`, `retention-archival.md`, `field-encryption.md`, `breach-handling.md`, `data-breach-workflow.md`, `residency-hooks.md` |
| Status of owner-supplied rows | [compliance-evidence-status.md](compliance-evidence-status.md) |

## Provider and domain evidence (fixtures; none live)

| Item | Path | Label |
|---|---|---|
| Compute conformance (mock, Alibaba, Huawei, Contabo) | `docs/reports/evidence/M05/{mock-compute,alibaba-ecs,huawei-ecs,contabo-vps}-conformance.json` | NOT VERIFIED (fixtures) |
| Verified-region reports (no account) | `docs/reports/evidence/M05/verified-region-report-{alibaba,huawei,contabo}-none-2026-11-18.{json,md}` | NOT VERIFIED |
| CloudPanel spike and isolation | `docs/reports/evidence/M06/cloudpanel-spike-findings.md`, `isolation-test-report.md`, `capacity-fuzz.json` | Documentation analysis; mock |
| Managed data/email conformance | `docs/reports/evidence/M08/mock-conformance.json`, `README.md` | Dev-reference only |
| Older M05 evidence index | `docs/reports/evidence-index.md` | See file |

## M12 runbooks (all drafts; none executed in a drill or tabletop)

`docs/runbooks/`: `incident-response.md`, `provider-outage.md`, `db-failover.md`, `queue-recovery.md`, `webhook-storm.md`, `reconciliation-variance.md`, `billing-close.md`, `zatca-backlog.md`, `psp-outage.md`, `sandbox-escape-suspected.md`, `data-breach-workflow.md`, `dr-restore.md`, `sso-lockout.md`, `scim-failure.md`, `abuse-takedown.md`, `access-review-process.md` (16 files; AC-M12-18 requires each to be executed once in a drill or tabletop with notes; none is recorded). Index: [../M12-handover/runbook-index.md](../M12-handover/runbook-index.md).

## Screenshots and samples

`docs/reports/screenshots/` (`ar`, `en`); `docs/reports/samples/` (Arabic and English invoice PDFs; owner visual approval pending, BR-029). AC-M12-22 (M12 screens in AR-RTL + EN, four states, axe) is not evidenced here.
