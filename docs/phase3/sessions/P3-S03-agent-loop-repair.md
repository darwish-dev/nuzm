# P3-S03 — Real Agent Loop and Automatic Code Repair

Branch `feature/p3-s03-agent-loop` · worktree `.claude/worktrees/p3-s03` · Postgres 54353 · migrations 2320–2329. Read first: `CLAUDE.md`, `docs/phase3/PHASE-3-PLAN.md`, `docs/parallel/sessions/REPORT-05.md` (traceability table, Batch 3 checklist), `docs/parallel/sessions/PHASE2-05-qualification-evidence.md`, ADR-066.

## Implementation prompt
You own the 18-step builder lifecycle as a **real** engine. Phase 2 proved plumbing with a scripted model and a mock execution port. Now connect the real model gateway (P3-S01) and the real execution port (P3-S02) **through the existing seams** (`GatewayService.invoke`, `ExecutionPort`/`BuildPort`) without changing the lifecycle's contracts, and make generation and repair actually good. Build everything against the mock/twin until the real components exist; the switch from mock to real is configuration plus approvals.
Deliver: (1) model-backed generation (`builder_lifecycle.model_generation`) with context management (project memory read **and** write, relevant-file selection, token budgeting, compression), structured plans, multi-file edits as one validated change, review step with real findings; (2) **automatic repair**: parse real build/test failures (TypeScript, bundler, test runners, Dart/Gradle), classify, produce a patch, apply as a new version, rebuild, bounded by repair limits, with the strategy corpus and metrics (repair success rate per error class, rounds, tokens); (3) loop safety: injection resistance on tool results and project files (S07's suite), permissions per tool, approval parking, cancellation at every checkpoint, idempotent resume after crash (the 29-checkpoint exhaustive test stays green), wallet accounting reconciliation (tokens/credits = model_usage = ledger); (4) progress/UI for the agent screen with real data; (5) integrate with S04/S05/S06 project types through the 14 product planners (all 14 still resolve) without owning their generators.
## Scope boundaries
In: appbuilder lifecycle, agent-tools, agent-loop, agent UI. Out: website/full-stack/mobile generators (S04/S05/S06), providers (S01), runtime (S02), deploy (S07).
## Acceptance criteria
- L1 With real model + real runtime (synthetic brief): the loop completes requirements -> plan -> files -> build -> tests -> preview request -> deployment approval request; evidence record with model id, tokens, cost, tool invocations, files, build/test results, repair rounds, durations.
- L2 **Repair demonstration (T5):** a deliberately broken synthetic project (type error, missing import, failing test) is detected, repaired by the real model and rebuilt green within the repair limit; error-class table in the evidence; at least 3 error classes demonstrated.
- L3 Limits hold live: max iterations, retry limits, token/credit ceilings stop the run with the right state and no unbilled usage (ledger reconciles).
- L4 Cancel at queued/mid-build/parked works against the real runtime; the real approval cannot be decided after cancel (DEFECT-14 test green).
- L5 Phase 2 lifecycle suites (unit 255+, int 25+, qualification 5 projects) stay green; the new real path is behind flags default OFF.
## Dependencies
Needs: S01 (model), S02 (runtime) for L1–L4 live; mock meanwhile. Provides: loop to S04–S06.
## Human gates
Provider and runtime approvals (owned by S01/S02); any production deploy approval stays human.
## First tasks
Merge `integration/phase3`; build the repair strategy corpus and an offline repair evaluation using recorded real-world error logs (public synthetic projects); context-management upgrade; real-path flags and refusal tests; `REPORT-P3-S03.md`.
