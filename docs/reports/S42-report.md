# S42 — Agent graph, approvals, budgets, app specs (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
Migrations 1400 (ai.run_steps, ai.tool_calls, ai.approval_requests, permissions) and 1401 (builder.app_specs); `graph/dag.ts` (7-agent DAG, validated before a run), `graph/runner.ts` (steps persisted, checkpoint after every node, resume without duplicates via unique `(run_id,node)`, optimistic take-over of a dead worker), `approvals/approval.service.ts` (10 types, role policy, hash-bound, 24 h expiry, 409 stale hash / 410 expired / idempotent repeat), `graph/budget.ts` + `guarded-model.ts` (pre-flight reservation, cost cap = min(run cap, org remaining), timeout counted as spent, ≤2 repairs), `spec/*` (versioned immutable specs).

## Tests (files; results in `M10-report.md` §E)
`run-engine.int.spec.ts` (16: happy path, crash+resume, two workers, budget stop, org credit cap, timeout/no_capacity/malformed, cancellation, approval matrix, cross-tenant, RLS), `dag.spec.ts`, `budget.spec.ts` (2,000-run property test), `schema.spec.ts`, `app-spec.spec.ts`.

## Not done / NOT VERIFIED / BLOCKED
Model = scripted adapter: model quality NOT VERIFIED. M09 tables not created (logical refs).

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.

## Finish session (branch `claude/m10a-finish-c51b35`): runs, approvals, budgets on the real M09
- Runs: `webapp` and `test-fix` are run kinds registered in M09's `RunKindRegistry` (`internal/run-handlers.ts`); M09's segment engine owns the operation, lease, resume and final state; `PgRunStore` writes `ai.runs` through the same state-machine trigger. The graph emits `node_started|node_succeeded|node_failed|approval_requested|budget_warn|project_committed` into `ai.run_events`. **PASS** — `m09-real.int.spec.ts` ("a webapp run through M09 /v1/ai/runs"): 7 persisted, checkpointed steps, 7 artifact kinds, usage rows in `ai.model_usage`, credits drawn from the wallet.
- Approvals: M10's inbox (`ai.approval_requests`) is what a webapp run waits on; a decision calls `RunService.resumeParked` (queued + new operation); stale hash 409, viewer 403, rejection → `approval_rejected`, expiry (sweeper `ApprovalService.sweepExpired`, every minute) → `approval_expired`, late decision 410, cancelling a waiting run frees the project. **PASS** (same spec).
- Budgets: the run-level guard stays in front of the gateway; M09's gateway reserves and settles per call against the wallet (the run cap is also passed as `{maxTokens,maxCredits}`); an organization without credit is 402 before anything runs. **PASS**.
- Model = M09's deterministic MOCK provider (plumbing only): model quality **NOT VERIFIED** (D-18/HG-09-01).
