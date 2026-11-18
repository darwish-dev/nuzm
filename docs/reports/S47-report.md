# S47 — Deploy, rollback, export, gate path (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
`deploy/deployment.service.ts` (approvals, supply-chain gate, sandbox build, content-addressed artifact, health gate with auto-rollback, idempotent rollback, one live deployment per target+env), `deploy/ports.ts`, `archive.ts` (deterministic tar.gz), `export/export.service.ts` (scan-before-archive, lockfile mandatory, residency, third-party approval, SBOM, ≤15 min signed URL), migrations 1440/1441, controllers, OpenAPI, SDK.

## Tests (files; results in `M10-report.md` §E)
`builder-s47.int.spec.ts` (16 incl. export rebuilt from the archive and passing its own tests; supply-chain; approval matrix; cross-tenant), `appbuilder-http.int.spec.ts` (8: flag off, roles, idempotency, cross-tenant matrix over every endpoint).

## Not done / NOT VERIFIED / BLOCKED
Targets are ports; only the dev static target exists. The independent CRM suite is not authored: AC-M10-01 BLOCKED. Rollback p95 measured only on the dev target.

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.
