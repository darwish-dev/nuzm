# CONTRACT-2 — requirement planning, review, code search and project memory endpoints

- Requester: Session 05 · Contract: `spec/openapi/openapi.yaml` (+ SDK regeneration) · Status: PROPOSED · No migration, no new table (project memory is the file `nuzm.memory.json` in the project, written through the existing safe-change pipeline).
- Why: priorities 2, 4 and 5 of SESSION-05 are implemented as pure domain code (`packages/domain/src/ai/agent-tools/builder/**`) and a thin service `apps/api/src/modules/appbuilder/internal/changes/builder-insight.service.ts` (5 tests). The customer UI needs endpoints to show a plan, a review, search results and memory.
- Additive: yes (new operations only). All behind flag `builder_tools.enabled` (default OFF; 404 when off), permissions `builder:read` (reads) and `builder:write` (memory writes), org-scoped.
- Data handling: planning, review, search are computed locally from the customer's own text/files. NOTHING is sent to a model or a vendor, so no residency decision, no credit and no AI-processing consent applies. Memory writes are made as the signed-in person (`source: user`, audited `builder.memory.changed` plus the usual `builder.change.applied`).
- Apply together with the parked controller `apps/api/src/modules/appbuilder/pending-contracts/builder-insight.controller.ts.pending` (rename to `…/appbuilder/builder-insight.controller.ts`, register `BuilderPlanController` and `BuilderInsightController` in the module's `controllers`; the `BuilderInsightService` provider is already registered). Memory `POST`/`DELETE` should also carry `@Idempotent()` when applied.

## Operations (paths under `paths:`)
| Method + path | operationId | Permission | Body / query | 200/201 body |
|---|---|---|---|---|
| `POST /v1/builder/plan-previews` | `previewBuilderPlan` | builder:read | `{text (≤20000 chars), hint?: ProductType, repairRounds?: 0..3}` | `{plan: ImplementationPlan, estimate: PlanEstimate, estimateNote}` |
| `GET /v1/builder/projects/{id}/review` | `reviewBuilderProject` | builder:read | – | `{versionId, findings: Finding[], summary: {passed, errors, warnings, infos}}` |
| `GET /v1/builder/projects/{id}/symbols` | `searchBuilderSymbols` | builder:read | `q` (1–100), `kind?` (function/class/const/type/interface/enum) | `{query, symbols: SymbolHit[]}` |
| `GET /v1/builder/projects/{id}/import-analysis` | `analyzeBuilderImports` | builder:read | – | `{unresolved[], missingPackages[], unusedDependencies[], cycles[][], files, truncated}` |
| `GET /v1/builder/projects/{id}/components` | `listBuilderComponents` | builder:read | – | `{components: {name, path, line, importedBy}[]}` |
| `GET /v1/builder/projects/{id}/memory` | `getBuilderMemory` | builder:read | – | `{path, entries: MemoryEntry[], total, limits}` |
| `POST /v1/builder/projects/{id}/memory` | `addBuilderMemory` | builder:write | `{kind: decision/convention/preference/fact/issue, text (≤400), pinned?, baseVersion?}` | 201 `{entry, change: ChangeResult \| null}` (`change: null` = an identical note already existed) |
| `DELETE /v1/builder/projects/{id}/memory/{entryId}` | `forgetBuilderMemory` | builder:write | – | `{change: ChangeResult}` |

Errors: 404 flag off / project not in the organization; 422 `validation_failed` (bad input, secret in a note), 422 `unsupported_capability` (website project), 409 `base_mismatch`, 409 `conflict` (memory file damaged; never overwritten), 404 `not_found` (note id).
Schemas to add (shapes are the exported TypeScript types and are stable for `0.1`): `ImplementationPlan`, `PlanEstimate` (`builderTools.planning.ImplementationPlan`, `builderTools.PlanEstimate`), `Finding`, `SymbolHit`, `MemoryEntry`. Bilingual strings are `{en, ar}`. Finding `code`s are stable identifiers the UI translates (i18n keys `bt.finding.<code>`); a finding never quotes file content.

## Tests
API service spec 5 tests; domain specs (planning 16 + 33, review/repair 21, context 15). Controller/HTTP integration tests are NOT written yet (they need the controller registered): heavy-run request in REPORT-05.

## Master answer
ACCEPTED by the Master (S01) with temporary authorization for Session 05 to apply its own patch. Applied on `feature/ai-builder-tools`: operations added to `spec/openapi/openapi.yaml` (path parameter named `{projectId}` to match the controllers; `@Idempotent()` on the POST writes), controllers un-parked and registered in `appbuilder.module.ts`, SDK NOT regenerated (Master regenerates once).
