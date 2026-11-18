# GA readiness checklist (M12 §15; deliverable `ga-readiness-checklist.md`)

Prepared 2026-11-18 by the implementing agent. **Every status is `PENDING` and `Agent may mark` is `No` on every row.** The agent may not change any status to PASS or GRANTED; the owner records evidence and marks the row. The checklist items (columns `#`, `Item`, `Owner`, `Source`, `Status`) are copied from `docs/milestones/M12_enterprise_hardening_launch.md` §15. The columns `Agent may mark` and `Evidence known today` were added by the agent. `Evidence known today` lists only facts found in repository reports on 2026-11-18; it is a pointer for the owner, never a status, and nothing in it is a recommendation to launch. Dates are UTC.

This file does not recommend launch. The go/no-go decision belongs to the owner (HG-12-03).

## Compliance hooks checklist (M12 §15)

| # | Item | Status | Agent may mark | Evidence known today |
|---|---|---|---|---|
| [ ] H-01 | DR/backup/archive regions obey residency policy | PENDING | No | M04 residency evaluator fails closed on write paths (AC-M04-02 PASS, integration tests); M08 residency denial tests pass on dev-reference mocks (AC-M08-15); production backup sink is `none` (AC-M06-18 BLOCKED, D-07). No DR exercise recorded in any report. |
| [ ] H-02 | Retention periods set per D-34 with counsel values | PENDING | No | M04 retention policies are seeded as PROPOSAL (M04-gate-review); D-34 OPEN; counsel memo HG-04-01 not supplied (AC-M04-15 BLOCKED). |
| [ ] H-03 | Breach-notification workflow exercised (timers configured by counsel) | PENDING | No | Breach state machine tested (AC-M04-11 PASS); timers 24/48/72 h are proposals pending counsel (M04-report §A); runbooks `docs/runbooks/breach-handling.md` and `data-breach-workflow.md` exist. No exercise or tabletop is recorded in any report. |
| [ ] H-04 | DSR exercised end-to-end across all data stores | PENDING | No | Four DSR types pass as integration tests, no browser e2e (AC-M04-06); M08 records no DSR export/erase handler for messages, suppressions or objects (M08-report §H, NOT DONE). |
| [ ] H-05 | Policy versions published with effective dates | PENDING | No | Policy-version tables and API were added in M12 S55 commits `5ff23ab` and `627b83d` (subject lines); no report records a published policy version with an effective date; not verified by the author of this file. |
| [ ] H-06 | Control evidence collectors green | PENDING | No | Eight collectors exist; identical hash on re-run (AC-M04-09 PASS); limits stated in `docs/runbooks/compliance-evidence.md` (no vulnerability database, no live TLS probe). Not re-run for this checklist. See `M12-decision-package/compliance-evidence-status.md`. |
| [ ] H-07 | Regulatory validation register reviewed (statuses owner-supplied) | PENDING | No | Register is built and seeded; no row validated (AC-M04-16 BLOCKED, HG-04-02). |

## GA readiness checklist (G-01..G-38)

The source row `G-02..G-12` ("Gate Reviews M01…M11 signed (one row each)") is expanded to one row per milestone below, in order G-02 = M01 … G-12 = M11.

