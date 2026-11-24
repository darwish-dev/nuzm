# O-9 content-access audit: what a billing administrator can read

Session 07 (QA) · 2026-11-24 · evidence: `apps/api/src/qa/qa-o9-content-access.int.spec.ts` (own PostgreSQL, real RLS and role seed, SIMULATED model; nothing leaves the process). Re-run: `O9_AUDIT_OUT=/tmp/o9.json pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/qa/qa-o9-content-access.int.spec.ts`.

## Result in one paragraph

The owner's O-9 intent is that a billing administrator must not read customer SOURCE CODE, FILES or AI CONVERSATIONS. The role seed gives `billing_admin` `ai:read` and `builder:read`, so it holds the permission for **136 organization GET routes**, and **79** of them answered 200 in the audit organization. **25 of them return customer content** (6 proven by planted text, 19 by design with an empty fixture). The switch `builder.billing_admin_content_access = deny` now covers **all 25 content routes the audit exercises**: the 5 builder-tools reads and (Session 05, `b3887609`) version-diff, file content and search, template workspace, Claude-code, instructions (+versions), test runs, previews, forms, form submissions and CMS collections; (Session 02, `1ab896b9`) the six AI conversation, run, event and artifact routes; (Session 06, `da94e933`) deployment records and logs. **No content route answers 200 under `deny`.** Each fix was re-tested by this audit. The default stays `allow` = today's behaviour and the flag value shape `{mode}` is unchanged.

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
| `GET /v1/builder/projects/:projectId/version-diff` | `builder:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/builder/projects/:id/template-workspace` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/generation-plans/:id/context` | `builder:read` | not exercised (needs a record or a feature) | 404 | **403** |
| `GET /v1/builder/generation-plans/:id/timeline` | `builder:read` | not exercised (needs a record or a feature) | 404 | **403** |
| `GET /v1/builder/projects/:projectId/claude-code` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/files/search` | `builder:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/builder/github` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/github/repositories` | `builder:read` | 409 | 409 | 409 |
| `GET /v1/builder/projects/:projectId/instructions` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/instructions/versions` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/github` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/github/pulls` | `builder:read` | 409 | 409 | 409 |
| `GET /v1/builder/projects/:projectId/skills` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:projectId/skills/recommendations` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/ai-studio/settings` | `org:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/skills` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/generation-plans/:id` | `builder:read` | not exercised (needs a record or a feature) | 404 | **403** |
| `GET /v1/builder/projects/:projectId/test-runs` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:projectId/test-runs/:testRunId` | `builder:read` | not exercised (needs a record or a feature) | 404 | **403** |
| `GET /v1/builder/projects` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/files` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/files/content` | `builder:read` | 200 content (planted text returned) | 200 | **403** |
| `GET /v1/builder/projects/:id/versions` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/projects/:id/previews` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:id/forms` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:id/form-submissions` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/projects/:id/cms-collections` | `builder:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/deployments/policy` | `deploy:read` | 200 metadata only | 200 | 200 |
| `GET /v1/deployments` | `deploy:read` | 200 metadata only | 200 | 200 |
| `GET /v1/deployments/:id` | `deploy:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/deployments/:id/logs` | `deploy:read` | 200 content by design (fixture empty) | 200 | **403** |
| `GET /v1/builder/templates` | `builder:read` | 200 metadata only | 200 | 200 |
| `GET /v1/builder/templates/:id` | `builder:read` | not exercised (needs a record or a feature) | 404 | 404 |

The other 85 routes the role can reach (billing, usage, invoices, payments, email, hosting, domains, storage, databases, compliance, marketplace, workflows, organization and members) are listed in the JSON the spec writes; none returned the planted content, and the billing and usage routes are the role's purpose and must stay readable under `deny` (the spec asserts `/v1/ai/credits`, `/v1/ai/budgets`, `/v1/ai/models` stay 200). Routes under `/v1/mobile/*` (builds, releases, signing) need `mobile:*` permissions the role does not hold (403 by permission, not by policy).

## Gaps (content routes still readable under `deny`): none

### Session 05: builder, app-builder, studio, deployments routes


### Session 02: AI conversation routes


### Not exercised by this audit (need a record the fixture cannot create)
- `GET /v1/builder/projects/:projectId/test-runs/:testRunId`, `GET /v1/builder/generation-plans/:id` (+ `/context`, `/timeline`): Session 05's own test (`builder-policy-route.int.spec.ts`) proves them 403 under `deny` with a planted marker absent; they answered 404 here because no record exists in this fixture. Deployment detail and logs are now exercised (a SIMULATED deployment was created) and are 403 under `deny`.

## Open owner question (not a defect)
Do the approvals list (`GET /v1/ai/approvals`, `/approvals/:id`) and the run's pending-approval summary text count as customer content? This audit treats them as **metadata** (the action summary carries readiness, target, blockers and version ids, no source text) and leaves them readable to billing administrators under `deny`. If the owner decides they are content, they need the same guard; the approvals routes live in the app-builder module (Session 05).

## What the switch must cover (proposal for Sessions 05 and 02)

- One shared check (the existing `ContentAccessService.assert(orgId, userId, role, operation, projectId)`) applied to every route above, with the operation names extended: `files`, `file_content`, `file_search`, `version_diff`, `exports`, `previews`, `forms`, `submissions`, `cms`, `instructions`, `test_runs`, `template_workspace`, `claude_code`, `generation`, and for Session 02 `ai_sessions`, `ai_messages`, `ai_runs`, `ai_run_events`, `ai_artifacts`. Only the `billing_admin` role is ever affected; every denial is audited (as today).
- Lists that carry only metadata (project list, version list, file path list, approvals list, credits, budgets, usage, billing) stay readable: the billing role needs them.
- `GET /v1/ai/runs` and `/v1/ai/runs/:id` return the run's pending-approval summary, step and error text: decide whether the summary counts as content (this audit treats the run result, events and artifacts as content and the approval summary as metadata).

## Tests

`qa-o9-content-access.int.spec.ts`: 7 passed, 0 expected-fail, three consecutive runs. Passing: the audit itself (no 5xx, the fixture is not vacuous), the baseline (default allow: billing admin reads exactly what the owner reads on every reachable route), the five covered routes are 403 under deny, the control (other roles unaffected under deny, billing metadata still readable), and the table writer. The two former expected-fail tests (Session 05 and Session 06 scope; Session 02 scope) are ordinary tests: under `deny` every content route answers 403 to a billing administrator, and `allow` restores each of them (asserted). Before each flip the unflipped `it.fails` failed with "Expect test to fail".
