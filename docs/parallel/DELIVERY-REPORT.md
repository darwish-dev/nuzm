# AI Agent Engine — consolidated delivery and readiness report (parallel phase)

Date: 2026-11-24 · Integration branch `integration/ai-engine` · Baseline `f81872d5` · Verified head `4d881244` (+ the final Session 06 report merge, docs only). Nothing pushed, nothing merged into `main` or `claude/run-it-dc3d6a` (D-01: no remote). **No live provider, credential, probe, agreement, customer-code execution, real deployment or paid resource was used or enabled.**

## 1. Sessions and what each delivered
| Session | Branch (head) | Delivered (all offline/simulated, flags default off) |
|---|---|---|
| 01 Master | `integration/ai-engine` | coordination docs, six worktrees, contract and migration allocation, 7 integration merges, manifest/SDK/spec reconciliation, regression runs |
| 02 Providers / S-AG4 | `feature/ai-providers` (`5c5a2b53`) | retry/backoff, circuit breaker, health monitor, approved fallback routing, capability registry + discovery, context fitting, versioned rate cards with FX interface and credit derivation preview, usage report, rate-card history (migration 1900), OpenAI/Gemini contracts as drafts only (D11), DEFECT-6 fix (API key could decide a run approval) |
| 03 Benchmarks / S-AG5 | `feature/ai-benchmarks` (`48350035`) | dataset v2: 83 golden tasks in 23 categories with a lock file, registry/versioning, deterministic scorers (correctness, quality, security, UI, tokens, cost, latency), comparison, regressions, strict rollout gate, qualification and reviewer workflows, budget enforcement, gated live runner (never run), admin API + dashboard (ar/en), migrations 1920–1921 |
| 04 Sandbox / S-AG6 | `feature/ai-sandbox` (`cc318642`) | `ExecutionPort` + `MockExecutionPort` (never executes), job/workspace state machines, fair queue, quotas/timeouts, approval workflow, content-free audit, termination, resource monitor, artifact policy, orchestrator, escape suite 1.1.0, runtime evaluation + recommended architecture (`docs/security/sandbox/`), fixes for DEFECT-1, 2, 3, 5 |
| 05 Builder tools | `feature/ai-builder-tools` (`20935fd2`) | unified diff, change preview, version diff, rollback/revert, requirement analysis, task decomposition, plans for 14 product types (ar/en), review, symbols/imports/components, context compression, project memory, repair loop over a `BuildPort` (refuses without one), `ExecutionBuildPort` adapter, UI panels (ar/en), 12 routes behind `builder_tools.enabled` |
| 06 Deployment | `feature/ai-deployment` (`3cedc4b2`) | cancel, SIMULATED labelling, orphan recovery, simulated health probe, UI fixes (superseded/rollback state), DEFECT-4 fix (API key could confirm a publish approval), new `10-deploy-simulated` E2E (4 tests per language) |
| 07 QA / security | `feature/ai-qa-security` (`1b9383cd`) | 9 QA suites (336 tests), threat model, consolidated findings, route inventory gate, authz matrix, migration round trip, builder-tools HTTP suite, 08-compute mock-catalog E2E; found 6 defects, all fixed and re-tested |
All six branches are merged into integration.

## 2. Verified results on the integration head (commands run, results seen)
| Check | Result |
|---|---|
| `pnpm lint` / `pnpm typecheck` | exit 0 / 52 of 52 |
| `pnpm test` (unit, concurrency 2) | 52 of 52 tasks |
| `pnpm test:integration` (concurrency 2) | db 102, platform 32, worker 92, **api 2554 passed, 0 failed**, 2 skipped (pre-existing) |
| Isolated E2E `ar` (1 worker, axe in every spec) | **51 passed, 0 failed, 0 skipped** |
| Isolated E2E `en` | **51 passed, 0 failed, 0 skipped** |
| `spec:lint`, `spec:drift` (523 routes), `sdk:check`, `scan:secrets`, `zatca:guard`, `claims-guard` | all exit 0 |
| DB: `db:migrate` (1900, 1920, 1921, 1980), `db:test-rls`, classification coverage (3396 columns / 271 tables), ROPA, residency hooks, up/down/up of the AI range | pass |
The two previously skipped E2E tests (08-compute mock catalog, deploy leg) now run and pass — **with simulated evidence only** (mock compute catalog; in-memory publisher). Model quality, real builds and real deployment remain NOT VERIFIED.