| # | Item | Owner | Source | Status | Agent may mark | Evidence known today |
|---|---|---|---|---|---|---|
| G-01 | HG-00-01 documentation approval | Owner | docs/07 | PENDING | No | HG-00-01 approval recorded 2026-11-15 in `docs/reports/HG-00-01-approval.md` (owner chat approval; the file says it is not a signed document and excludes PA-01..16 and legal items). Owner must still confirm in this checklist. |
| G-02 | Gate Review M01 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M01-gate-review.md`: signed by the owner from the chat decision of 2026-11-16 "Sign, defer the open rows" (a written signature is not captured); deferrals in `M01-deferrals.md` (8 rows). |
| G-03 | Gate Review M02 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M02-gate-review.md`: signed from the chat decision of 2026-11-17 with deferrals (`M02-deferrals.md`, 7 rows); no written signature captured. |
| G-04 | Gate Review M03 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M03-gate-review.md`: PREPARED, NOT SIGNED, decision "hold for owner", sign-off "pending". |
| G-05 | Gate Review M04 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M04-gate-review.md`: PREPARED, NOT SIGNED, decision "hold for owner", sign-off "pending". |
| G-06 | Gate Review M05 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M05-gate-review.md` covers the adapter half (S18-S23) only: PREPARED, NOT SIGNED, "hold for owner". No gate review file for the core half (S16/S17; `S16-report.md`, `S17-report.md`). |
| G-07 | Gate Review M06 signed | Owner | docs/03 §5 | PENDING | No | No `M06-gate-review.md` exists; `docs/reports/M06-report.md` states NOT DONE, nothing signed. |
| G-08 | Gate Review M07 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M07-gate-review.md`: DRAFT (NOT SIGNED); decision requested from the owner. |
| G-09 | Gate Review M08 signed | Owner | docs/03 §5 | PENDING | No | `docs/reports/M08-gate-review.md`: PREPARED, NOT SIGNED, "hold for owner"; milestone NOT DONE. |
| G-10 | Gate Review M09 signed | Owner | docs/03 §5 | PENDING | No | None found: no `M09-*` file in `docs/reports/` on this branch; M09 is in flight on branch `claude/m09-ai-builder-a33bbe`. |
| G-11 | Gate Review M10 signed | Owner | docs/03 §5 | PENDING | No | None found: no `M10-*` file on this branch; M10 is in flight on branch `claude/m10a-app-builder-7cee56`. |
| G-12 | Gate Review M11 signed | Owner | docs/03 §5 | PENDING | No | None found: no `M11-*` file on this branch; M11 is in flight on branch `claude/m11-automation-2a587e`. |
| G-13 | M12 Gate Review signed | Owner | this doc | PENDING | No | No `M12-gate-review.md` exists yet. M12 is in progress on branch `claude/m12-hardening-4cc95e`. |
| G-14 | HG-01-01 repo/CI · HG-01-02 IdP hosting | Owner/DevOps | docs/07 | PENDING | No | D-01 decided 2026-11-15: local git only, no remote; CI defined, never run (`M01-gate-review.md`; register BR-001). Only a dev test IdP exists (BR-002). |
| G-15 | HG-02-01 price book approved (D-23, D-25) | Finance | docs/07 | PENDING | No | `M02-report.md` AC-M02-14 BLOCKED (HG-02-01); a placeholder price book is refused in production; D-23, D-25 OPEN in docs/07. |
| G-16 | HG-03-01 VAT-registered entities (D-33) | Finance | docs/07 | PENDING | No | `M03-report.md` AC-M03-25 BLOCKED; issuing is refused outside sandbox; D-33 OPEN. |
| G-17 | HG-03-02 PSP production approval (D-10) | Finance | docs/07 | PENDING | No | `M03-report.md` AC-M03-20, AC-M03-21 BLOCKED; only `psp-mock` exists; D-10 OPEN. |
| G-18 | HG-03-03 ZATCA production CSID/onboarding (D-11) | Finance/Tax | docs/07 | PENDING | No | `M03-report.md` AC-M03-22, AC-M03-23 BLOCKED; only our own simulated server and a synthetic profile (AC-M03-08 NOT VERIFIED vs ZATCA); D-11 OPEN. |
| G-19 | HG-03-04 tax advisor sign-off (incl. D-24 reseller treatment) | Tax advisor | docs/07 | PENDING | No | `M03-report.md` AC-M03-24 BLOCKED; 14-question list in `M03-report.md` §G; D-24 OPEN. |
| G-20 | HG-04-01 counsel memo (D-14, D-16, D-17, D-34) | Legal | docs/07 | PENDING | No | `M04-report.md` AC-M04-15 BLOCKED; all legal values in `spec/compliance/*.yaml` are proposals; D-14, D-16, D-17, D-34 OPEN. |
| G-21 | HG-04-02 NCA/CST applicability + filings | Legal/Security | docs/07 | PENDING | No | `M04-report.md` AC-M04-16 BLOCKED; register built, no row validated; framework references empty (`docs/runbooks/compliance-evidence.md`). |
| G-22 | HG-04-03 third-party assessments/certifications | Security | docs/07 | PENDING | No | `M04-report.md` AC-M04-17 BLOCKED; not producible by the agent. No certificate or assessment report exists in the repository. |
| G-23 | PDPL obligations validated (DPO, ROPA, transfers, DSR) | Legal | M04 register | PENDING | No | Engineering evidence only: ROPA coverage check, DSR integration tests, residency matrix 72/72 (M04-report §H AC-M04-04, -06, -01). No legal validation or DPO appointment recorded (D-16 OPEN). |
| G-24 | HG-05-01 Alibaba · HG-05-02 Huawei · HG-05-03 Contabo accounts + verified regions/capabilities | Owner | docs/07 | PENDING | No | No accounts or credentials exist (`M05-report.md`). Verified-region reports were generated with no account: `docs/reports/evidence/M05/verified-region-report-{alibaba,huawei,contabo}-none-2026-11-18.md`, all NOT VERIFIED; AC-M05-15..19 BLOCKED. |
| G-25 | HG-05-04 provider quotas/spend caps | Owner | docs/07 | PENDING | No | `M05-gate-review.md` lists HG-05-04 as BLOCKED. |
| G-26 | HG-06-01 CloudPanel licensing/nodes (D-20 outcome) | Owner | docs/07 | PENDING | No | `M06-report.md` AC-M06-17 BLOCKED (ADR-020 Proposed); licence terms question unanswered (§A); no real node exists. |
| G-27 | HG-07-01 registrar accounts · HG-07-02 `.sa` route (D-19) | Owner/Legal | docs/07 | PENDING | No | `M07-report.md` AC-M07-12, -13 BLOCKED; mock registrars only; Saudi TLDs blocked by policy. |
| G-28 | HG-08-01 data/email providers contracted (D-05..D-09) | Owner | docs/07 | PENDING | No | `M08-gate-review.md`: ADR-050..054 PROPOSED, none accepted; AC-M08-10..14 BLOCKED; no service enabled in production. |
| G-29 | HG-09-01 model provider contracts (D-18) | Owner | docs/07 | PENDING | No | None found in repository reports on this branch (M09 in flight on another branch); D-18 OPEN. |
| G-30 | HG-10-01 store accounts/signing/macOS (D-22) · HG-10-02 sandbox security review (D-21) | Owner/Security | docs/07 | PENDING | No | None found on this branch (M10 in flight). `M12-security-assessment-pack/threat-model-sandbox.md` is design-level only (`DESIGNED, NOT VERIFIED`); D-21, D-22 OPEN. |
| G-31 | HG-11-01 marketplace terms/payout route (D-26) | Legal | docs/07 | PENDING | No | None found on this branch (M11 in flight); D-26 OPEN. |
| G-32 | HG-12-01 independent pen test + retest (D-28) | Owner | docs/07 | PENDING | No | D-28 OPEN; no vendor selected. Prepared by the agent: `pen-test-scope.md`, `pen-test-rules-of-engagement.md` (DRAFT), `pen-test-remediation-tracker.md` (empty) under `docs/reports/M12-security-assessment-pack/`. The pack labels itself INTERNAL, not independent. |
| G-33 | HG-12-02 SSO tenants · D-27 scope | Owner | docs/07 | PENDING | No | Local SAML test IdP and S55 enterprise code are in git history (`ed88bbd`, `627b83d`); real-IdP verification BLOCKED (AC-M12-02); D-27 OPEN. |
| G-34 | HG-12-03 training, runbook acceptance, on-call roster (D-29), go/no-go | Owner | docs/07 | PENDING | No | Drafts only under `docs/reports/M12-handover/` (training agenda, on-call roster template, escalation matrix, runbook index, support playbooks, hypercare plan, communications drafts). Training not delivered, runbooks not accepted, roster not filled; D-29 OPEN. |
| G-35 | Remaining OPEN decisions D-01…D-34 closed or explicitly deferred | Owner | docs/07 | PENDING | No | `docs/07` records D-01, D-02, D-30, D-32 as DECIDED (2026-11-15). The OPEN list is in `blocked-register.md` Appendix A (docs/07 also defines D-35 and D-36, both OPEN). |
| G-36 | `blocked-register.md` fully dispositioned | Owner | AC-M12-17 | PENDING | No | `docs/reports/blocked-register.md` written 2026-11-18: 124 rows (57 BLOCKED, 52 NOT VERIFIED, 15 DEFERRED), all `PENDING owner`; 0 dispositioned. M09-M11 rows not yet added. |
| G-37 | No open critical/high defects (tracker export attached) | Owner | AC-M12-10/11 | PENDING | No | Gate reviews M01-M05 and M08 each state "none known" for critical/high defects (agent statements, not a tracker export). Tracker `pen-test-remediation-tracker.md` is empty; `internal-scans.md` records one moderate dependency advisory and notes SAST not run, DAST BLOCKED. No tracker export exists. See `M12-decision-package/open-defects.md`. |
| G-38 | DR and reconciliation evidence accepted | Owner/Finance | AC-M12-08/12/13 | PENDING | No | No live DR, load, chaos or reconciliation evidence exists. RC-01..06 pass on fixtures in M03 (AC-M03-10, sandbox/simulated data). M12 reports are listed in `M12-decision-package/evidence-index.md`; staging does not exist (security pack README). |

## Note for the owner

Rows G-02..G-13 and the milestone gates map to the "every earlier BLOCKED/NOT VERIFIED row dispositioned" gate condition through G-36. The agent has not converted any BLOCKED or NOT VERIFIED row, has not marked any HG, D or GA item granted or passed, and does not recommend launch.
