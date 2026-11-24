# O-9 content-access audit: what a billing administrator can read

Session 07 (QA) · 2026-11-24 · evidence: `apps/api/src/qa/qa-o9-content-access.int.spec.ts` (own PostgreSQL, real RLS and role seed, SIMULATED model; nothing leaves the process). Re-run: `O9_AUDIT_OUT=/tmp/o9.json pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/qa/qa-o9-content-access.int.spec.ts`.

## Result in one paragraph

The owner's O-9 intent is that a billing administrator must not read customer SOURCE CODE, FILES or AI CONVERSATIONS. The role seed gives `billing_admin` `ai:read` and `builder:read`, so it holds the permission for **136 organization GET routes**, and **77** of them answered 200 in the audit organization. **23 of them return customer content** (6 proven by planted text, 17 by design with an empty fixture). The switch `builder.billing_admin_content_access = deny` (built by Session 05) covers **11** of them (the five builder-tools reads). **12 content routes are NOT covered**: 12 on the builder side (Session 05) and 0 on the AI side (Session 02). The default stays `allow` = today's behaviour; only the coverage of the switch needs to grow.

## Method

1. One organization seeded with planted marker strings in: file text (`README.md`, `src/answer.ts`, `src/more.ts`, two versions), an AI conversation (session title and message), a builder lifecycle run parked at its approval, and a change-set artifact of that run (the generated files), plus a website project (forms, previews, CMS, submissions).
2. Every organization `GET` route that carries `@RequirePermission(p)` where the `billing_admin` role HOLDS `p` (read from `tenancy.role_permissions`, not assumed) was called as billing administrator and as owner with real ids and the needed query strings.
3. A route is `200 content` when the planted text came back to the billing administrator, `200 content by design` when its payload type is customer content (instructions, form submissions, CMS entries, test results, run results/events, template workspace) but the fixture is empty, `200 metadata only` otherwise, `not exercised` when it needs a record the audit cannot create (a deployment, a generation plan, a test run id).
4. The policy was then set to `deny` (through `PUT /v1/builder/policies/content-access` as the owner) and every route was called again as billing administrator.

## Table: route -> status as billing administrator (default allow) -> status under deny

| Route | Permission | Billing admin (allow) | Owner | Under `deny` |
|---|---|---|---|---|
| `GET /v1/ai/models` | `ai:read` | 200 metadata only | 200 | 200 |
| `GET /v1/ai/credits` | `ai:read` | 200 metadata only | 200 | 200 |
| `GET /v1/ai/budgets` | `ai:read` | 200 metadata only | 200 | 200 |
| `GET /v1/ai/runs` | `ai:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/ai/runs/:id` | `ai:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/ai/runs/:id/artifacts/:artifactId` | `ai:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/ai/runs/:id/events` | `ai:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/ai/sessions` | `ai:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/ai/sessions/:id/messages` | `ai:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/ai/approvals` | `ai:read` | 200 metadata only | 200 | 200 |
| `GET /v1/ai/approvals/:approvalId` | `ai:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/review` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/symbols` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/import-analysis` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/components` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/memory` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/policies/content-access` | `org:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/version-diff` | `builder:read` | 200 content (planted text returned) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:id/template-workspace` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/generation-plans/:id/context` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/builder/generation-plans/:id/timeline` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/builder/projects/:projectId/claude-code` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:projectId/files/search` | `builder:read` | 200 content (planted text returned) | 200 | **200 (GAP)** |
| `GET /v1/builder/github` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/github/repositories` | `builder:read` | 409 | 409 | 409 |
| `GET /v1/builder/projects/:projectId/instructions` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:projectId/instructions/versions` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:projectId/github` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/github/pulls` | `builder:read` | 409 | 409 | 409 |
| `GET /v1/builder/projects/:projectId/skills` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/skills/recommendations` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/ai-studio/settings` | `org:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/skills` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/generation-plans/:id` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/builder/projects/:projectId/test-runs` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:projectId/test-runs/:testRunId` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/builder/projects` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/files` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/files/content` | `builder:read` | 200 content (planted text returned) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:id/versions` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/previews` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:id/forms` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:id/form-submissions` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/builder/projects/:id/cms-collections` | `builder:read` | 200 content by design (fixture empty) | 200 | **200 (GAP)** |
| `GET /v1/deployments/policy` | `deploy:read` | 200 metadata only | 200 | 200 |
| `GET /v1/deployments` | `deploy:read` | 200 metadata only | 200 | 200 |
| `GET /v1/deployments/:id` | `deploy:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/deployments/:id/logs` | `deploy:read` | not exercised (needs a record or a feature) | 404 | 404 |
| `GET /v1/builder/templates` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/templates/:id` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |

