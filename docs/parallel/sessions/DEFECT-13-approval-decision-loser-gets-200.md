# DEFECT-13 — a decision that lost a race to a DIFFERENT decision is answered 200 with the winner's record

Reporter: Session 07 (QA) · Owner: Session 05 / Master (`apps/api/src/modules/appbuilder/internal/approvals/approval.service.ts` `decide()`) · Severity: **LOW** (the stored state is correct: one decision, one audit event) · Status: OPEN · Found 2026-11-24

`decide()`: `UPDATE ai.approval_requests … WHERE id=$1 AND status='pending' RETURNING *`; when no row comes back the code does `return this.get(orgId, id); // lost a race with an identical decision: return the winner`. It does not check that the winner's decision/actor is the same. Two humans sending OPPOSITE decisions at once (approve by one, reject by the other) both receive HTTP 200 (verified with approve/reject/approve: three 200s); the one whose decision lost is told "200" with a body that says the opposite of what they asked. A client that reads the status code (or an operator who clicks Approve and sees a success toast) believes their decision was applied. Sequential repeats are handled correctly (identical → idempotent, different → 409).

Expected: the loser of a race gets the same answer as a sequential late decision: 200 only for an identical decision by the same actor, otherwise 409 `conflict` ("the approval is already rejected").
Fix: after `!updated`, re-read and apply the same identical-decision test as the sequential branch.
Tests: `qa-agent-loop-http.int.spec.ts` → `it.fails('DEFECT-13 …')`; the passing twin proves exactly one decision and one audit event land.
