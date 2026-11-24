# REPORT-07 — Session 07 (QA, Security, Compliance)

| Field | Value |
|---|---|
| Session | 07, independent QA / security / compliance |
| Branch | `feature/ai-qa-security` |
| Worktree | `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-qa-security` |
| Baseline commit | `f81872d5` (branch cut from `9d16e7f3`, the parallel-plan commit) |
| Postgres | own cluster, port 54347 (not started yet: see "Test commands") |
| Migrations used | none (reserve 2000-2019 untouched) |
| Contract-change requests | none |
| Delivery completion | see section "Completion" at the end (updated at every checkpoint) |

## Assigned scope (SESSION-07.md)
Static/security review of the existing AI, gateway, sandbox and deploy code; threat model of the new ports (`ExecutionPort`, `BuildPort`, `DeploymentPort`, `ArtifactRef`); targeted tests in my own paths only (`apps/api/src/qa/qa-*.int.spec.ts`, `e2e/tests/**`, `e2e/tests/fixtures/qa-*.ts`); finish the skipped `08-compute-customer` mock-catalog E2E; re-verify the 10b viewer-forbidden scenario; verify Session 06's deployment coverage; DEFECT reports to owning sessions; `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`; audit other sessions after the Master merges.

## Rules I am working under
No live provider call, no real credential, no customer data, no real execution; 4 CPU / 8 GB shared: targeted tests only, no full integration/E2E, no console rebuild. Heavy runs are requests to the Master (see "Heavy-run requests"). Evidence labels: PASS only for what I ran and saw; offline policy/mocks are never "verified" for the real thing.

## Completed (checkpoint 1)
| Task | Result | Evidence |
|---|---|---|
| Execution Gateway policy adversarial suite (79 cases) | PASS (74 pass + 5 expected-fail documenting DEFECT-1) | `npx vitest run --config vitest.integration.config.mts src/qa/qa-exec-gateway.int.spec.ts` in `apps/api`: `74 passed | 5 expected fail` |
| SSRF fetcher + sandbox egress adversarial suite (187 cases) | PASS (177 pass + 10 expected-fail documenting DEFECT-2, DEFECT-3) | same command, `src/qa/qa-ssrf-egress.int.spec.ts`: `177 passed | 10 expected fail` |
| DEFECT-1, DEFECT-2, DEFECT-3 written | done | `docs/parallel/sessions/DEFECT-*.md` |
| 08-compute mock-catalog E2E completed (self-seeding, no env-var skip) | **NOT RUN** (code complete, `tsc --noEmit` of `e2e` clean; the run is a heavy-run request) | `e2e/tests/08-compute-customer.spec.ts`, `e2e/tests/fixtures/qa-compute-catalog.ts` |

`it.fails` convention: a test states the SECURE expectation and is expected to fail while the defect exists; when the owner fixes it the test turns red ("expected to fail") and the marker must be removed. This keeps the suite green without weakening any assertion.

## Remaining / in progress
See `docs/security/AI-ENGINE-SECURITY-FINDINGS.md` (living) and the list at the end.

## Heavy-run requests (for the Master)
1. `E2E` `08-compute-customer` ar+en (needs the isolated stack: `pnpm test:e2e:isolated` or `scripts/e2e-stack.sh run e2e/tests/08-compute-customer.spec.ts`). Expectation: test 3 seeds the synthetic catalog and runs offer -> quote -> create -> running -> stop -> delete on the simulator. Unverified selectors/timings: I could not execute it. If it fails, send me the trace; do not mark PASS.

## Escalations
none yet.