The other 85 routes the role can reach (billing, usage, invoices, payments, email, hosting, domains, storage, databases, compliance, marketplace, workflows, organization and members) are listed in the JSON the spec writes; none returned the planted content, and the billing and usage routes are the role's purpose and must stay readable under `deny` (the spec asserts `/v1/ai/credits`, `/v1/ai/budgets`, `/v1/ai/models` stay 200). Routes under `/v1/mobile/*` (builds, releases, signing) need `mobile:*` permissions the role does not hold (403 by permission, not by policy).

## Gaps (content routes still readable under `deny`)

### Session 05: builder, app-builder, studio, deployments routes

- `GET /v1/builder/projects/:projectId/version-diff` (200 content (planted text returned))
- `GET /v1/builder/projects/:id/template-workspace` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:projectId/claude-code` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:projectId/files/search` (200 content (planted text returned))
- `GET /v1/builder/projects/:projectId/instructions` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:projectId/instructions/versions` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:projectId/test-runs` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:id/files/content` (200 content (planted text returned))
- `GET /v1/builder/projects/:id/previews` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:id/forms` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:id/form-submissions` (200 content by design (fixture empty))
- `GET /v1/builder/projects/:id/cms-collections` (200 content by design (fixture empty))

### Session 02: AI conversation routes


### Needs a record to exercise (static read; add to the same switch)

- `GET /v1/builder/projects/:projectId/test-runs/:testRunId` (test output and logs), `GET /v1/builder/generation-plans/:id`, `/context`, `/timeline` (the customer's generation prompts and context), `GET /v1/deployments/:id` and `/logs` (build and deployment logs): these answered 404 for everybody because no record exists in the audit fixture. They return customer content when a record exists and must be inside the switch; add a fixture when the owners wire them.

## What the switch must cover (proposal for Sessions 05 and 02)

- One shared check (the existing `ContentAccessService.assert(orgId, userId, role, operation, projectId)`) applied to every route above, with the operation names extended: `files`, `file_content`, `file_search`, `version_diff`, `exports`, `previews`, `forms`, `submissions`, `cms`, `instructions`, `test_runs`, `template_workspace`, `claude_code`, `generation`, and for Session 02 `ai_sessions`, `ai_messages`, `ai_runs`, `ai_run_events`, `ai_artifacts`. Only the `billing_admin` role is ever affected; every denial is audited (as today).
- Lists that carry only metadata (project list, version list, file path list, approvals list, credits, budgets, usage, billing) stay readable: the billing role needs them.
- `GET /v1/ai/runs` and `/v1/ai/runs/:id` return the run's pending-approval summary, step and error text: decide whether the summary counts as content (this audit treats the run result, events and artifacts as content and the approval summary as metadata).

## Tests

`qa-o9-content-access.int.spec.ts`: 6 passed + 1 expected-fail (after Session 02's fix `1ab896b9`; was 5 + 2). Passing: the audit itself (no 5xx, the fixture is not vacuous), the baseline (default allow: billing admin reads exactly what the owner reads on every reachable route), the five covered routes are 403 under deny, the control (other roles unaffected under deny, billing metadata still readable), and the table writer. Expected-fail (the secure expectation, fails today): `O-9 (Session 05 scope)`: under deny every builder content route answers 403 to a billing administrator. The Session 02 scope test is an ordinary test now (DEFECT-17 fixed: six AI routes 403 under deny, `allow` restores them, three runs). Flip the Session 05 test when its owner has extended the switch, and re-run to refresh this table.
