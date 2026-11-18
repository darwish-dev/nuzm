# S42 — Agent graph, approvals, budgets, app specs (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
Migrations 1400 (ai.run_steps, ai.tool_calls, ai.approval_requests, permissions) and 1401 (builder.app_specs); `graph/dag.ts` (7-agent DAG, validated before a run), `graph/runner.ts` (steps persisted, checkpoint after every node, resume without duplicates via unique `(run_id,node)`, optimistic take-over of a dead worker), `approvals/approval.service.ts` (10 types, role policy, hash-bound, 24 h expiry, 409 stale hash / 410 expired / idempotent repeat), `graph/budget.ts` + `guarded-model.ts` (pre-flight reservation, cost cap = min(run cap, org remaining), timeout counted as spent, ≤2 repairs), `spec/*` (versioned immutable specs).

## Tests (files; results in `M10-report.md` §E)
`run-engine.int.spec.ts` (16: happy path, crash+resume, two workers, budget stop, org credit cap, timeout/no_capacity/malformed, cancellation, approval matrix, cross-tenant, RLS), `dag.spec.ts`, `budget.spec.ts` (2,000-run property test), `schema.spec.ts`, `app-spec.spec.ts`.

## Not done / NOT VERIFIED / BLOCKED
Model = scripted adapter: model quality NOT VERIFIED. M09 tables not created (logical refs).

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.