## 3. Security findings (Session 07; full text `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`)
DEFECT-1 exec-policy prototype-chain profile lookup; DEFECT-2 SSRF check missed IPv6 spellings of private IPv4; DEFECT-3 SIIT and discard prefix egress; DEFECT-4 API key could confirm a publish approval; DEFECT-5 local-dev sandbox symlink confused deputy; DEFECT-6 API key could decide a run approval — **all fixed, re-tested, regression tests in place.** Open owner decisions from QA: O-1 (developer self-confirms production publish), O-2 (rollback reuses approval), O-9 (`billing_admin` can read customer project contents through the new routes), O-10 (dev cloud seed ids the mock adapter rejects; dev-only).

## 4. Completion (evidence-based; two different measures, not to be conflated)
Method A — **acceptance prerequisites with evidence** (the Master's measure from the previous report; moves only when an owner decision or live verification happens). Method B — **offline engineering scope of each session verified by tests** (what could be built without any approval).
| Milestone | A: acceptance | B: authorized offline scope |
|---|---|---|
| S-AG0–S-AG3 | 100 % | 100 % |
| S-AG4 providers | 22 % (D7, D8 done; D2, D4, D5, D6, D3, D9, OpenAI/Google owner-blocked) | ≈ 90 % (Claude path complete offline; OpenAI/Gemini contracts only by D11; contract 1.2 token classes is a design note awaiting D6) |
| S-AG5 benchmarks | ≈ 33 % (offline suite + proposed thresholds; S-AG4, accepted thresholds, reviewers, budget, security review missing) | ≈ 95 % |
| S-AG6 execution | 0 % as a capability (D-21 open) | ≈ 95 % (durable stores and wiring deferred by design) |
| Builder tools | n/a | ≈ 80 % (routes/UI wired behind a flag; not yet wired into the agent-loop run kind or the run engine; no E2E for the builder-tools UI) |
| Deployment (simulated) | real deployment 0 % (HG-05/06 open) | ≈ 90 % |
| QA / security | n/a | ≈ 85 % (dynamic audit-chain and ledger tests, post-merge re-audit of every module remain) |
| **Overall AI Agent Engine** | **≈ 66 %** (mean of the S-AG rows 100, 100, 100, 100, 22, 33, 10) | **≈ 90 %** of the authorized offline scope |
Neither number is a production-readiness figure.

## 5. Production readiness
**Not production-ready.** No real provider is verified; tool calling is declared for no real model; no benchmark has run on a model; D1/D2 (residency and data terms) are undecided; no execution runtime exists and D-21 is open; deployment is simulated only; D-42 is open. The gates all fail closed and are tested; every new capability is behind a default-off flag.

## 6. Actual blockers and required owner actions
See `OWNER-DECISIONS.md` (one table) and `docs/ai-intelligence/OWNER-APPROVAL-CHECKLIST.md`. In order of unblocking value: D2, D4, D5, D6, D3, D9 (live probe, ≤ USD 0.24) → S-AG4 closes for Claude; accept or change the 11+ proposed thresholds, name reviewers, set a benchmark budget, name a security reviewer → S-AG5 can run live; D-21 + HG-10-02 → S-AG6; HG-05/HG-06 → real deployment verification; O-1, O-2, O-9 permission questions.

## 7. Remaining implementation work (not blocked by an owner)
1. Wire the builder-tools plan/review/repair into the S-AG3 agent-loop run kind and the run engine (needs Master-owned registration; use `MockBuildPort`).
2. E2E for the builder-tools UI panels and for the provider and benchmarks admin screens.
3. Dynamic QA: audit-chain integrity and ledger/credit correctness under the new AI flows; a post-merge audit of the final heads.
4. Fix the dev cloud seed (O-10).
5. Durable stores for the execution orchestrator (after D-21).

## 8. Process notes
Worker worktrees got copy-on-write `node_modules` from the baseline; the first clone missed nested package folders (a local environment gap, not a source defect). Heavy runs were serialized by the Master; the machine (4 CPUs, 8 GB) was never asked to run two stacks at once after the first launch.
