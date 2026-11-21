# AI Intelligence Center — slice S-K6 report (adapting a copied template)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (S-K1 … S-K7 preserved, latest `4695186`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; behind the organization flag `knowledge.generation` (default OFF); model use is the run engine's, metered, and its QUALITY is NOT VERIFIED; the coding agent / tool use (D-46) is NOT built; production stays BLOCKED on D-42**.
Governing documents: ADR-065 (addendum H), SCR-K-09 (`docs/spec-change-requests/SCR-K-09-template-adaptation.md`), AUDIT_AND_PLAN §4 and §6, D-46 (open), D-48.

## A. Repository findings and assumptions
- **Plan scope:** the plan row for S-K6 reads "orchestration: plan, context assembly, workspace copy/diff, integration with run engine; coding agent only via a tool-use adapter extension. Plan/copy yes; model use B". Workspace copy shipped in S-K7. This slice delivers the plan lifecycle, the workspace diff, context assembly with a customer-visible preview, and ONE integration point with the run engine. The coding agent is not built: D-46 (tool-use extension and tool set) is OPEN and needs your decision.
- **Finding that shaped the design:** the existing `webapp` graph (requirements → architecture → database → … → assembled project) commits a whole generated file set as the next project version. Pointed at a template copy it would REPLACE the customer's files. It is therefore not used on copies. Instead the same run kind gets a second mode (`input.templatePlanId`): one structured model call that proposes add/modify/delete patches, applied through the existing safe-change pipeline on the AI branch only. **This is a design decision worth your review**: it gives a real, safe end-to-end without tool use, but its capability is deliberately limited (no on-demand file fetch, no building or running anything).
- **Why not a new run kind:** `ai.runs.kind` is a CHECK constraint owned by the AI module (M09); a new kind would be a cross-module schema change. Reusing `webapp` stays inside M10's own handler.
- **Rule 5 (source to a model) interpretation:** files that are still byte-identical to the template are "the template's source": sent to a model only if the template's `ai_processing` permission is true (otherwise paths and sizes only). Files the customer added or changed are the customer's own work and always eligible. A template that is gone cannot vouch for its permission: treated as "not allowed". My reading; changing it is a policy decision.
- Copies made in S-K7 before migration 1867 have no baseline and show "not copied from a template" (dev only; nothing is in production).
- Environment: Postgres :54339, E2E ports 3300/3301/4300/4310, a temporary longer-timeout Playwright config (deleted afterwards).

## B. Plan and changed files
- Domain (pure): `packages/domain/src/knowledge/orchestration/{diff,context,index}.ts` + `orchestration.spec.ts` (17 tests).
- DB: `1867__knowledge__generation_workspace(.down).sql`; `spec/db/ownership.yaml` (two columns classified); `packages/db/src/knowledge-rls.int.spec.ts` (+2 tests).
- API: `appbuilder/internal/studio/generation.ts` (workspace, preview, start, plan), `template-adapt.ts` (the run), `generation.controller.ts`, `run-handlers.ts` (second mode of `webapp`), `template-start.ts` (records the baseline), `template-start.controller.ts` (plan follows its run), `appbuilder.module.ts`; knowledge: `customer-templates.service.ts` (plan, link and permission readers, baseline), `flag.ts` (`knowledge.generation` guard), `index.ts`, `knowledge.module.ts`; tests in `knowledge/review.int.spec.ts` (+10).
- Spec: OpenAPI (+3 operations, +5 schemas), `packages/sdk/src/schema.ts`.
- Web: `app/[locale]/(console)/builder/projects/[id]/template/page.tsx`, `components/TemplateWorkspace.tsx`, `lib/generation.ts`, link in the copy result (`TemplateStart.tsx`, `templates/[id]/page.tsx`), 57 message keys (ar/en); specs `generation.spec.ts`, `TemplateWorkspace.spec.tsx`.
- E2E: `e2e/tests/17-ai-generation.spec.ts`, shared fixtures `e2e/tests/fixtures/templates.ts` (spec 16 now uses them); 8 new screenshots (ar/en).
- Docs: this report, SCR-K-09, ADR-065 addendum H.

