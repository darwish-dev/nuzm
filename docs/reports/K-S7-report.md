# AI Intelligence Center — slice S-K7 report (customer gallery and start from a template)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (S-K1 … S-K5 preserved, latest `23a9b45`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; behind the organization flag `knowledge.customer_templates` (default OFF); no model is called and nothing is executed; production stays BLOCKED on D-42**.
Governing documents: ADR-065 (addendum G), SCR-K-08 (`docs/spec-change-requests/SCR-K-08-customer-templates.md`), SCR-K-01 §3 (customer boundary, approved via D-41), D-48.

## A. Repository findings and assumptions
- The foundation already had the customer tables (`usage_events`, `generation_plans`, `generation_resource_links`, forced RLS) and `v_published_templates`, but the view exposed a manifest key (`designDna`) that S-K4 no longer writes, and no file road existed for customers.
- **Scope decision (my reading, please confirm):** the S-K7 plan lists gallery, start-from-template, import, adaptation modes and chat on the current state. This slice delivers gallery, one template, suggestions, start from a template with the three adaptation modes, and generation plans. **Customer import** is not built (the ingestion pipeline is platform-admin only and production is blocked on D-42); **chat on the current project state** and **plan execution** need a model and the run engine (S-K6).
- A "copy" is a copy of the pinned immutable version into a NEW web-app project through the existing safe-change pipeline; I raised the patch limit only for the first change of an empty project.
- Existing browser spec `01-customer.spec.ts` currently FAILS at its first assertion in this tree (the sign-up flow now goes straight to "Create an organization"); it is not touched by this slice. The new E2E creates its own organization through that screen and does not depend on it. **Pre-existing, reported, not fixed.**
- Environment: this worktree's Postgres :54339, E2E ports 3300/3301/4300/4310, a temporary longer-timeout Playwright config (deleted afterwards); the machine was heavily loaded.

## B. Plan and changed files
- DB: `packages/db/migrations/knowledge/1866__knowledge__customer_templates(.down).sql`; `packages/db/src/knowledge-rls.int.spec.ts`.
- API: `knowledge/internal/customer-templates.service.ts`, `knowledge/customer-templates.controller.ts`, `knowledge/internal/flag.ts` (guard), `knowledge.module.ts`, `index.ts`; `appbuilder/internal/studio/template-start.ts`, `appbuilder/template-start.controller.ts`, `appbuilder.module.ts`, `appbuilder/internal/changes/change.service.ts` (patch limit option); tests in `knowledge/review.int.spec.ts`.
- Spec: `spec/openapi/openapi.yaml` (+6 operations, schemas), `packages/sdk/src/schema.ts` (regenerated).
- Web: `app/[locale]/(console)/builder/templates/page.tsx` and `[id]/page.tsx`, `components/Templates.tsx`, `TemplateRecommend.tsx`, `TemplateStart.tsx`, `lib/templates.ts`, link on the start screen (`BuilderStart.tsx`, `builder-projects-screen.tsx`), nav entry (`lib/nav.ts`), 78 message keys in both languages; specs `lib/templates.spec.ts`, `components/Templates.spec.tsx`, `lib/nav.spec.ts`.
- E2E: `e2e/tests/16-ai-templates.spec.ts`; 14 new screenshots (ar/en).
- Docs: this report, SCR-K-08, ADR-065 addendum G.

## C. Implemented
1. **Gallery and one template** (`GET /v1/builder/templates[/{id}]`): published platform templates and the organization's own, with compatibility facts, allowed reuse, licence, capability names, a safe design summary, filters and cursor paging. Nothing locating source is ever returned; an ineligible template is a 404 identical to a missing one.
2. **Suggestions** (`POST /v1/builder/template-recommendations`): the S-K5 engine for a customer, sanitised (no exclusion list, no document text); a user's choice is honoured or explained and never substituted; top three results recorded as the customer's own usage events.
3. **Start from a template** (`POST /v1/builder/projects/from-template`): eligibility re-checked for the adaptation mode at copy time, pinned version checked, files read through the guarded view from the object store and digest-verified, validated by the shared safety checks, then a new web-app project and one Git commit; binary, unstored and oversized files are skipped and listed; usage, link and audit recorded; idempotent.
4. **Generation plans** (`POST|GET /v1/builder/generation-plans`): requirement and deterministic selection recorded for the organization's own project; execution reported `BLOCKED`.
5. **Customer UI** (Arabic and English, RTL): gallery with filters and a suggestion box, template detail with the start form, result panel (licence reminder, skipped files), states loading-free server rendering, empty, filtered-empty, error by reason, forbidden, not available, read-only. A link appears on the start screen only while the flag is on.

