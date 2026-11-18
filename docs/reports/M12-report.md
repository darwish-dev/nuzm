# M12 report — Enterprise, Hardening & Launch (S55–S57 started; S58 BLOCKED)

Status: **IN PROGRESS / NOT DONE.** Branch `claude/m12-hardening-4cc95e` cut from main `676df74` · Written 2026-11-18 · Prepared by the implementing agent; **no launch recommendation is made** (HG-12-03).

> **Owner-granted exception recorded.** M12's precondition is "M12 is not started on unsigned gates; mocked-interface work only if the owner records an exception". On 2026-11-18 the owner explicitly granted an exception, in conversation, to start M12 in parallel with M09, M10 and M11, which are **in flight on other branches** and not in this tree. Every row that depends on them is **NOT VERIFIED or BLOCKED, never PASS through a mock**. Gate reviews M01–M08 are prepared but not all signed (see [blocked-register.md](blocked-register.md)).

## A. Repository findings and assumptions
- Stack and rules per CLAUDE.md. Migration numbering: 1700 is taken (`identity.credentials`, owner's customer sign-in); M12 uses 1710/1720/1730/1740/1750 — **manifest item for the owner**.
- Conflicts and manifest additions: [M12-spec-change-requests.md](M12-spec-change-requests.md) (SCR-M12-01..09 and 7 recorded conflicts, incl. TR storage and audit-action naming).
- Environment: Postgres `NUZM_PGPORT=54354` (project-local cluster in the worktree); Redis not used (queue is PostgreSQL); the browser E2E was **not run** (ports held by the owner's dev servers).
- Machine load from sibling sessions made runs slow; invoice-PDF tests need a Chrome binary that is absent here (see E).

## B. Plan and changed files
S55 enterprise IAM · S56 load/chaos/security · S57 reconciliation/DR/observability · S58 structure only. Per-sprint lists: [S55](S55-report.md), [S56](S56-report.md), [S57](S57-report.md), [S58 stub](S58-report.md). New dependencies: `xml-crypto@6.4.0`, `@xmldom/xmldom@0.9.x` (lockfile regenerated).

## C. Implemented features, API and UI screens
- API: 8 approved §2.12 route groups implemented (sso-connections, `/scim/v2/*`, access-reviews, operations/health, incidents, alerts, provider-incidents, recovery-exercises, policy-versions, audit-retention). OpenAPI + SDK regenerated; 314 operations declared and implemented.
- UI: see the UI section below (UI-M12-02, -03, -15 deliberately NOT built; no e2e or screenshots could be produced).
- NOT built (BLOCKED on owner approval): SSO sign-in endpoints (SCR-M12-05), SCIM token endpoint (SCR-M12-01), org security policy (SCR-M12-02), launch-gate / SLO endpoints (SCR-M12-03), item-level access reviews (SCR-M12-04), audit export/integrity routes (SCR-M12-07).

## D. Migrations and rollback
1710 identity SSO/SCIM · 1720 audit access reviews · 1730 compliance policy versions · 1740 ops schema (+ seeds, permissions) · 1750 cloud TR subjects. Each has a dev/staging-only `.down.sql`; production forward-fix; features off by default (`enterprise.sso`, `enterprise.scim`; scheduler `OPS_SCHEDULER_INTERVAL_SECONDS=0`).

## E. Tests run with actual results
Environment: `NUZM_PGPORT=54354`, `NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54354/postgres`. Final commands and results are in the table appended by the closing step below ("Verification log").

## F. Security, tenant isolation, billing, residency verification
- **Tenant sweep (AC-M12-09)** `tenant-sweep.int.spec.ts`, output `docs/reports/evidence/M12-tenant-sweep.json`: 314 operations classified (org 162, admin 112, scim 12, session-self 15, service-key 1, public 12); 440 cross-tenant requests exercised; 406 refused (401/403/404), 34 explained 2xx (SCIM discovery/list/create in the token's own org, plus classified-not-crossed), **0 unexplained 2xx**. Also the pre-existing `cross-tenant.int.spec.ts` (324 cases) passes except one environmental failure (invoice PDF needs Chrome: 503, not an isolation result).
- Internal security assessment: [M12-security-assessment-pack](M12-security-assessment-pack/README.md) — **internal, not independent**.
- Billing/metering: **AC-M12-15 FAIL**: [M12-metering-coverage.md](M12-metering-coverage.md) finds 0 of 31 meters fully covered (23 FAIL, 8 BLOCKED for M09–M11). Main gaps: no producer for `network.egress_gb` and `compute.snapshot_gb_months`, compute bill source not registered for RC-04, per-meter rating/invoice fixtures exist for 3–4 meters. Not remediated here.
- Residency: no new region-bearing resource; DR/archive residency NOT VERIFIED (no backup target).

## G. Human gates and live checks still needed
HG-12-01 (pen test), HG-12-02 (SSO tenants), HG-12-03 (training, runbooks, on-call, go/no-go), HG-04-01..03, HG-03-02..04, HG-05-01..04, HG-06-01, HG-07-01/02, HG-08-01, HG-09-01, HG-10-01/02, HG-11-01; D-27..D-31, D-34; staging environment; SCR approvals.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| AC-M12-01 SAML/OIDC negatives rejected, positives accepted (local IdPs) | PASS (library level, local test IdP) | `saml.spec.ts` 37, `enterprise-oidc.spec.ts` 8; wired flow BLOCKED (SCR-M12-05) |
| AC-M12-02 real IdP per protocol | BLOCKED (HG-12-02) | — |
| AC-M12-03 SCIM conformance, deprovision ≤ 60 s | PASS (own suite; in-process latency) | `enterprise.int.spec.ts` |
| AC-M12-04 access review end to end, 0 residual | PASS (members/keys/sessions); delegated access NOT VERIFIED (M11) | `enterprise.int.spec.ts` |
| AC-M12-05 chain verification, tamper, hold | PASS (verification, tamper, hold-aware dry run); archival DEFERRED (ADR-055) | `audit-assurance.int.spec.ts` |
| AC-M12-06 load at declared scale | BLOCKED | [M12-load-report.md](M12-load-report.md) |
| AC-M12-07 chaos drills | NOT VERIFIED | [M12-chaos-report.md](M12-chaos-report.md) |
| AC-M12-08 DR RPO/RTO | NOT VERIFIED (one LOCAL drill only) | [M12-dr-report.md](M12-dr-report.md) |
| AC-M12-09 tenant sweep | PASS | see F |
| AC-M12-10 0 open critical/high from SAST/DAST/dependency/container | NOT VERIFIED | SAST/DAST/container not run; 1 moderate dependency advisory untracked |
| AC-M12-11 independent pen test | BLOCKED (HG-12-01) | — |
| AC-M12-12 RC/TR fixtures | PASS (fixtures; TR-04 injection test missing) | [M12-reconciliation-report.md](M12-reconciliation-report.md) |
| AC-M12-13 live reconciliation | BLOCKED | HG-05-xx, HG-07-01, HG-03-02 |
| AC-M12-14 ZATCA production | BLOCKED | HG-03-03 |
| AC-M12-15 metering coverage | **FAIL** | [M12-metering-coverage.md](M12-metering-coverage.md) |
| AC-M12-16 full regression | BLOCKED (S58, M09–M11) | not run |
| AC-M12-17 blocked register dispositioned | FAIL (0 of 124 rows dispositioned; owner action) | [blocked-register.md](blocked-register.md) |
| AC-M12-18 runbooks each executed once | NOT VERIFIED | 15 runbooks written, all NOT EXERCISED |
| AC-M12-19 compliance evidence report | BLOCKED (HG-04-01..03) | [decision package](M12-decision-package/compliance-evidence-status.md) |
| AC-M12-20 training delivered | BLOCKED (HG-12-03) | — |
| AC-M12-21 go/no-go recorded | BLOCKED (HG-12-03) | — |
| AC-M12-22 screens AR/EN + screenshots + axe | NOT VERIFIED (screens written; e2e/screenshots NOT RUN) | UI section |

## I. Next-milestone handoff and open decisions
After M09–M11 gates exist: merge, regenerate SDK/lockfile, run S58 (full regression, documentation freeze, decision package). Owner decisions: SCR-M12-01..09, manifest additions (4 tables + `cloud` extension + migration numbering), D-27/D-29/D-30/D-31/D-34, ADR-055, staging environment, vendor for the pen test (D-28), trustProxy / rate-limit placement, metering gaps (egress, snapshots, RC-04 compute bill source).