## C. Implemented
1. **Baseline of a copy** (append-only, recorded at copy time) and the **workspace comparison** (`GET /v1/builder/projects/{id}/template-workspace`): added, modified, removed, unchanged, departure %; works without the template and after it is changed or withdrawn; the customer's own paths only.
2. **Context assembly** (pure, deterministic): priority order, token budget, per-file and file-count caps, mode policy, AI-processing permission gate, an exclusion list with reasons. **Preview** (`GET …/context`): exactly what a model would receive, from the current state; sends and writes nothing.
3. **Adaptation run** (`POST …/runs`): creates a session and a `webapp` run with `input.templatePlanId` through the run engine (budget, kill switch, residency, metering, secret scan, repair loop); one structured model call; proposals checked against the workspace and the adaptation mode in code and by the shared safety checks (twice); committed on `work/ai`; checkpointed and resumable; the plan follows the run (PLANNED → RUNNING → COMPLETED | FAILED | CANCELLED) and starts once.
4. **Mode enforcement in code:** STRICT forbids deleting a template file and changing or removing a dependency; ADAPTIVE limits deletions to a fifth of the template's files; CREATIVE is free. Violations go back to the model through the repair loop.
5. **Customer UI** (Arabic and English): the template workspace page with the comparison, the plan form, the context preview, the start button and the run link; honest states (not available, not copied, read-only, no AI permission, blocked, refused).
6. **Flag** `knowledge.generation` per organization, default off, re-checked inside the run so the generic run endpoint cannot bypass it.

## D. Migrations and rollback
`1867__knowledge__generation_workspace.sql`: two nullable columns (`project_id`, `baseline`) on the append-only `generation_resource_links`, an index, and the view `v_template_context_permissions`. Reversal in `.down.sql` (dev/staging; production forward-fix). Behaviour rollback: the flag (default off).

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| Domain `orchestration.spec.ts` | **17 passed**: workspace diff (classification, sorting, bounds with exact counts, prototype-named paths), context assembly (priority, AI-processing gate, every exclusion reason, budget clamping, determinism under reordering, hostile text and forged fences, no template), the answer schema, `checkProposal` against the workspace and each mode |
| Domain unit total 821 · API unit 1070 · web 844 · i18n 9 · ui 24 · db 55 · worker 60 · adapters | passed |
| Admin unit 348 | 346 passed; `knowledge-upload.spec.ts` timed out twice in the parallel run (it hashes files, 40 s under load) and **passes alone: 22/22**. Not touched by this slice |
| API integration (knowledge, app builder, AI): 14 files | **315 passed**, incl. 10 new in `review.int.spec.ts` |
| New API tests cover | flag off by default and per organization (404 on the three routes; the plan says BLOCKED then READY), workspace diff after user changes and after the template is withdrawn, project not copied, context preview in priority order with the customer's work first and nothing written or sent, template without AI permission (source withheld, paths only), withdrawn template treated as "not allowed", a run that makes ONE model call whose prompt is checked (policy, requirement, customer work present; withheld template source absent; inside untrusted blocks), the proposal applied through the safe pipeline on `work/ai` with the template's own files untouched, a plan that starts once and a replayed key, STRICT repair (the violation message reaches the model; only the repaired change applies), a proposal that never passes (run and plan FAILED, project untouched), a secret and a path escape refused, the generic run endpoint unable to bypass the flag or reach another organization's plan (no model call), malformed input |
| DB integration (`@nuzm/db`) | **5 files, 102 passed** (2 new: baseline is a tenant row, append-only, check constraint, forged organization refused; the permission view exposes one boolean, only for versions a customer may use) |
| Worker integration · platform integration | **92 passed** · **32 passed** |
| Browser E2E `16-ai-templates.spec.ts` + `17-ai-generation.spec.ts` (Arabic + English, real browsers) | **8/8 passed**, axe WCAG A/AA clean on every screen: flag off, workspace identical to the template, the customer's own change shown as added, a plan, the context preview (template source withheld and absent from the page, the customer's file present), the start refused honestly without a model provider (no run created, plan and project unchanged) |
| `pnpm lint` (eslint + prettier) | PASS after fixing three errors of mine (an unused import, an unused argument, a control-character regex in a test) |
| `pnpm typecheck` (52/52), `pnpm build` (28/28) | PASS |
| Migration reversal (1867 down, then up again) | PASS on a scratch database: columns 2 → 0 → 2 |
| `db:test-rls`, classification coverage (3356 columns), ropa coverage, residency hooks, `spec:lint`, `spec:drift` (501 routes), `sdk:check`, `compliance:claims-guard` | PASS |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched) |
Not run: `pnpm verify:full`; the full API integration suite (the knowledge, app-builder and AI modules were run); a run against a real model provider (none configured: NOT VERIFIED).

