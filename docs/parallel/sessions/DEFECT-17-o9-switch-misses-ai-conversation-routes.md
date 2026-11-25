# DEFECT-17 — the O-9 switch does not cover AI conversations, runs, events and artifacts

Reporter: Session 07 (QA) · Owner: Session 02 (`apps/api/src/modules/ai/**`) · cc Master, Session 05 · Severity: **MEDIUM** (a billing administrator reads the customer's AI conversations and the generated files of a run under `deny`; default stays allow) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-providers 1ab896b9 merged into feature/ai-qa-security) · Found 2026-11-24 (Master request: O-9 scope audit)

The role seed gives `billing_admin` `ai:read` ("Read AI models, credits, budgets, sessions and runs"). The O-9 switch is not consulted by the AI routes. Evidence: `docs/security/O9-CONTENT-ACCESS-AUDIT.md`; test `qa-o9-content-access.int.spec.ts` (`it.fails('O-9 (Session 02 scope) …')`).

Routes (all `GET`, permission `ai:read`):
- `GET /v1/ai/runs` (content by design, fixture empty)
- `GET /v1/ai/runs/:id` (content by design, fixture empty)
- `GET /v1/ai/runs/:id/artifacts/:artifactId` (content returned)
- `GET /v1/ai/runs/:id/events` (content by design, fixture empty)
- `GET /v1/ai/sessions` (content returned)
- `GET /v1/ai/sessions/:id/messages` (content returned)
The planted conversation text came back from `/v1/ai/sessions` and `/v1/ai/sessions/:id/messages`; the generated project files (a run's change-set artifact) came back from `/v1/ai/runs/:id/artifacts/:artifactId`. Metadata the role needs stays readable: `/v1/ai/credits`, `/v1/ai/budgets`, `/v1/ai/models`, and (decision for the owner) the approvals list, whose action summary carries no source text in this audit.
Expected: under `deny`, 403 for billing_admin only; audited; other roles unchanged.
Fix: reuse `ContentAccessService` (appbuilder) through the platform's public interface or move the policy check to a shared access helper, then add the operations `ai_sessions`, `ai_messages`, `ai_runs`, `ai_run_events`, `ai_artifacts`.

## Re-test result
FIXED and RE-TESTED for the six AI content routes: under `deny`, `GET /v1/ai/sessions`, `/sessions/:id/messages`, `/runs`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts/:artifactId` answer 403 to billing_admin (before the event stream starts) and `allow` restores them; `qa-o9-content-access.int.spec.ts` 6 passed + 1 expected-fail (the Session 05 part), three runs in a row; credits, budgets, models stay readable; other roles unaffected. Before flipping, the unflipped `it.fails` failed with "Expect test to fail". `qa-run-concurrency` 11, `qa-agent-loop-http` 17, `qa-run-approval` 5 passed on the same tree. Open question for the owner: the approvals list (`/v1/ai/approvals`, appbuilder module) is treated as metadata.
