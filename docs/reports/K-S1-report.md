# AI Intelligence Center — slice S-K1 report (library foundation)

Date: 2026-11-20 · Branch `claude/run-it-dc3d6a` · Status: **PARTIAL — backend and database DONE and verified; admin UI NOT STARTED.** Nothing is committed.
Governing documents: `docs/adr/ADR-065-ai-intelligence-center-knowledge-module.md` (ACCEPTED 2026-11-20), `docs/spec-change-requests/SCR-K-01-ai-intelligence-center.md`
(APPROVED 2026-11-20), audit and plan `docs/ai-intelligence/AUDIT_AND_PLAN.md`.

## A. Repository findings and assumptions
- Findings are in the audit. Assumptions recorded while implementing:
  1. **Settings endpoints are deferred to S-K5.** The approved 20-table model has no settings table; storing weights and limits needs one more table or a decision. Upload limits are constants
     (platform hard caps) until then. `GET/PATCH /v1/admin/knowledge/settings` stay in `spec/openapi/planned-paths.yaml`.
  2. **Permission names use underscores** (`admin:ai_knowledge:*`): `tenancy.permissions.name` allows only `[a-z_]` segments. Recorded as a correction in SCR-K-01.
  3. **A completed upload stays QUARANTINED.** Validation, extraction and analysis are S-K2; nothing reads inside an uploaded archive yet.
  4. **Default data region** of a new resource is `sa-central` unless the upload says otherwise; the residency hook `k-knowledge-library` is registered as `listed` (not yet enforced).
  5. The decisions D-41 … D-49 were recorded as DECIDED on the owner's "Approve as drafted"; D-46 (model tool use) stays OPEN. Interim defaults (D-42, D-43, D-44, D-47) keep their reviews open.

## B. Plan and changed files
- New module `apps/api/src/modules/knowledge/` (`knowledge.module.ts`, `admin-knowledge-uploads.controller.ts`, `admin-knowledge-resources.controller.ts`,
  `internal/{model,object-store,upload.service,resource.service,flag}.ts`, `index.ts`) registered in `apps/api/src/app.module.ts`; `app.setup.ts` parses `application/octet-stream` (64 MiB cap).
- Migration `packages/db/migrations/knowledge/1860__knowledge__library_foundation.sql` (+ `.down.sql`), range `K: 1860-1899`.
- Spec: `spec/openapi/openapi.yaml` (+11 operations, 15 schemas), `planned-paths.yaml` (+17 planned), `spec/openapi/errors.yaml` and `apps/api/src/common/errors.ts` (+6 codes),
  `spec/db/ownership.yaml` (schema, tenant-less list, migration range, 292 classified columns, 4 justified exceptions), `spec/compliance/residency-hooks.yaml`, `packages/sdk/src/schema.ts` (regenerated).
- Supporting: `packages/db/src/residency-hooks.ts` (accepts milestone `K`), `apps/api/src/platform-scope.spec.ts` (allow-list), `apps/api/src/modules/ai/testing/ai-harness.ts` (admin helper takes PUT/PATCH/DELETE and binary bodies),
  `.env.example`, `docs/07` (D-41 … D-49), ADR-065 and SCR-K-01 status.

## C. Implemented
- **Upload API** (5 operations): open a resumable session, put parts (SHA-256 per part, out of order, idempotent re-send, size cap), read the session (resume), cancel, complete
  (contiguous part list, declared size, whole-object SHA-256; content-addressed archive; deduplicated by checksum; lazy expiry).
  File names are allow-listed (`.zip .tar.gz .tgz .md .markdown .txt .pdf .docx .json .yaml .yml .png .jpg .jpeg .webp`); paths, hidden names, control characters, scripts, executables and SVG are refused.
- **Resources API** (6 operations): list with filters and cursor paging, get (metadata, permissions, current version, manifest summary with evidence, quality scores, jobs), patch with `If-Match`,
  versions, disable, archive (soft delete). The licence verdict and identity are not editable; publish-only changes (publish, default-eligible, AI processing) need `admin:ai_knowledge:publish`.
- **Object-store port** `KnowledgeObjectStore` with a development filesystem adapter; production gets an "unconfigured" adapter that answers 404 (no silent local-disk use).
- **Flag** `knowledge.library` (global, default OFF): every route answers 404 while off.
- **Audit**: opened, completed, cancelled, updated (before/after), disabled, archived; no package bytes or secrets in events.
- **Not built (by design of this slice)**: ingestion stages, analysis, manifests, components, retrieval, recommendation, GitHub import, settings, defaults, analytics, customer endpoints, admin UI.

