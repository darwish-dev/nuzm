# DEFECT-14 — cancelling a builder lifecycle run leaves its production-deploy approval pending and decidable

Reporter: Session 07 (QA) · Owner: Session 05 (lifecycle approval request) / Master (M10 approvals, run cancellation) · Severity: **LOW-MEDIUM** (nothing deploys today; a stale authorization stays alive) · Status: FIXED, RE-TESTED (2026-11-24) · Found 2026-11-24

Reproduction (`qa-agent-loop-http.int.spec.ts`): start a lifecycle run, drive it to `waiting_approval` (a `production_deploy` approval in `ai.approval_requests`, requested by the AI), cancel the run (`POST /v1/ai/runs/{id}/cancellation` → 202, state `cancelled`). The approval still appears in `GET /v1/ai/approvals?status=pending`, and an owner's `POST /v1/ai/approvals/{id}/decisions {approve}` answers **200 approved**. The legacy `ai.approvals` path (run-engine plan approvals) does close its approval on cancel (qa-run-concurrency passes); the M10 path does not.
Why it matters: an approved `production_deploy` for a run that will never deploy is a dangling authorization in the audit trail and in the approvals inbox; any future consumer that treats "approved production_deploy for subject run X" as permission (a deployment endpoint taking an approval id, a resumed run, a restored project) would honour it after the owner cancelled.
Expected: cancelling a run revokes (expires/withdraws) every pending approval of that run in the same transaction; a later decision answers 409/410.
Safe today: the cancelled run never resumes and starts no step (verified by the passing twin test).
Tests: `it.fails('DEFECT-14 …')` + passing twin.

## Re-test result
FIXED and RE-TESTED (fix `8733daad`): cancelling a run closes its approval (it leaves the pending list and a later decision is refused); same run, 17 passed, 0 expected-fail.