## F. Security, tenant isolation, billing, residency
- Customers get their own project's paths and sizes; never a template's files. The preview shows the customer's own project content and the requirement (their data) and states when template source is withheld. The permission view returns one boolean for a version a customer may use.
- Model input is wrapped by the run engine's untrusted-content blocks; control characters, bidi overrides and forged fences are neutralised (tested); the policy is trusted code text; project and template text never outranks it. The model's output is secret-scanned by the engine and its tool calls are ignored/denied as for every run; model output is never executed.
- Safety of applying: the same path, secret, canary, size and dependency checks as every change, plus workspace and mode rules; a secret or a path escape fails the run with the project untouched (tested); the result lands on the AI branch only.
- Isolation: plans, links and baselines are tenant rows (forced RLS); another organization's plan or project is "not found" through every route including the generic run endpoint (tested, no model call made). A plan starts once even under a race (conditional update; the losing run is cancelled).
- Billing and metering: the model call is the run engine's (credits reserved and spent; a run with no credits or no provider is refused before it is created). Preview, comparison and plan creation are free data operations. Residency: the run uses the project's data region through the engine's existing check.
- Known gaps: the token estimate is characters / 3 (pessimistic, not a billing figure); proposals larger than 40 patches are rejected, not split; no merge UI for the AI branch; a run resumed after a crash BETWEEN applying the change and saving the checkpoint would fail with `base_mismatch` rather than re-apply (the project is then already adapted; fail-safe).

## G. Human gates and live checks still needed
- **D-46 (OPEN):** the `ModelAdapter` tool-use extension and the coding-agent tool set (read/search/edit/run in a sandbox) need your decision and a spec change to `docs/09`. Nothing here depends on it, and nothing here claims to be it.
- **Model quality NOT VERIFIED:** a real provider, real credentials and a real run (HG for production-billable calls) are needed to judge adaptation quality; tests use a scripted mock and prove plumbing and safety only.
- **D-21** blocks building, running or previewing an adapted project. **D-42** blocks production activation. D-45, D-47 unchanged.

## H. Acceptance checklist (S-K6 criteria)
| Criterion | Status |
|---|---|
| Plan lifecycle recorded and following its run | PASS |
| Workspace copy (S-K7) and diff against what the copy wrote | PASS |
| Context assembly with budgets, priorities, permission gate, untrusted fences; customer-visible preview | PASS |
| Integration with the run engine (metered, residency, budget, repair, secret scan) | PASS (plumbing, scripted mock model) |
| Changes through the safe pipeline, AI branch only, mode rules enforced | PASS |
| Cross-tenant, flag-bypass, malformed-input, hostile-text tests | PASS |
| Arabic/English UI with e2e, axe, screenshots; flag default off | PASS |
| Quality of model adaptations | NOT VERIFIED (needs a real provider) |
| Coding agent / tool use / on-demand file fetch | NOT BUILT (D-46 open) |
| Build, test or preview of the result | BLOCKED (D-21) |
| Production | BLOCKED (D-42) |

## I. Handoff
Next: S-K8 (quality evidence, analytics, cost; build/visual validation blocked on D-21) can read the usage, plan and run rows recorded from S-K7 on; S-K9 hardening. Open for the owner: **D-46** (decide the tool-use extension and tool set, or confirm the single-call adaptation is the intended v1); the AI-processing reading in A; a real provider and test credentials to verify model quality; D-42/D-21 items.
