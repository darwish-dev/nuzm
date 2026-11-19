# S47 — Deploy, rollback, export, gate path (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
`deploy/deployment.service.ts` (approvals, supply-chain gate, sandbox build, content-addressed artifact, health gate with auto-rollback, idempotent rollback, one live deployment per target+env), `deploy/ports.ts`, `archive.ts` (deterministic tar.gz), `export/export.service.ts` (scan-before-archive, lockfile mandatory, residency, third-party approval, SBOM, ≤15 min signed URL), migrations 1440/1441, controllers, OpenAPI, SDK.

## Tests (files; results in `M10-report.md` §E)
`builder-s47.int.spec.ts` (16 incl. export rebuilt from the archive and passing its own tests; supply-chain; approval matrix; cross-tenant), `appbuilder-http.int.spec.ts` (8: flag off, roles, idempotency, cross-tenant matrix over every endpoint).

## Not done / NOT VERIFIED / BLOCKED
Targets are ports; only the dev static target exists. The independent CRM suite is not authored: AC-M10-01 BLOCKED. Rollback p95 measured only on the dev target.

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.

## Finish session: deployments and export on the real M09
- `/v1/deployments` (M09's paths) dispatches web-app projects to `AppDeploymentService`; the target is a hosting site published through M09's `SitePublisherPort` (`SitePublisherDeployTarget`): **only the static front end (`public/`) is published**; the Node back end and the database migrations have no compute path (migrations stay pending, a destructive one still needs its approval). Staging deploy → live, failed health gate → previous release restored automatically, rollback restores the earlier release (idempotent replay), production needs hash-bound approvals (403 `approval_required`, decided in the inbox), foreign/unknown target 404, `instance` targets 404. **PASS on the in-memory fake publisher; live hosting NOT VERIFIED** (no real publish path exists: HG-05-01/02, HG-06-01).
- Export of a real builder project: blocked without a lockfile (supply-chain gate, 422 `export_blocked`), 202 once the lockfile arrived through the changes pipeline. Release/export storage is still the in-memory `MemoryReleaseStore` (A-07 OPEN): a restart loses release archives.
- Reference CRM through the independent suite, D-21 and HG-10-02: BLOCKED (human items), unchanged.