## D. Migrations and rollback
`1866__knowledge__customer_templates.sql`: `v_published_templates` gains `component_count`, `license_spdx`, `capabilities` (names only) and a safe `design_dna`; new `v_template_copy_files` (empty unless the transaction names one eligible version). Reversal in `.down.sql` (dev/staging; production forward-fix). Behaviour rollback: the flag (default off).

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| DB integration (`@nuzm/db`, incl. `knowledge-rls.int.spec.ts`: copy view, safe design summary, usage/plan isolation) | **5 files, 100 passed** |
| Worker integration (real PostgreSQL) · platform integration | **92 passed** · **32 passed** |
| API integration, knowledge + app builder | **11 files, 190 passed** (customer suite: 9 new tests) |
| Customer suite covers | flag off by default and per organization (404 everywhere), gallery metadata and no-source assertions, filters and paging, 404 indistinguishable for unpublished/unknown/malformed, suggestions sanitised and recorded, user choice honoured/explained, copy into a new web-app project with files verified in the project, idempotent replay, second copy independent, cross-tenant isolation, refusals that leave nothing behind (unpublished, wrong mode, changed pin, taken name, secret in template, missing object, altered object, validation), plans (permissions, isolation, execution blocked), no model calls |
| Web unit | `templates.spec.ts`, `Templates.spec.tsx`, `nav.spec.ts`: **47 passed** (helpers, gallery, detail, start form incl. idempotency key behaviour, suggestions) |
| Domain unit 804 · i18n 9 · ui 24 · db 55 · adapters | passed |
| Admin upload spec, worker parser-sandbox spec, API load-runner spec | each FAILED once during a full parallel run while the machine was saturated (timeouts), and **passed alone**: 22, 35 and 7 tests. None of these files is touched by this slice |
| Browser E2E `16-ai-templates.spec.ts` (Arabic + English, real browsers) | **6/6 passed**, axe WCAG A/AA clean on every screen: flag off, gallery, filters, suggestion, template detail, start from template (files copied, database rows checked), refusal on a taken name, unpublished = unavailable; no page contains a path, key, file text or token name |
| Migration reversal (1866 down, then up again) | PASS on a scratch database: views and columns 1/3 → 0/0 → 1/3 |
| `db:test-rls`, classification coverage (3354 columns), ropa coverage, residency hooks, `spec:lint`, `spec:drift` (498 routes), `sdk:check`, `compliance:claims-guard` | PASS |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched); my own test fixture builds its fake key at run time |
| `pnpm lint` (eslint + prettier), `pnpm typecheck` (52/52), `pnpm build` (28/28) | PASS (lint first failed on a restricted import, an unused variable and formatting of my own files; all fixed and re-run) |
Not run: `pnpm verify:full`; the full API integration suite (only the knowledge and app-builder subset); `01-customer.spec.ts` (fails before reaching anything of this slice, see A).

## F. Security, tenant isolation, billing, residency
- Customers read platform resources only through the two views; base tables stay closed (tested with the copy setting on). The copy view is empty unless the transaction names the version and returns only stored text files of an eligible published version; it stops the moment the template is disabled, its licence changes or reuse is switched off.
- The design summary is built in SQL from fixed keys: no path, evidence, token name or manifest fragment can pass (tested with planted markers). UI output is also checked for paths, keys and file text in the browser.
- Copy safety: digest verification, path, secret, canary, size and dependency checks; a template with a secret or a tampered object creates nothing; the project is created only after validation and removed if the change fails.
- Usage, plans and links are tenant rows with forced RLS; usage is append-only; a forged organization is refused; cross-tenant reads return nothing.
- Billing, metering, residency: no vendor or model call; project creation uses the existing residency and quota checks. Copy is a data operation and is not metered in this slice.
- Known gaps: the 404-for-ineligible rule hides existence, but response timing is not equalised; the safe design summary shows hex colours and font names a customer could also see in the preview of any theme.

## G. Human gates and live checks still needed
- **D-42 (BLOCKS production)** unchanged: object storage and the production activation of any knowledge feature.
- **S-K6 / model:** plan execution, generation from a template and chat on current state need the run engine and a model (D-46); nothing here claims otherwise.
- **Customer import:** needs the owner's decision on opening ingestion to tenants (D-42 first).
- D-21 (previews and screenshots), D-45 (Dart grammar), D-47 (embeddings) unchanged.

## H. Acceptance checklist (S-K7 criteria)
| Criterion | Status |
|---|---|
| Customer gallery over `v_published_templates` only, no source locators | PASS |
| Start from a template: pinned version, safe pipeline, new project, template untouched | PASS |
| Adaptation modes STRICT / ADAPTIVE / CREATIVE enforced at copy time | PASS |
| Suggestions for customers, user choice never substituted | PASS |
| Usage, plan and link records, audit, idempotency, tenant isolation | PASS |
| Arabic/English UI with e2e, axe, screenshots; states; flag default off | PASS |
| Customer import of own project | NOT BUILT (D-42) |
| Chat on current project state; plan execution; generation | NOT BUILT / BLOCKED (S-K6, D-46) |
| Live/production behaviour | BLOCKED (D-42) |

## I. Handoff
Next: S-K6 (orchestration over the run engine, coding agent through a tool-use adapter extension, D-46) will consume generation plans and the copy; the evaluation of D-48 weights can start from the usage rows recorded here. Open for the owner: confirm the S-K7 scope reading (import deferred); D-46; D-42 items; the stale `01-customer.spec.ts`.