## D. Migrations and rollback
`1860__knowledge__library_foundation.sql`: schema `knowledge`, 20 tables, 3 permissions and role grants (`platform_admin`: read/manage/publish; `security`: read/publish; `support` and `compliance_officer`: read),
RLS enabled and forced on every table, guard triggers, `knowledge.v_published_templates` (definer view with `security_barrier`). Reversal: `.down.sql` (development/staging only; production is forward-fix, as for ADR-064).

## E. Tests run (actual results)
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/db exec vitest run --config vitest.integration.config.mts` | 4 files, 66 tests passed (includes the new `knowledge-rls.int.spec.ts`: 23 tests) |
| `pnpm --filter @nuzm/db exec vitest run` | 5 files, 55 tests passed |
| `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/knowledge/knowledge.int.spec.ts` | 34 tests passed |
| `pnpm --filter @nuzm/api test` | 71 files, 1054 tests passed (includes 40 new unit tests) |
| `pnpm lint` | passed (eslint + prettier) |
| `pnpm spec:lint`, `spec:drift` (468 routes), `sdk:check`, `scan:secrets`, `compliance:claims-guard` | passed |
| `pnpm compliance:classification-coverage`, `compliance:ropa-coverage`, `compliance:residency-hooks` (migrated throwaway DB) | passed |
| `pnpm --filter @nuzm/api test:integration` (whole API suite) | 1931 passed, 3 failed, 2 skipped. None is caused by this slice: `builder.int.spec.ts` (preview origin) and `mobile.int.spec.ts` (signing refs) passed when re-run alone (50/50) and are load-related flakes in the full run; `programs.int.spec.ts` (delegated-header sweep) failed on the untouched baseline too because AI Studio's signature-authenticated `/v1/webhooks/github` answers 401 to anonymous callers. That sweep now skips `/v1/webhooks/*` and passes (18/18) |

## F. Security, tenant isolation, billing, residency verification
- **Isolation (PASS, evidence: `knowledge-rls.int.spec.ts`)**: a tenant session reads only its own rows from every base table; no policy exposes platform rows; B cannot see A; writes of platform rows or other orgs' rows are refused;
  the worker and reporting roles cannot write; the published view lists only ACTIVE + published + licence-ALLOWED + reuse-permitted versions, never exposes archive/snapshot/object keys, file paths, manifests or source excerpts,
  and drops a template when it is disabled, its licence changes or reuse is switched off.
- **Integrity (PASS)**: versions immutable, resources keep identity/owner/type/region, files/manifests/analysis/quality/usage/evaluations append-only (grants and triggers), ACTIVE requires an ALLOWED licence, one ACTIVE version per resource,
  a quality score exists only with its evidence, money requires a currency.
- **Upload safety (PASS for what exists)**: allow-listed names, size cap, per-part and whole-object checksums, no execution or extraction. **Not covered here**: archive-content safety (zip bombs, traversal inside archives,
  symlinks, secret and licence scan) is S-K2 and is **NOT VERIFIED / NOT IMPLEMENTED**.
- **Billing/metering**: no billable action exists in this slice. **Residency**: hook registered, not enforced (NOT VERIFIED).

## G. Human gates and live checks still needed
D-42 (object-store provider; production refuses the dev adapter), D-43 counsel review before any commercial theme, D-44 (malware scanning engine; none claimed), D-46 (model tool-use SCR), D-47, D-18 / HG-09-01, D-21, HG-AS-01.

## H. Acceptance checklist (this slice)
| Row | Status |
|---|---|
| Admin can upload and manage real source projects (API) | PASS (API); UI NOT STARTED |
| Uploaded resources securely validated | PARTIAL: upload-level checks PASS; archive-level validation NOT STARTED (S-K2) |
| Projects analysed / theme DNA / retrieval / recommendation / generation | NOT STARTED |
| Customers isolated from the platform library at database level | PASS (database tests); customer endpoints NOT STARTED |
| Existing AI Builder functionality remains operational | PASS: API unit suite and the whole API integration suite (see section E for the three non-slice failures) |

## I. Next
S-K1 UI (admin Library list, detail, upload with progress/cancel; Arabic + English; e2e + screenshot), then S-K2 (ingestion state machine, safe extraction, scans, job monitor). Open: D-46, the settings storage decision for S-K5.
