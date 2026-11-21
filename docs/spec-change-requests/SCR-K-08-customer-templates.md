# SCR-K-08 — Customer template gallery and start from a template (AI Intelligence Center, slice S-K7)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-22 · Governed by ADR-065 (point 9, addendum G), SCR-K-01 §3 (approved via D-41: customers read platform resources ONLY through `knowledge.v_published_templates`), SCR-K-07 (the engine), D-48 (weights).
Customer realm, behind the organization flag `knowledge.customer_templates` (default **off**; an organization row beats the global row; answered `404` while off) and, to copy, `app_builder.enabled`. Production stays blocked on D-42. No model is called and nothing is executed.

## 1. What it adds
1. **Gallery**: the published templates of the platform library and the organization's own, with compatibility facts (platform, frameworks, languages), the reuse the permissions allow (`FULL_STARTER`, `COMPONENTS`, `ARCHITECTURE_ONLY`), the licence, capability names, a **safe design summary** (modes, traits, role colours, font families, base unit) and counts. Filters in the URL; cursor paging.
2. **One template** and **a suggestion for a description** (the S-K5 engine answered for a customer).
3. **Start a project from a template**: the pinned, immutable version is copied into a NEW web-app project of the organization through the safe-change pipeline; the template is never modified.
4. **Generation plans**: the requirement and the deterministic selection recorded for one of the organization's projects. Executing a plan is the run engine with a model (S-K6) and is reported as `BLOCKED` in the plan.

## 2. What a customer can never obtain
File contents, file paths, object keys, manifest excerpts, evidence locations, token names, the exclusion list, search-document text, an unpublished resource's existence. A resource that is not active, published, licence-eligible and reuse-permitted is **404**, indistinguishable from a missing one (also when it is a user's choice in a recommendation: `not_found`, never `not_published`). The design summary is built in the database from the Design DNA and holds role colours, font families, modes, traits and the base unit only.

## 3. Database (migration `1866__knowledge__customer_templates`, reversal in `.down.sql`; production forward-fix)
- `v_published_templates` keeps its columns and order and gains `component_count`, `license_spdx` and `capabilities` (names only); `design_dna` becomes the safe summary above (it used to expose a manifest key that S-K4 no longer writes).
- New view `v_template_copy_files` (`security_barrier`): the stored TEXT files of ONE eligible version, and only while the transaction names that version (`app.template_copy_version`); otherwise it is empty, so a customer cannot list files by guessing ids. Base tables stay closed to the tenant role.
- Usage events, generation plans and resource links were already tenant tables with forced RLS (migration 1860): the customer's own rows only; usage events are append-only.

## 4. Copy rules (`POST /v1/builder/projects/from-template`)
1. Eligibility is re-checked for the adaptation mode (STRICT needs a permitted full starter; ADAPTIVE needs components or a starter; CREATIVE needs only some reuse permission) at copy time: `422 knowledge_template_incompatible` with the reasons; a pinned `versionId` that is no longer the active one is `422` with `pinned_version_unavailable`; an unpublished or unknown template is `404`.
2. Files are read through the guarded view, from the object store, **verified against their recorded digest**, and validated by the same checks every file change goes through (path rules, secret and canary scan, size limits, dependency policy). A template with a secret is refused (`change_rejected`); a missing or altered object is refused (`unsupported_capability`) and nothing is created.
3. Binary files, files without a stored object and files over the size limit are not copied and are listed (`files.skipped`).
4. Only after all of that is the project created, then one Git commit is made with the files; if the change is refused, the empty project is removed again. The project name is the customer's (a taken name is `409` and records nothing).
5. Recorded in the customer's own rows: usage events `SELECTED` and `COPIED`, a resource link (role `STARTER`, strategy `COPY`), and the audit event `knowledge.template.copied`. `Idempotency-Key` is required; the same key replays the first answer.

## 4a. Rules shared with the rest of the platform
`builder:read` for reading, `builder:write` for copying and plans; viewers cannot write. Every mutation is audited; recommendations record `RECOMMENDED` usage for the top three results only.

## 5. API
`GET /v1/builder/templates`, `GET /v1/builder/templates/{id}`, `POST /v1/builder/template-recommendations`, `POST /v1/builder/projects/from-template`, `POST /v1/builder/generation-plans`, `GET /v1/builder/generation-plans/{id}` (OpenAPI, SDK regenerated).

## 6. Customer UI (Arabic and English, RTL, keyboard, axe)
`/builder/templates` (gallery, filters, "suggest a template") and `/builder/templates/{id}` (facts, capabilities, design summary, start form with name and adaptation mode, the result with the licence reminder and the skipped files). A link on the start screen appears only while the flag is on. States: loading, empty, filtered-empty, error (by reason, never raw server text), forbidden, not available, read-only without write permission or without the app builder.

## 7. Not in this change
Customer **import** of their own project (the ingestion pipeline is platform-admin only and production is blocked on D-42); **chat on the current project state** and execution of a generation plan (S-K6, needs a model and the run engine); a semantic layer (D-47); previews and screenshots (D-21); live activation (D-42).

## 8. Rollback
`knowledge.customer_templates` off (default): every route is 404 and the screens say "not available". Dev/staging: `1866__…down.sql`; production is forward-fix.
