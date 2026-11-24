# DEFECT-11 — concurrent first-ever edits of the deployment policy: the loser gets a 500, not a 409

Reporter: Session 07 (QA) · Owner: Session 06 (`apps/api/src/modules/deploy/internal/policy.service.ts` `set()`) · cc Master · Severity: **LOW** (server error instead of conflict; no wrong policy is stored) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-deployment 03380df9 merged into feature/ai-qa-security) · Found 2026-11-24 on `integration/ai-engine` after CONTRACT-5

## Where
`set()`: `SELECT … FROM deploy.org_policies WHERE org_id=$1 FOR UPDATE` locks nothing when the organization has no row yet (every organization until its first edit). Concurrent `PUT /v1/deployments/policy` with `expectedVersion: 0` all pass the version check, then all `INSERT`; the second hits the primary key and surfaces as HTTP 500. (Also `before` is read outside the transaction, so the audit `before` can be stale under concurrency.)

## Reproduction
`apps/api/src/qa/qa-deploy-policy-matrix.int.spec.ts` → `it.fails('DEFECT-11 …')`: eight simultaneous first edits. With a row present the same race is correct (exactly one 200, seven 409, version +1, one audit event; passing control).

## Suggested fix
`INSERT … ON CONFLICT DO NOTHING RETURNING` and treat "no row returned" as a version conflict (409), or take `pg_advisory_xact_lock(hashtext(org_id))` before reading; read `before` inside the same transaction.

## Re-test result
FIXED and RE-TESTED: 8 simultaneous first-ever edits → one 200, seven 409, no 5xx (`qa-deploy-policy-matrix.int.spec.ts`, ordinary test).
