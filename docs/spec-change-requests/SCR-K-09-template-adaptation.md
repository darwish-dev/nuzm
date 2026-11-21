# SCR-K-09 — Adapting a copied template (AI Intelligence Center, slice S-K6)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-22 · Governed by ADR-065 (point 9, addendum H), SCR-K-08 (copy), AUDIT_AND_PLAN §4 and §6 (isolation rules 3 and 5), D-48.
Customer realm, behind the organization flag `knowledge.generation` (default **off**; an organization row beats the global row; **404** while off); starting a run also needs `app_builder.enabled`, the AI permission and a configured model provider. Production stays blocked on D-42. **D-46 (tool-use adapter extension, coding agent) is NOT decided and NOT implemented here.**

## 1. What it adds
1. **Baseline of a copy**: at copy time the link row records the project and the baseline (path → sha256 of exactly the files written). The table is append-only, so the baseline cannot drift.
2. **Workspace comparison** (`GET /v1/builder/projects/{id}/template-workspace`): the project's files against the baseline: added, modified, removed, unchanged, departure %. It needs neither the template nor its files and keeps working after the template is changed or withdrawn.
3. **Context assembly and preview** (`GET /v1/builder/generation-plans/{id}/context`): the exact, bounded pack a model would receive for a plan, computed from the CURRENT state. Nothing is sent by this call.
4. **Adaptation run** (`POST /v1/builder/generation-plans/{id}/runs`): a run of the existing `webapp` kind with `input.templatePlanId`; ONE structured model call, then the safe-change pipeline.
5. **Plan lifecycle**: PLANNED → RUNNING (once, 409 on a second start) → COMPLETED | FAILED | CANCELLED, following the run; `plan.execution` says what can happen next (BLOCKED, READY, or the run).

## 2. Context assembly (pure, deterministic, golden-tested in the domain package)
- **Priority** (highest first): the platform's policy for the adaptation mode (trusted, from code; goes in the instruction), the customer's requirement, template facts (name, description, capabilities, licence, design summary: metadata, never source), the workspace index (path, size, who wrote it), then file contents: the customer's own work first, then configuration, then entry points, ties by path. Retrieved or project text is always data: the run engine wraps every block in its untrusted-content fence, strips control characters and bidi overrides, and neutralises forged fences.
- **AI-processing permission** (rule 5): contents of files that are still the template's (unchanged since the copy) are sent only when the template's `ai_processing` permission is true; otherwise only their paths and sizes are. The customer's own work is always eligible. A template that is no longer available cannot vouch for its permission, so it is treated as "not allowed".
- **Bounds**: a token budget (default 12 000, clamped to 1 000..60 000; characters / 3, a pessimistic approximation, not a billing figure), at most 40 files, 16 000 characters per file, 400 index entries. Whatever does not fit is listed as excluded with a reason (`ai_processing_not_allowed`, `too_large`, `over_budget`, `too_many_files`, `not_text`), never dropped silently.
- **Mode policy**: STRICT keeps the template (no deleting or renaming a template file, no changed dependency); ADAPTIVE adapts within the template's architecture (at most a fifth of the template's files may be deleted); CREATIVE may restructure. The same rules are enforced in code (`checkProposal`), not only asked of the model.

## 3. The run (what it is and is not)
- It IS: one `ctx.call` through the run engine's gateway (metered credits, residency check, budget cap, kill switch, output secret scan, repair loop ≤ 2). The model answers `{summary, patches[]}` (≤ 40 add/modify/delete with whole-file content). Proposals are validated against the workspace and the mode, and by the same path, secret, canary, size and dependency checks as every change, first inside the repair loop and again, deterministically, before anything is applied. The change is committed on the AI branch `work/ai`, never the main branch. The proposal and the application are checkpointed (resumable).
- It is NOT the coding agent: no tool use, no on-demand file fetch, nothing is executed or built (D-46 open; D-21 blocks any execution). Model output is never run as code. Model QUALITY is **NOT VERIFIED**; the integration tests use a scripted mock model and prove plumbing and safety only.
- The existing generator of the `webapp` kind (requirements → architecture → … → assembled project) is untouched; it regenerates a whole project from a spec and is not used on a template copy, because its final commit replaces the file set.
- The flag is checked again inside the run, so a run created through the generic run endpoint cannot bypass it; a plan of another organization is "not found" there; the model is never called in either case.

## 4. Database (migration `1867__knowledge__generation_workspace`, reversal in `.down.sql`; production forward-fix)
`generation_resource_links` gains `project_id` and `baseline` (nullable, expand only; classified `internal` / `customer-content`); one index; one view `v_template_context_permissions` (version id and `ai_processing` of a version a customer may use, nothing else). Copies made before this migration have no baseline and say so (`linked: false`).

## 5. API
`GET /v1/builder/projects/{id}/template-workspace`, `GET /v1/builder/generation-plans/{id}/context`, `POST /v1/builder/generation-plans/{id}/runs` (`Idempotency-Key`; audited `knowledge.plan.run_started`); `GET /v1/builder/generation-plans/{id}` now follows the run. OpenAPI and SDK updated.

## 6. Customer UI (Arabic and English, RTL, keyboard, axe)
`/builder/projects/{id}/template`: the template and the comparison, the plan form, the context preview (policy, every block, estimate against the budget, what was left out and why, a notice when template source is withheld), the start button and the run link. The copy result links to it only while the flag is on. States: not available, not copied, read-only, no AI permission, blocked, refused (by reason, never raw server text).

## 7. Not in this change
The coding agent and any tool use (D-46); on-demand file fetch; build, test or preview of the result (D-21); customer import and chat on the current project state (D-42); embeddings (D-47); evaluation of results (S-K8); a merge UI for the AI branch.

## 8. Rollback
`knowledge.generation` off (default): all three routes are 404 and the screen says "not available". Dev/staging: `1867__…down.sql`; production is forward-fix.
