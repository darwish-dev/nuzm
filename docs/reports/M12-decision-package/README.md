# M12 go/no-go decision package (S58) — index

> **Prepared by the agent. It contains NO recommendation to launch. The go/no-go decision belongs to the owner (HG-12-03).**

Prepared 2026-11-18 on branch `claude/m12-hardening-4cc95e`. This package is the structure required by `docs/milestones/M12_enterprise_hardening_launch.md` §12 ("decision package"). It presents what exists, what is missing and what only a human can supply. It states PASS / FAIL / BLOCKED / NOT VERIFIED / DEFERRED honestly (CLAUDE.md §6) and uses `PENDING` only for checklist rows. Nothing here marks any human gate (HG-xx), decision (D-xx) or GA checklist row (G-xx) as granted or passed.

## Position in one paragraph (facts only)

The GA readiness checklist has 38 rows plus 7 compliance-hook rows; all are `PENDING` and the agent may mark none. The blocked register lists 124 BLOCKED / NOT VERIFIED / DEFERRED rows for M01-M08 and M12 (57 / 52 / 15); none is dispositioned, so AC-M12-17 is not met. M09, M10 and M11 gate reviews do not exist on this branch. No real provider, PSP, ZATCA, registrar, IdP or pen-test evidence exists; there is no staging environment. Which of these rows are critical-path is an owner call.

## Contents

| File | What it is | Status of the content |
|---|---|---|
| [../ga-readiness-checklist.md](../ga-readiness-checklist.md) | M12 §15 compliance-hook and GA readiness checklists (G-01..G-38) with "evidence known today" | All PENDING; agent may mark: No |
| [../blocked-register.md](../blocked-register.md) | Every BLOCKED / NOT VERIFIED / DEFERRED row across M01-M08 and known M12 rows (AC-M12-17) | 124 rows, all UNDISPOSITIONED; M09-M11 placeholders |
| [risk-register.md](risk-register.md) | Risks drawn from the register, the security pack and open decisions | Ratings are PROPOSED by the agent; owner to confirm |
| [open-defects.md](open-defects.md) | Known defects and limitations recorded in M01-M08 reports and gate reviews; empty tracker-export section | Severity "to be rated by owner" unless a report states one |
| [evidence-index.md](evidence-index.md) | Index of reconciliation, DR, load, chaos, security, compliance and provider evidence files | Live evidence NOT VERIFIED or BLOCKED |
| [compliance-evidence-status.md](compliance-evidence-status.md) | What the control-evidence collectors produce; which rows only the owner can supply | Owner-supplied rows cannot be attested by the agent |
| [cost-model-vs-actual.md](cost-model-vs-actual.md) | Cost model and where provider costs are captured; no real bills exist | RC-04 live = BLOCKED |
| [support-readiness.md](support-readiness.md) | Support readiness fields | HUMAN-COMPLETED: pending HG-12-03 |
| [rollback-hotfix-plan.md](rollback-hotfix-plan.md) | Rollback, flag-off and hotfix process | PROPOSAL |
| [../M12-handover/communications-drafts.md](../M12-handover/communications-drafts.md) | Communications drafts (not duplicated here) | DRAFT, NOT VERIFIED, not approved |

Related deliverables written elsewhere in S55-S58 (existing files only are linked; the parent session writes the rest, see `evidence-index.md`):

| Item | Path | Exists on 2026-11-18 |
|---|---|---|
| Security assessment pack | [../M12-security-assessment-pack/README.md](../M12-security-assessment-pack/README.md) | Yes (INTERNAL, not independent) |
| Handover pack | `docs/reports/M12-handover/` (9 files, see [../M12-handover/runbook-index.md](../M12-handover/runbook-index.md)) | Yes (drafts) |
| M12 spec change requests | [../M12-spec-change-requests.md](../M12-spec-change-requests.md) | Yes (nothing implemented under SCR) |
| M12 runbooks | `docs/runbooks/` (16 M12 runbooks listed in `evidence-index.md`) | Yes (drafts, none exercised) |
| `M12-report.md`, `M12-load-report.md`, `M12-chaos-report.md`, `M12-dr-report.md`, `M12-reconciliation-report.md`, `M12-metering-coverage.md` | `docs/reports/` | Not yet; written by the parent session |

## Acceptance rows that are still open (from the M12 prompt §13)

Status in this table is the prompt's own default or the evidence known to the author; the parent session's reports may update the PENDING rows. The agent does not convert any of them.

| Row | Status on 2026-11-18 | Why |
|---|---|---|
| AC-M12-02, -11, -13, -14, -19, -20, -21 | BLOCKED-until-evidence | HG-12-02, HG-12-01, HG-05-xx/HG-07-01/HG-03-02, HG-03-03, HG-04-01..03, HG-12-03 |
| AC-M12-10 | NOT VERIFIED | SAST not selected or run; DAST BLOCKED (no staging) |
| AC-M12-17 | UNDISPOSITIONED | 124 register rows await the owner; M09-M11 rows not yet added |
| AC-M12-01, -03..-09, -12, -15, -16, -18, -22 | PENDING | Evidence is produced by the parent session's runs (reports listed above); not asserted here |

## Reading order for the owner

1. `../ga-readiness-checklist.md` (what must be recorded) and `../blocked-register.md` (what is open and who owns it).
2. `risk-register.md` and `open-defects.md`.
3. `evidence-index.md` and `compliance-evidence-status.md`.
4. `cost-model-vs-actual.md`, `support-readiness.md`, `rollback-hotfix-plan.md`, communications drafts.

The decision itself is recorded by the owner, in writing, in the system of record the owner designates (HG-12-03). The `ops.launch_gates` table seeds G-01..G-38 as PENDING and its database constraint refuses a PASS without a human decider and evidence (`M12-spec-change-requests.md`, SCR-M12-03); the agent does not write decisions.
