# S56 report — Scale, chaos, security assessment

Status: **PARTIAL: harnesses, drill registry, tenant sweep and the security pack are done; every run that needs staging, a vendor or a real IdP is BLOCKED / NOT RUN** · Branch `claude/m12-hardening-4cc95e` (see M12 report) · Written 2026-11-18.

## A. Repository findings and assumptions
- No staging environment exists (no deployment target; D-01 local-only git; HG-05-xx accounts pending). "Declared scale" load, chaos on real infrastructure, DAST, DR on real infrastructure are therefore **BLOCKED**, not extrapolated (M12 §2: extrapolation is not evidence).
- M09/M10/M11 are in flight on other branches: their load scenarios, sandbox-escape re-run and delegation threat models are BLOCKED / design-level.
- `apps/api/src/main.ts` is empty; the API starts only through `dev/dev-stack.ts` (found by the security pack).

## B. Plan and changed files
- `apps/api/src/ops/load/` (`runner.ts`, `scenarios.ts`, `cli.ts`, `runner.spec.ts`): open-loop load harness and the M12 §11 scenarios as data.
- `apps/api/src/modules/ops/chaos/` (`drills.ts`, `chaos-drills.spec.ts`): drill registry whose references are checked against the real test files.
- `apps/api/src/modules/tenancy/tenant-sweep.int.spec.ts`: sweep over every OpenAPI operation; output `docs/reports/evidence/M12-tenant-sweep.json`.
- `docs/reports/M12-security-assessment-pack/` (threat models ×6, ASVS L2 matrix, pen-test scope / RoE / remediation tracker, internal scans, sweep description); [M12-load-report.md](M12-load-report.md), [M12-chaos-report.md](M12-chaos-report.md).

## C. Implemented features
- Load harness: open-loop pacing (no coordinated omission), per-kind percentiles, error rate, `dropped` accounting, thresholds from D-30 (`read p95 < 300 ms`, `write p95 < 800 ms`, `error < 0.5 %`), smoke vs declared labelling, refuses production-looking hosts. Its arithmetic is tested against a local fake server (this is not a performance result).
- Chaos registry: 10 drills; 6 map to existing integration tests, 2 are NOT_BUILT (ZATCA clock skew, vault outage), 1 BLOCKED (DB failover), SSO drill added. Real-infrastructure column is NOT VERIFIED / BLOCKED for every drill.
- Tenant sweep: classifies every operation (spec-driven; a new endpoint without an access rule fails), presents org B's session / API key / SCIM token against org A, and fails on any unexplained 2xx.
- Security pack: internal self-assessment, **not independent**; pen-test scope, draft rules of engagement, severity policy with SLA proposals 7/14/30/90 days, empty tracker. The vendor test is HG-12-01 (D-28).

## D. Migrations and rollback
None.

## E. Tests run with actual results
See [M12-report.md §E](M12-report.md). Scans run by the pack author on 2026-11-18: `pnpm scan:secrets` → 1389 files, 8 rules, 0 hits; `pnpm audit --prod --audit-level=high` → exit 0; `pnpm audit --prod` → 1 moderate advisory (GHSA-8988-4f7v-96qf, `@opentelemetry/core` < 2.8.0 via `packages/telemetry`), **not yet entered in the tracker**. SAST/container/IaC/DAST: NOT RUN (no Dockerfile/IaC exists; DAST needs staging).

## F. Security, tenant isolation, billing, residency verification
Sweep result: see M12 report. ASVS L2 matrix counts (internal): PASS 114, NOT VERIFIED 97, BLOCKED 23, N/A 31 (265 rows). Deviations recorded there include `'unsafe-inline'` in the console CSP, in-memory auth rate limiting keyed by `req.ip` (no `trustProxy` setting found), no schema-validation library, no breached-password check.

## G. Human gates and live checks still needed
HG-12-01 (independent pen test + retest), staging environment for load/chaos/DAST, HG-05-xx for real provider drills, M09–M11 merge for their scenarios.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M12-06 load targets at declared scale | BLOCKED (no staging); harness NOT RUN at scale |
| AC-M12-07 chaos drills: 0 duplicate resources / lost events / duplicate webhooks / imbalance | NOT VERIFIED (asserted by existing integration tests at adapter/lease level; real infra BLOCKED) |
| AC-M12-09 tenant sweep | see M12 report (PASS only if the final run shows 0 unexplained 2xx) |
| AC-M12-10 0 open critical/high from scans | NOT VERIFIED: SAST/DAST/container not run; dependency audit shows 0 high; 1 moderate untracked |
| AC-M12-11 independent pen test | BLOCKED (HG-12-01) |

## I. Next-sprint handoff and open decisions
D-28 vendor; staging environment decision; trustProxy / rate-limit placement; CSP `unsafe-inline`.
