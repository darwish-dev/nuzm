# S43 — Schema/backend agents (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
`gen/sql.ts` (reversible migrations, expand/contract diff, destructive detector; a rename is never guessed), `gen/openapi.ts` (OpenAPI 3.1 of the generated app), `gen/rbac.ts`, `gen/tests-gen.ts` (contract/RBAC/scope/validation tests), `policy/dependencies.ts` (ecosystem allow-list, lockfile, install scripts, advisory port, typosquat, licence, growth cap, CycloneDX SBOM).

## Tests (files; results in `M10-report.md` §E)
`sql.spec.ts` (18), `dependencies.spec.ts` (10), `project.spec.ts`, `generated-app.int.spec.ts` (generated app type-checks under strict TS, builds, passes its own tests on the in-memory AND PostgreSQL stores, migration up/down/up, its OpenAPI passes the Nuzm Spectral ruleset).

## Not done / NOT VERIFIED / BLOCKED
Generated stack: Node 22 (type stripping) + TypeScript 5.9 + pg 8 (ranges; the lockfile is created in the sandbox through the mirror — not available offline, so tests use a SYNTHETIC lockfile). The advisory feed is not connected.

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.

## Finish session: artifacts on the real M09
`db_schema` / `api_contract` / `app_spec` artifacts are stored in `ai.artifacts` (migration 1801 adds the kinds) and served by M09's `GET /v1/ai/runs/{id}/artifacts/{artifactId}`; the UI reads the schema, API and access views from them. No change to the generators. PASS (`m09-real.int.spec.ts`).
