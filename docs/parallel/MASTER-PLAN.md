# Nuzm AI Agent Engine — master plan for parallel development

Created 2026-11-24 by Session 01 (Master Orchestrator). Baseline commit: `f81872d5` on `claude/run-it-dc3d6a` (verified: lint, typecheck, unit 52/52, integration api 2128 passed / 0 failed, E2E ar 45 + en 45 passed with 2 documented skips — see `docs/reports/AG-ENGINE-status-2026-11-24.md`). Historical figures; each worker re-verifies in its own worktree before relying on them.

## 1. Sessions, branches, worktrees
Integration branch `integration/ai-engine` (worktree `.claude/worktrees/ai-integration`, owned by Session 01). Worker branches are cut from it.

| # | Session | Branch | Worktree (under `/Users/elaf/Projects/nuzm/.claude/worktrees/`) | Postgres port | Migration ids |
|---|---|---|---|---|---|
| 01 | Master Orchestrator | `integration/ai-engine` | `ai-integration` | 54341 | none (allocates) |
| 02 | AI Providers / S-AG4 | `feature/ai-providers` | `ai-providers` | 54342 | 1900–1919 |
| 03 | Benchmarks / S-AG5 | `feature/ai-benchmarks` | `ai-benchmarks` | 54343 | 1920–1939 |
| 04 | Sandbox + Execution Gateway / S-AG6 | `feature/ai-sandbox` | `ai-sandbox` | 54344 | 1940–1959 |
| 05 | AI Builder Tools / code generation | `feature/ai-builder-tools` | `ai-builder-tools` | 54345 | 1960–1979 |
| 06 | Preview, hosting, deployment | `feature/ai-deployment` | `ai-deployment` | 54346 | 1980–1999 |
| 07 | QA, security, compliance | `feature/ai-qa-security` | `ai-qa-security` | 54347 | 2000–2019 (tests/fixtures only; a migration needs the Master) |
The owner's own development stack (processes on :3000/:3001/:4000 from the main checkout, Postgres :54329) must never be touched. The shared test cluster on :54339 belongs to Session 01/07 full-regression runs only.

## 2. Machine capacity (measured 2026-11-24): 4 CPUs, 8 GB RAM
Load average was already 28 before any worker started. Seven sessions with their own Node processes, type-checkers and test runners will overload this machine unless heavy work is serialized. **Rules, binding on every session:**
1. No full integration suite, no full E2E, no `pnpm test` over the whole repo, no `pnpm verify*`, no rebuild of the consoles in a worker. Use targeted tests (`vitest run <file>`, `pnpm --filter <pkg> test <pattern>`), typecheck of the touched package only, and `TEST_CONCURRENCY=2`.
2. Full regression runs are scheduled by Session 01 only, one at a time (the "heavy slot"). A worker needing a heavy run writes the request in its report (`STATUS` section "heavy-run requests"); the Master runs it on the integration branch after merging.
3. Each worker uses its own Postgres port and database names (`nuzm_<session>_*`), started with `NUZM_PGPORT=<port> pnpm services:start`; never the owner's :54329 and never :54339.
4. Do not kill processes you did not start. Do not run `pnpm install` in parallel with another session: install only if `node_modules` is missing, with `pnpm install --frozen-lockfile --offline` first.
5. If the machine load average stays above 12 for 5 minutes, pause heavy work and do documentation/design work instead.

## 3. Task classification vocabulary
READY · MOCKABLE · DEPENDENT · OWNER-BLOCKED · SECURITY-BLOCKED · EXTERNAL-BLOCKED · VERIFIED (implemented with test evidence you ran and saw). Only the specific operation that needs a missing dependency is blocked; a blocked task is recorded and the next READY/MOCKABLE one starts.

## 4. Hard prohibitions (all sessions, no exceptions)
No live provider call or probe; no real credential; no acceptance of agreements; no customer-data transfer; no customer-code execution; no real executable tool exposed; no paid resource; no real deployment; no ZATCA claim; no production capability enabled; every new capability behind a feature flag default off. Offline results are never labelled live-verified. Do not reset, delete, rebase published history or force-push any branch. Commit only your own verified work, with the attribution line the harness gives you; never commit credentials or generated artifacts (screenshots, evidence JSON).

## 5. Integration
Session 01 merges verified worker commits into `integration/ai-engine` in batches (see `INTEGRATION-PLAN.md`). Workers: commit small and often on your branch; keep `STATUS` current; request contract changes through `SHARED-CONTRACTS.md` §3; never edit files owned by another session (`FILE-OWNERSHIP.md`).

## 6. Reading order for a worker
This file → your `sessions/SESSION-0N.md` (full prompt and acceptance) → `FILE-OWNERSHIP.md` → `SHARED-CONTRACTS.md` → `DEPENDENCIES.md` → `OWNER-DECISIONS.md` → `/CLAUDE.md` (repository rules).
