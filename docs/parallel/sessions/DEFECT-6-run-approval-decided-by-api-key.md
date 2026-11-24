# DEFECT-6 — an AI run's approval can be decided by an API key holding only `ai:write`

Reporter: Session 07 (QA) · Owner: Session 02 (`apps/api/src/modules/ai/**`, run engine) · cc Master, Session 05 (builder kinds that request approvals) · Severity: **MEDIUM** · Status: OPEN · Found 2026-11-24, baseline `f81872d5`

## Where
`apps/api/src/modules/ai/ai-runs.controller.ts:130-132` (`@RequirePermission('ai:write')` on `POST /v1/ai/runs/{id}/approvals`) and `apps/api/src/modules/ai/internal/run.service.ts:444-505` `decide()`. The comment on the route says "the approver is always a human member"; `decide()` never looks at the actor kind or at the permission `ai:approve`.

## Reproduction (`apps/api/src/qa/qa-run-approval.int.spec.ts`, own Postgres, in-process server)
1. Owner creates an API key with scope `ai:write` (`POST /v1/api-keys`).
2. A run is `waiting_approval` with a pending approval (kinds include `publish`, `delete`, `spend`, `apply_changes`, `auto_apply`).
3. `POST /v1/ai/runs/{id}/approvals {approvalId, decision:'approve'}` with `Authorization: Bearer nzk_…` → **200**; approval `approved`, `decided_by` = the key creator; audit says `actorType:'user'`.

## Expected
Per CLAUDE.md §4 ("human approval for destructive or paid production actions") and the M10 engine (`APPROVAL_POLICY`: role + `ai:approve`, human member only): an API key, a worker or the run itself can request but never decide an approval; the decision needs a session user with `ai:approve`; the audit event records who really acted.

## Actual
Anything holding `ai:write` decides: the same key that created the run (`ai:write`) also approves its gated step. `ai:approve` (which the migration 1400 grants to owner/admin/developer) is not consulted on this route at all, so the permission exists in the catalogue but does not gate the legacy run-approval route. Related: the comment at `run.service.ts:470` ("the stored action hash must still match the stored summary payload") describes a check that is not in the code (the DB trigger `ai.approval_guard` freezes `kind`/`action_hash`/`run_id`, not `summary`).

## Suggested fix
In `decide()` (or the controller): require `a.actor.kind === 'session'`; require `ai:approve`; record `actorType` honestly; keep `ai:write` for cancel. Either implement the hash/summary comparison or delete the comment. Same rule as DEFECT-4 (deployments): one shared approver check for both legacy paths.

## Tests
`qa-run-approval.int.spec.ts` → `5 passed | 1 expected fail`. Passing controls: viewer/billing admin 403 and approval stays pending; another organization 404; an approval id does not move to another run; a decided approval is final (409). `it.fails('DEFECT-6 …')` states the secure expectation (fails today); the `CONFIRMED TODAY` test proves it fails for the right reason and must be deleted with the fix.
