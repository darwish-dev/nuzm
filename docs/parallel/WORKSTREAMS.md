# Workstreams and task classification (initial; each worker updates its own section in its report)

## 02 AI Providers (S-AG4) — scope in `sessions/SESSION-02.md`
| Task | Class |
|---|---|
| Review existing Claude adapter (contract 1.1), model capability registry, evidence table, probe wrapper; close offline gaps | READY |
| Model discovery (offline listing from adapter metadata + stored evidence), capability registry API | READY |
| Streaming cancel, retry policy, circuit breaker, health monitor (state machine, fixtures, no network) | READY |
| Approved fallback routing (policy + tests, uses existing routing) | READY |
| Dynamic rate cards, currency-conversion interface, credit conversion, usage reporting API + admin UI | READY (real rate card = D6 OWNER-BLOCKED) |
| Provider admin UI (configuration, evidence, usage) in `apps/admin` | READY |
| OpenAI / Gemini: contracts and offline fixtures only | MOCKABLE (adapters themselves OWNER-BLOCKED by D11) |
| Live probe, live connection test, real key | OWNER-BLOCKED (D2, D3, D4, D5, D9) / EXTERNAL-BLOCKED |

## 03 Benchmarks (S-AG5) — `sessions/SESSION-03.md`
Extend the 24 golden tasks to the 23 requested categories; registry and dataset versioning; deterministic scorers (functional, code quality, security, UI/a11y, tokens, cost, latency); model comparison; regression; reports; dashboard (admin UI); human-reviewer workflow; benchmark budget enforcement; qualification workflow; live runner prepared behind gates. All READY/MOCKABLE offline; live runs OWNER-BLOCKED (S-AG4, accepted thresholds, budget, reviewers, security review).

## 04 Sandbox + Execution Gateway (S-AG6) — `sessions/SESSION-04.md`
Gateway contracts, workspace lifecycle, runtime interfaces (container, microVM evaluation), quotas, timeouts, process lifecycle, secret/env isolation, cleanup, execution log/audit, approval workflow, emergency termination, resource monitor, job queue, artifact handling, health checks, extended escape suite, security regression tests, recommended architecture document. READY/MOCKABLE offline; any real runtime SECURITY-BLOCKED (D-21, HG-10-02, ADR-067), customer-code execution OWNER-BLOCKED.

## 05 AI Builder Tools — `sessions/SESSION-05.md`
Builder project/file/code tools, diff and patch preview, dependency/import analysis, generation planners per product type, requirement analysis, task decomposition, review/repair loop against mock execution, context compression, project memory, template and skills integration, builder UI extensions. READY/MOCKABLE (uses the S-AG6 mock execution contract); real execution SECURITY-BLOCKED.

## 06 Preview, hosting, deployment — `sessions/SESSION-06.md`
Preview lifecycle, artifacts, deployment jobs/queues/status/logs, env var management, domain mapping, SSL lifecycle, rollback, health, history, recovery, approvals, admin + customer UI, and the **skipped 10-app-builder deploy E2E leg** using a seeded local hosting fixture and the in-memory publisher (targeted E2E run is a heavy-slot request). Real deployment EXTERNAL-BLOCKED / HG-05, HG-06.

## 07 QA / security / compliance — `sessions/SESSION-07.md`
Independent audit and tests; the 10b viewer scenario (done and committed at `63b1ed41`, re-verify), the skipped 08-compute mock-catalog test with approved synthetic fixtures, review of every other session's tests, security findings report. Reports defects; edits only test/QA-owned paths.
