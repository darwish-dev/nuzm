# Phase 2 status (Master; updated at each integration batch)

Last update: 2026-11-24 · Integration head: see `git log -1 integration/ai-engine` · Nothing pushed; nothing merged into `main`; no live provider, credential, probe, real execution, real deployment or paid resource used.

## Sessions
| Session | Branch | Phase 2 state | Head merged into integration | Open blocker (exact) | Independent work continuing |
|---|---|---|---|---|---|
| 02 Providers | `feature/ai-providers` | dispatched | — | none for offline work; live: D2, D4, D5, D6, D3, D9 | live-verification suite with mock twin, cost recomputation, admin config |
| 03 Benchmarks | `feature/ai-benchmarks` | dispatched | — | live: provider verified + budget + thresholds + reviewers | staged plan A–E, threshold review, UI, runner sealing |
| 04 Sandbox | `feature/ai-sandbox` | dispatched | — | live: D-21, HG-10-02, ADR acceptance, a Linux non-production node | runtime port with fail-closed attestation, escape-suite runner, qualification doc |
| 05 Builder tools | `feature/ai-builder-tools` | dispatched (priority) | — | real runtime/provider (mocks used) | agent-loop wiring, UI, wallet/cost separation, O-9 switch |
| 06 Deployment | `feature/ai-deployment` | dispatched | — | live: HG-05, HG-06 (target + credentials from the owner) | target port, staging plan, O-1/O-2 switches |
| 07 QA / security | `feature/ai-qa-security` | dispatched | — | none | E2E for new admin/builder screens, dynamic suites, skipped-test review |
| 01 Master | `integration/ai-engine` | in progress | — | none | approval pack, reconciliation, merges, serialized regression |

## Master deliverables so far
| Item | Status | Evidence |
|---|---|---|
| Phase 2 plan, assignments, resource rules | done | `PHASE-2-PLAN.md` (`39658725`) |
| O-10 dev cloud seed (authorized) | done, **verified on a scratch database**: simulator account seeded with `mock-sa-1`, `mock-eu-1`, `mock.small|medium|large`, `mock-ubuntu|mock-debian`; a legacy `dev-sa-1` row was withdrawn on re-seed; guard test (4 tests) passes; db typecheck and eslint clean. The E2E 08-compute spec is re-run in the next heavy batch | `830f2f48` |
| Consolidated owner approval pack | v1 drafted; worker inputs pending | `OWNER-APPROVAL-PACK.md` |
| Hosting-line collision analysis | done (dry run in a throwaway worktree, removed) | `RECONCILIATION-HOSTING.md`: 1 textual conflict, 3 duplicate migration ordinals (1900, 1920, 1980; ordinal is the primary key), 2 ADR-067 files, line B deletes hosting agent code |
| O-1 / O-2 / O-9 | assigned as policy switches defaulting to current behaviour (S06, S05); not decided | `OWNER-APPROVAL-PACK.md` |

## Measurements (Phase 2 start; Phase 1 numbers carried over)
| Dimension | Value | Basis |
|---|---|---|
| Source-code implementation (authorized offline scope) | ≈ 90 % | Phase 1 delivery report |
| Offline functional verification | integration head `fac94541` green (api 2554 passed / 2 skipped; E2E ar 51 / en 51) | Phase 1 |
| Real-provider verification | 0 % (nothing live) | — |
| Real-runtime verification | 0 % | — |
| Real-deployment verification | 0 % | — |
| Security readiness | 6 defects found and fixed; independent review of Phase 2 changes pending | S07 |
| Operational readiness | not started (runbooks outlines in S04/S06 docs) | — |
| Production acceptance | 0 % (D-42 open) | — |
