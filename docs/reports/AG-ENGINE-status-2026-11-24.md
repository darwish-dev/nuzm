# AI Agent Engine — status after R6 closure and offline preparation (2026-11-24)

Branch `claude/run-it-dc3d6a`, nothing pushed (D-01). **No live provider, customer-data transfer or executable tool was enabled. Nothing below is production-ready.**

## A. What was done in this stage
| Phase | Delivered | Evidence |
|---|---|---|
| 1 R6 closure | viewer + cross-tenant authorization E2E (UI and API, owner control); a real run-cancellation race fixed (`RunService`); full isolated E2E `ar` and `en`; full integration; skipped tests documented with exact prerequisites | `docs/reports/R6-report.md`; E2E 45 passed/2 skipped/0 failed per language; integration api 2128 passed/0 failed |
| 2 S-AG4 preparation | gated probe wrapper behind D9, D3, D2, D4 (`probe_tool_use`), approvals config `AI_PROBE_APPROVALS` (default none, fail closed), evidence recording from the report, audit start/finish; owner checklist | `capability-evidence.int.spec.ts` 19 passed (scripted client, no network); `docs/ai-intelligence/OWNER-APPROVAL-CHECKLIST.md`, `S-AG4-PROBE-PLAN.md` |
| 3 S-AG5 offline | 24-task synthetic golden dataset, offline replay engine, scoring, reports, regression detection, rollout gate, 11 PROPOSED thresholds | `packages/domain/src/ai/benchmarks` (spec: 13 tests; 43 passed together with phase 4); `S-AG5-BENCHMARKS.md` |
| 4 S-AG6 offline | Execution Gateway policy core (closed profile catalogue, fixed argv/env, refusals by name, closed gate), ADR-069 (PROPOSED), requirements map | `packages/domain/src/ai/execution-gateway` spec; `ADR-069-execution-gateway.md`, `S-AG6-REQUIREMENTS.md` |

Not changed: the Claude adapter (contract 1.1, offline-complete; no remaining offline gap found), credential storage (`save_claude_key`), rate-card configuration (`S-AG4-PRICING.md`), residency, audit and metering controls.

## B. Verified test results (commands run, results seen)
| Command | Result |
|---|---|
| Full isolated E2E, `ar` / `en` (1 worker, axe in every spec) | 45 passed, 2 skipped, 0 failed / 45 passed, 2 skipped, 0 failed |
| `pnpm test:integration` (`TEST_CONCURRENCY=2`) | db 102, platform 32, worker 92, api 2128 passed + 2 skipped, 0 failed |
| `pnpm test` (unit, `TEST_CONCURRENCY=2`) | exit 0, 52 of 52 tasks |
| `pnpm lint`, `pnpm typecheck` | exit 0, exit 0 |
| `spec:lint`, `spec:drift`, `scan:secrets`, `sdk:check`, `zatca:guard`, `compliance:claims-guard` | all exit 0 |

## C. Milestones and completion (evidence-based)
Method: the share of each milestone's acceptance prerequisites (`S-AG4-DECISIONS.md` §3, ADR-066 staging) that have PASS evidence in this repository. Offline preparation that is built but cannot be accepted without an owner decision is counted separately, not as completion.
| Milestone | Complete | Basis |
|---|---|---|
| S-AG0 (S-K6 single-call fallback) | 100 % | `S-K6` reports |
| S-AG1 contract 1.1 and conformance | 100 % | `AG-S1-report.md`; conformance kit passes on mock and Claude adapter |
| S-AG2 read-only tool gateway | 100 % | `AG-S2-report.md` |
| S-AG3 agent loop on the mock | 100 % of the offline scope | `AG-S3-report.md`; loop never run on a real model: **NOT VERIFIED** for real behaviour |
| S-AG4 real provider adapters and verification | **22 %** (2 of 9 prerequisites: D7, D8) | D2, D4, D5, D6, D3, D9 execution, OpenAI/Google need the owner; the probe wrapper, credential and pricing configuration, evidence recording are built and tested offline |
| S-AG5 benchmarks and rollout gates | **30 %** | offline dataset, replay, scoring, gate and proposed thresholds done; S-AG4, accepted thresholds, reviewers, spend budget and the security review missing; no model measured |
| S-AG6 execution tools | **0 % as a capability; 10 % offline preparation** | policy core, ADR (proposed) and requirements done; D-21, a verified runtime and the escape suite on it missing |
| **Overall AI Agent Engine** | **≈ 66 %** (mean of the seven rows: 100, 100, 100, 100, 22, 30, 10) | a planning figure of delivered scope, **not** a readiness figure |

## D. Actual blockers
1. S-AG4: D2 (agreement and data terms), D4 (dedicated key and vendor cap), D5 (region/ROPA), D6 (rate card), D3 (open the gate), D9 (approve probe execution), D1 for any customer content, OpenAI/Google deferral or cycles.
2. S-AG5: S-AG4 closing; owner acceptance of the thresholds; named reviewers; benchmark spend budget; security reviewer.
3. S-AG6: D-21 and HG-10-02 review; a real isolating runtime and the escape suite on it; ADR-069 acceptance; legal review of running customer code; D-42.
4. Skipped E2E: mock compute catalog (opt-in), deploy target (HG-05/06).

## E. Required owner actions
See `docs/ai-intelligence/OWNER-APPROVAL-CHECKLIST.md` (one page, ordered; section A unblocks the probe).

## F. Production readiness
**Not production-ready.** No real provider is verified; tool calling is not declared for any real model (unknown = unsupported); no benchmark has run on a model; residency for customer content (D1/D-18) and data terms (D2) are undecided; execution tools are blocked; D-42 is open. Everything is behind feature flags that default off, and the kill switch and gates are tested. The platform around it (console, billing, hosting, domains, data, email, AI screens) has a green isolated E2E and integration suite in both languages.

## G. Commits
See `git log` on the branch; this stage: R6 test closure and fixes, S-AG4 probe wrapper and checklist, S-AG5 offline suite, S-AG6 offline preparation (hashes in the final message).
