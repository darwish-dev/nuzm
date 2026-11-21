# SCR-K-01 — AI Intelligence Center: contracts, tables, permissions, flags (STATUS: APPROVED by the owner 2026-11-20, as drafted)

Companion of `docs/adr/ADR-065-ai-intelligence-center-knowledge-module.md` (ACCEPTED). The owner approved both as drafted on 2026-11-20 (reply "Approve as drafted"),
which covers the endpoint names and the single execution path in §1, the permission names and two-approver rule in §2 and the migration range `K: 1860-1899`.
The two files below are merged into `spec/` as the first step of slice S-K1.

| Draft | What it holds |
|---|---|
| `SCR-K-01-openapi-delta.yaml` | 26 paths / 30 operations, 33 schemas, new permissions, flags, error codes and audit events |
| `SCR-K-01-ownership-delta.yaml` | schema `knowledge`, 20 tables, tenant-less list, migration range `K: 1860-1899`, a data class for every column |

Checked on 2026-11-20 against the live spec: no path, `operationId` or schema name collides; every `$ref` resolves (existing `Problem`,
`OrgHeader`, `IdempotencyKey`, `Limit`, `Cursor` are reused). A merged copy passed `pnpm spec:lint` (2026-11-20).

> **Correction after approval (2026-11-20, implementation of S-K1):** the permission names are `admin:ai_knowledge:read|manage|publish` (underscore). The database
> constraint on `tenancy.permissions.name` allows only `[a-z_]` segments, so the hyphenated spelling in the approved draft cannot be stored. The meaning is unchanged.
> The upload session also stores `filename`, and `resource_search_documents` has a generated `tsv` column (both classified in `spec/db/ownership.yaml`).

## 1. Names: what the request asked for → what is proposed
CLAUDE.md §2: prompts must not rename endpoints or tables; `docs/04` conventions win. The request's names are therefore adapted.

| Request | Proposed | Why |
|---|---|---|
| `POST /admin/ai-resources/uploads` | `POST /v1/admin/knowledge/uploads` + `PUT …/parts/{n}` + `POST …/completion` + `DELETE …/{id}` | `/v1` prefix, admin realm; resumable upload and cancel need a session |
| `POST /admin/ai-resources/import/github` | `POST /v1/admin/knowledge/imports/github` | no token in the body; GitHub App (ADR-064) |
| `GET/PATCH /admin/ai-resources[/:id]` | `GET/PATCH /v1/admin/knowledge/resources[/{id}]` | |
| `POST …/:id/analyze`, `/reindex`, `/activate`, `/disable` | `POST …/analyses`, `…/reindexing`, `…/activation`, `…/deactivation` (+ `…/archival`, `…/reviews`) | `docs/04` uses nouns for actions (`/impersonation`) |
| `GET …/:id/components`, `/versions`, `/processing-jobs` | same sub-paths | |
| `GET /admin/ai-intelligence/analytics`, `/settings` | `GET /v1/admin/knowledge/analytics`, `GET/PATCH …/settings` | |
| (not in the request) | `GET/PUT /v1/admin/knowledge/defaults` | default resources by platform/framework/category/plan/mode |
| `GET /ai-builder/templates[/:id]` | `GET /v1/builder/templates[/{id}]` | existing `builder` tag and `builder:read` |
| `POST /ai-builder/templates/recommend` | `POST /v1/builder/template-recommendations` | noun |
| `POST /ai-builder/projects/from-template` | `POST /v1/builder/projects/from-template` | `Idempotency-Key` |
| `POST /ai-builder/projects/import` | `POST /v1/builder/projects/imports` | `Idempotency-Key`; tenant project, never the global library |
| `POST /ai-builder/generations/plan` | `POST /v1/builder/generation-plans`, `GET …/{id}` | |
| `POST /ai-builder/generations/execute` | **no new endpoint**: `POST /v1/ai/runs` with `kind: knowledge-generation` and `planId` | budgets, credits, metering, audit and cancellation already live in the run engine; one execution path |
| tables `ai_resource_*`, `ai_theme_*`, `ai_template_defaults`, `ai_generation_*` | schema `knowledge`: `resources`, `resource_versions`, `resource_files`, `resource_permissions`, `resource_manifests`, `resource_components`, `resource_dependencies`, `resource_relationships`, `resource_search_documents` (replaces `resource_embeddings`; the vector column is added only if the capability probe and D-47 allow), `processing_jobs`, `analysis_results`, `quality_scores`, `usage_events`, `theme_tokens`, `theme_variants`, `template_defaults`, `uploads`, `generation_plans`, `generation_resource_links`, `generation_evaluations` | ADR-004 schema-per-module |

