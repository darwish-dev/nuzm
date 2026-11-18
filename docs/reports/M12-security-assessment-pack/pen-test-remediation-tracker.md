# Remediation tracker and severity policy

> INTERNAL, prepared 2026-11-18. The SLA numbers are **PROPOSALS** (from `docs/milestones/M12_enterprise_hardening_launch.md` §4 S56) awaiting owner approval. The independent pen test is HG-12-01 (D-28), BLOCKED/PENDING; critical and high findings cannot be closed without the vendor's retest.

The tracker below is **empty on purpose**. No finding has been fabricated. Findings from internal scans, DAST and the vendor are recorded here as they occur (an open dependency advisory noted in [internal-scans.md](internal-scans.md) is awaiting entry by the owner/parent).

## 1. Severity policy (SLA proposals)

| Severity | Typical criteria (proposal) | Fix SLA (PROPOSAL) | Gate effect |
|---|---|---|---|
| Critical | Remote compromise of the platform or a cross-tenant breach of confidentiality/integrity at scale; authentication bypass; forged SSO assertion accepted; ledger or e-invoice integrity breach; sandbox/hosting escape to host or control plane; exposure of platform secrets | **7 days** | Blocks GA until fixed **and vendor-retested** |
| High | Cross-tenant access limited in scope or needing an unlikely precondition; privilege escalation within an org; significant sensitive-data exposure; bypass of MFA/step-up; SSRF reaching internal services | **14 days** | Blocks GA until fixed **and vendor-retested** |
| Medium | Limited-impact flaw, defence-in-depth gap with a plausible exploit path, missing rate limit on a sensitive operation, information leakage without direct data compromise | **30 days** | Fix or owner-accepted risk before GA; internal retest with evidence |
| Low | Hardening, best-practice deviation, minor leakage, no realistic exploit path | **90 days** | Tracked; owner may accept with rationale |
| Informational | Observation with no security impact | none | Optional |

Rules (proposals):

- The SLA clock starts when the finding is **confirmed** (reproduced by Nuzm or accepted from the vendor), not when it is first reported. Due date = confirmed date + SLA.
- Severity is assigned by the security lead against the criteria above; a vendor-assigned severity is kept alongside and any difference is noted. A CVSS vector may be recorded as supporting data only.
- A finding past its SLA is flagged in the weekly review and listed in the go/no-go package as overdue.
- **Risk acceptance** of anything critical or high is not available to the agent; only the owner can accept, in writing, with rationale and expiry, and it does not satisfy AC-M12-10/11.
- The agent does not mark a finding `fixed-verified` without evidence (commit, test, retest output). Vendor retest results are copied from the vendor's letter, never inferred.
- Duplicate findings are linked to one ID.

## 2. Status values

`new` (not yet confirmed) · `confirmed` · `in-progress` · `fixed-pending-retest` · `fixed-verified` (retest passed, evidence linked) · `risk-accepted` (owner sign-off, not for critical/high gate purposes) · `false-positive` (reason recorded) · `wont-fix` (owner sign-off).

## 3. Tracker (template, no findings)

| ID | Source (internal scan / DAST / vendor) | Severity | Component | Finding | Status | Owner | Found | SLA due | Fixed in commit | Retest result | Retest date | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (none recorded) | | | | | | | | | | | | |

Column notes: **ID** `PT-001...` for vendor, `INT-001...` for internal scans, `DAST-001...` for DAST. **Source** exactly one of `internal scan`, `DAST`, `vendor`. **Component** module or asset (e.g. `identity`, `hosting node agent`, `apps/admin`). **Fixed in commit** is the SHA on the main line, plus the regression test name. **Retest result** `pass` / `fail` / `partial`, from the vendor for critical/high. **Evidence** link to the report section, test output or retest letter.

## 4. Retest process

1. Developer fixes the finding on a branch with a regression test that fails before and passes after; commit message references the tracker ID.
2. The security lead reviews the fix and sets `fixed-pending-retest` with the commit SHA.
3. **Critical and high:** the owner sends the finding to the vendor for retest (HG-12-01). The vendor retests against staging at a version containing the fix and issues a retest letter listing each finding ID and result. Only a `pass` in that letter moves the finding to `fixed-verified`. A `fail` or `partial` returns it to `in-progress` and the SLA clock continues from the original due date (it does not restart).
4. **Medium and low:** retest internally by re-running the original reproduction and the related scan or test; record command, date, commit and output as evidence. Vendor spot-check is optional.
5. After all retests, re-run the internal scans and the tenant sweep ([internal-scans.md](internal-scans.md), [tenant-isolation-sweep.md](tenant-isolation-sweep.md)) to catch regressions, and update the ASVS matrix rows affected.
6. The gate view (for the go/no-go package, HG-12-03): counts of open findings by severity, overdue findings, findings awaiting vendor retest, accepted risks with owner and expiry.

## 5. Gate rules (from M12)

| Row | Rule | Status |
|---|---|---|
| AC-M12-10 | 0 open critical/high from SAST/DAST/dependency/container scans | NOT VERIFIED (SAST not run, DAST BLOCKED; see `internal-scans.md`) |
| AC-M12-11 | Independent pen test completed, all critical/high fixed and retested by the vendor | BLOCKED (HG-12-01 / D-28) |

The agent prepares and tracks; the vendor performs; the owner decides (HG-12-03). Nothing in this file is a recommendation to launch.
