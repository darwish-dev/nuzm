# DEFECT-16 — the O-9 switch does not cover the builder routes that return project files, diffs, instructions, submissions and test results

Reporter: Session 07 (QA) · Owner: Session 05 (`apps/api/src/modules/appbuilder/**`) · cc Master · Severity: **MEDIUM** (a billing administrator can read customer SOURCE CODE and project content although the owner can switch that role's content access to `deny`; default stays allow) · Status: OPEN · Found 2026-11-24 (Master request: O-9 scope audit)

`builder.billing_admin_content_access = deny` is enforced by `ContentAccessService.assert` only in `builder-insight.controller.ts` (review, symbols, import-analysis, components, memory). The role seed gives `billing_admin` `builder:read`, so the routes below stay readable to it under `deny`. Evidence: `docs/security/O9-CONTENT-ACCESS-AUDIT.md`; test `qa-o9-content-access.int.spec.ts` (`it.fails('O-9 (Session 05 scope) …')`).

Routes (all `GET`, permission `builder:read`):
- `GET /v1/builder/projects/:projectId/version-diff` (content returned)
- `GET /v1/builder/projects/:id/template-workspace` (content by design, fixture empty)
- `GET /v1/builder/projects/:projectId/claude-code` (content by design, fixture empty)
- `GET /v1/builder/projects/:projectId/files/search` (content returned)
- `GET /v1/builder/projects/:projectId/instructions` (content by design, fixture empty)
- `GET /v1/builder/projects/:projectId/instructions/versions` (content by design, fixture empty)
- `GET /v1/builder/projects/:projectId/test-runs` (content by design, fixture empty)
- `GET /v1/builder/projects/:id/files/content` (content returned)
- `GET /v1/builder/projects/:id/previews` (content by design, fixture empty)
- `GET /v1/builder/projects/:id/forms` (content by design, fixture empty)
- `GET /v1/builder/projects/:id/form-submissions` (content by design, fixture empty)
- `GET /v1/builder/projects/:id/cms-collections` (content by design, fixture empty)
Not exercisable without a record (static read, also needed inside the switch): `GET /v1/builder/projects/:projectId/test-runs/:testRunId`, `/v1/builder/generation-plans/:id` (+ `/context`, `/timeline`), `/v1/deployments/:id` and `/v1/deployments/:id/logs`.
Expected: under `deny`, 403 for billing_admin only (audited, as today); every other role unchanged; metadata lists (project list, versions, file path list) stay readable.
Fix: call `ContentAccessService.assert` (extend the operation names) in each handler or in one guard keyed on a route decorator (`@ContentRoute('file_content')`).