## 2. New cross-cutting contracts
- **Platform permissions**: `admin:ai_knowledge:read` (view), `:manage` (upload, edit, analyze, reindex, disable, archive), `:publish` (activate, approve, defaults,
  settings, turning on AI processing for a resource). Two different staff accounts must approve activation of third-party or licensed resources.
- **Customer permissions** reused: `builder:read`, `builder:write`, `ai:read`, `ai:write`. No new customer permission.
- **Feature flags** (all default OFF): `knowledge.library`, `knowledge.customer_templates`, `knowledge.import_projects`, `knowledge.semantic_search`.
  A route behind an off flag answers 404 (same rule as AI Studio).
- **Error codes** (registry additions): `knowledge_resource_ineligible`, `knowledge_license_blocked`, `knowledge_archive_rejected`,
  `knowledge_upload_incomplete`, `knowledge_template_incompatible`, `knowledge_approval_required`.
- **Audit events**: 15 listed in the delta (upload, import, update, analyze, reindex, activate, disable, archive, review, default, settings, template copied, plan created).
- **Metering**: analysis and embedding model calls and the generation run use the central pipeline (ADR-013); no module bills directly.
- **Residency**: every resource has `data_region`; `ResidencyPolicyService` runs before any model or embedding vendor call.

## 3. Behaviour that the contract promises (and tests must prove)
1. A customer never receives file contents, object keys or manifest source excerpts of a platform resource, only metadata, compatibility facts,
   Design DNA summary and preview references; a resource that is not `ACTIVE`, published, licence-eligible and reuse-permitted is **404** to customers.
2. `from-template` copies a pinned immutable version into the project's own files; the template and its other copies are never modified.
3. `projects/imports` creates a tenant project; no request path, job or query writes tenant data into platform rows.
4. Uploads are resumable (`partsReceived`), verified by per-part and whole-object SHA-256, cancellable until completion, and quarantined until validation passes.
5. Activation never overwrites an active version; the previous version is retired and restorable.
6. Analytics return `null` (not an estimate) for any rate that has no underlying data; generation and build success rates are `null` until builds run (D-21).
7. Recommendation applies hard filters before ranking; a user-selected theme is honoured unless unavailable, unauthorised or incompatible, in which case
   `knowledge_template_incompatible` explains why and nothing is silently substituted.

## 4. Out of this SCR (explicitly)
- Any endpoint to execute uploaded code, to open a terminal into a library resource, or to preview an uploaded theme/project in a runtime (D-21).
- Embedding generation and semantic search endpoints (D-47); the flag `knowledge.semantic_search` is reserved only.
- The `ModelAdapter` tool-use extension (D-46) — a separate SCR to `docs/09`.
- Figma import (no product integration exists; owner decision first).
- Model training or fine-tuning of any kind.

## 5. Approval checklist for the owner
1. Accept, amend or reject ADR-065 (module `knowledge`, global-visibility RLS shape, object-store port, deterministic-first design).
2. Approve the endpoint names in §1 (or give different ones) and the single-execution-path decision (`/v1/ai/runs`).
3. Approve the permission names and the two-approver rule.
4. Answer D-41 … D-49 in `docs/07` (proposed defaults are listed there).
5. Confirm the migration range `K: 1860-1899`.

## 6. After approval (order of work, per CLAUDE.md §3)
1. Merge the OpenAPI fragment into `spec/openapi/openapi.yaml` and the ownership fragment into `spec/db/ownership.yaml`; run `pnpm spec:lint`, `pnpm spec:drift`,
   `pnpm sdk:generate`, `pnpm sdk:check`.
2. Migrations `1860+` with documented reversal; run `pnpm db:migrate`, `pnpm compliance:classification-coverage`, `compliance:ropa-coverage`, `compliance:residency-hooks`.
3. Slice S-K1 of `docs/ai-intelligence/AUDIT_AND_PLAN.md` §5: object-store port with the dev adapter, upload API, versioning, admin library shell, permissions, flags (off),
   RLS and cross-tenant tests for every query path.
4. Continue with S-K2 … S-K9 in order; each slice ends with a milestone-style report using the response format of CLAUDE.md §10.
