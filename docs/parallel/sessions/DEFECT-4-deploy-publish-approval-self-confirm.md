# DEFECT-4 — a website publish is "human-approved" by whoever asks, including an API key

Reporter: Session 07 (QA) · Owner: Session 06 (`apps/api/src/modules/deploy/**`) · cc Master · Severity: **MEDIUM** (a control the code, the docs and CLAUDE.md §4 call "human approval" is satisfied by a non-human actor; no real deployment is possible today because the publisher is the in-memory fake) · Status: FIXED, RE-TESTED for the API-key part (Session 06 `8d787bfa`) (2026-11-24) · Found 2026-11-24 on baseline `f81872d5`

## Where
`apps/api/src/modules/deploy/internal/deploy.service.ts` `create()` (approval request ~line 168-196, confirmation ~line 198-262) and `deployments.controller.ts:29` (`@RequirePermission('deploy:write')`).

## Reproduction (integration test, own Postgres, in-memory publisher; nothing leaves the process)
`apps/api/src/qa/qa-deploy-approval.int.spec.ts`:
1. An organization owner creates an API key with scope `deploy:write` (`POST /v1/api-keys`, step-up satisfied by the test harness).
2. `POST /v1/deployments` `{projectId, target, environment:'production'}` with `Authorization: Bearer nzk_…` → `403 approval_required` + `approvalId` (an approval row, state `pending`).
3. The SAME key repeats the call with `approvalId` and a new `Idempotency-Key` → **`202`**, a deployment is created, the approval becomes `approved` with `decided_by = <key creator's user id>`.

## Expected
The approval of a production publish is decided by a human: a session user holding the approval permission, as the M10 engine already requires for every other approval type (`APPROVAL_POLICY` in `appbuilder/internal/approvals/approval.service.ts`: roles + `ai:approve`, "an approver must be a human member"; `production_deploy` = owner/admin). A non-human actor (API key, AI run, worker) may request the approval but never decide it.

## Actual
- The two-step flow is a *confirmation by the requester*: the same `POST` that names `approvalId` flips `pending → approved` itself (`UPDATE ai.approvals SET state='approved', decided_by=$2`), with only `deploy:write`. The controller comment says "confirm as a human with a write role" but nothing checks "human": `a.actor.kind` is never consulted (`actor.kind === 'api_key'` is available on `AccessContext`).
- The audit trail then attributes the decision to the key's creator as `actorType:'user'` (`ai.approval.granted`, `deploy.deployment.created`), i.e. the record says a person approved something an automated caller approved (audit-integrity impact).
- Second (design question for the owner, not asserted as a defect): the `developer` role holds `deploy:write` (and `ai:approve`) but is not one of the roles the M10 policy lists for `production_deploy` (owner/admin); a developer requests and confirms alone (test `OBSERVATION: a developer … self-confirmation`). The legacy `ai.approvals` publish path and the M10 `ai.approval_requests` engine therefore apply different rules to the same action.
- `rollback` creates a deployment from the previous approved artifact reusing the previous `approval_id` (no new approval); the M10 policy has a separate `production_rollback` type. Decide whether a rollback needs its own approval.

## Suggested fix (Session 06 decides)
Route the publish confirmation through the approval engine (or add the same checks to the legacy path): reject `a.actor.kind !== 'session'` on the confirming call; require `ai:approve` (and the type's roles) for the decision; record `actorType:'api_key'` when a key acted. Keep the two-call shape (no API change) if the OpenAPI contract is to stay additive.

## Tests
`qa-deploy-approval.int.spec.ts` (run: `7 passed | 1 expected fail`, own Postgres :54347):
- `it.fails('DEFECT-4: an API key (not a human) cannot confirm a publish approval')`: secure expectation; fails today. When fixed it turns red: remove `.fails`.
- `CONFIRMED TODAY …`: passes while the defect exists and proves the failing test fails for the right reason (second call is 202, `decided_by` = the key creator). Delete it when fixed.
- Passing controls (isolation and replay): another organization cannot ask for, confirm or read org A's deployment, nothing is created, the approval stays pending; viewer and billing admin get 403 and no approval row; a used approval, another environment or another site is 409; malformed ids are 4xx, never 5xx.

## Re-test result (2026-11-24, branch merged with integration/ai-engine 4af0920c)
FIXED and RE-TESTED for the API-key part (Session 06 `8d787bfa`): the `it.fails` is an ordinary test and passes; the CONFIRMED TODAY control was deleted. Developer self-confirm and rollback reusing the approval remain OPEN by owner decision (O-1, O-2).
