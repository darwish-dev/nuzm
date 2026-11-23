# AI Intelligence Center — slice S-K5 report (retrieval and recommendation)

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K1, S-K2a, S-K2b, S-K2c, sandbox `b3dc6fd`, S-K4 `486347a` preserved; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; the INDEX stage is OFF by default (`KNOWLEDGE_INDEX_ENABLED`); everything is platform-admin only; production stays BLOCKED on D-42; the semantic layer stays BLOCKED (D-47)**.
Governing documents: ADR-065 (points 7 and 8, addendum F), SCR-K-07 (`docs/spec-change-requests/SCR-K-07-retrieval-recommendation.md`), decisions D-47 and D-48 in `docs/07`.

## A. Repository findings and assumptions
- The foundation (migration 1860) already had `resource_search_documents` (with a `tsvector` and a GIN index), `quality_scores`, `usage_events`, `template_defaults` and `v_published_templates`; no worker policy existed for search documents and no settings table existed. No endpoint existed for retrieval, defaults or weights.
- **No model, no embeddings:** D-47 (decided, interim) selects lexical + metadata + symbol retrieval first; the managed-Postgres `vector` capability and the data terms are unprobed, so the semantic layer is BLOCKED and nothing here depends on it.
- **Design decision worth your review (the relevance gate):** my first implementation let intrinsic dimensions (architecture structure, quality, reuse) carry an irrelevant resource above the minimum score (a "quantum telescope" requirement auto-selected a dashboard theme). An integration test caught it. Now, when the requirement states needs (text, frameworks, design hints) and the resource meets none of them, its score is 0 whatever its structure, quality or permissions. Documented in SCR-K-07 and ADR-065 addendum F.
- **Interpretation of D-48:** the weights are applied over the dimensions the requirement exercises and that have evidence, renormalised, with `confidence` reporting the exercised share of the configured weight. Quality with no measured evidence is "not measured", never a number. This is my reading of "evaluated against outcomes, not proven optimal"; changing it is a configuration or code-review matter.
- `v_published_templates` still exposes `manifest -> 'designDna'`, which S-K4 stores elsewhere (the Design DNA row); that customer view is S-K7's concern and was not touched.
- A request to "undo" arrived mid-slice; I took the smallest reading (reverting my last step, two admin UI files), then you said to continue and I restored them. Nothing else was reverted.
- Environment: this worktree's Postgres on :54339 and E2E ports 3300/3301/4300/4310; the machine was heavily loaded by other sessions, so the browser E2E used a temporary longer-timeout config (deleted afterwards).

## B. Plan and changed files
- Domain `packages/domain/src/knowledge/retrieval/**`: `text.ts` (normalisation, tokenising, bilingual concept groups, safe tsquery), `documents.ts` (search documents, markdown splitter), `rank.ts` (settings validation, hard filters, scoring, gate, defaults, strategy), `retrieval.spec.ts` (33 tests).
- Worker: `index-stage.ts` (+ `index-stage.int.spec.ts`), `ingest-service.ts` (INDEX option and a general "next stage" hand-off), `components-stage.ts`, `design-stage.ts`, `main.ts`.
- Database: `1865__knowledge__retrieval(.down).sql`; `spec/db/ownership.yaml` (two tables listed and classified).
- API: `internal/retrieval.service.ts`, `admin-knowledge-retrieval.controller.ts`, `knowledge.module.ts`, INDEX retry in `review.service.ts`; tests in `review.int.spec.ts` (+12); OpenAPI (+8 operations, +13 schemas) and `packages/sdk/src/schema.ts`.
- Admin: `app/[locale]/(console)/ai-intelligence/search/page.tsx`, `components/KnowledgeRetrieval.tsx`, `lib/knowledge-retrieval.ts`, navigation entry, spec (12 tests), 171 message keys (ar/en), swatch/score styles.
- E2E: `e2e/tests/15-ai-ingestion.spec.ts` (INDEX on; search, recommendation, weights flow); screenshots regenerated and added.
- Docs: this report, SCR-K-07, ADR-065 addendum F, `.env.example`.

## C. Implemented
1. **INDEX stage (last in the pipeline):** bounded search documents (summary, features and routes, components, exported symbols, design, README and documentation sections; at most 800 per version, 25 sections per file) from proved facts and already-scanned stored files; Arabic text is indexed with its normalised form; code fences are skipped; one transaction, insert-only for the worker, `ANALYZING` guard; cancellation writes nothing; quarantined and rejected packages never reach it. The hand-off between stages is now general: DETECT → COMPONENTS → DESIGN → INDEX, each enabled independently.
2. **Search** (`GET /search`): structured filters (type, platform, framework, language, category, tag, status), lexical and symbol matching with bilingual concept groups (each group counts once), metadata matching, relevance, evidence (matched documents, components), and for every hit its eligibility with every reason.
3. **Recommendation** (`POST /recommendations`, read-only): hard filters first (publication, licence, reuse permission, platform fit with unknown = unsupported, required frameworks, adaptation mode, AI processing, version pin), the weighted model over eligible versions only, the relevance gate, and the strategy (AUTO_SELECT, USER_SELECTED never substituted, ADMIN_DEFAULT through the filters, GENERATE_FROM_SCRATCH). The answer carries the ranking, the per-dimension breakdown, the usage the permissions allow, the licence, matching components, the exclusions with all reasons, alternatives for an unusable user choice, and the settings revision used. Deterministic.
4. **Weights** (`GET|PUT /settings/recommendation`, `GET …/revisions`): integers adding to 100, a minimum score, a mandatory reason, optimistic `If-Match` revision, append-only history (who, why, new, previous), audit events, publish permission.
5. **Admin defaults** (`GET|PUT /defaults`, `DELETE /defaults/{id}`): upsert by rule, resource and pin validated, audited, publish permission.
6. **Admin UI (Arabic/English):** search with results, recommendation simulator with the full explanation, weights editor with live sum check and history, defaults list; states loading, empty, error, forbidden; read-only without the publish permission.
7. **Controls preserved:** quarantine, two-person approval, audit and tenant isolation unchanged; customers cannot reach any of this (platform realm, platform permission, flag).

## D. Migrations and rollback
`1865__knowledge__retrieval.sql`: worker policy, INSERT grant and guard trigger on `resource_search_documents`; tables `engine_settings` and `engine_setting_revisions` (append-only, forced RLS, platform scope). Reversal in `.down.sql` (dev/staging; production forward-fix). Behaviour rollback: `KNOWLEDGE_INDEX_ENABLED=false` (default).

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| Domain `retrieval.spec.ts` | **33 passed**: normalisation and bilingual concept groups, tsquery safety (hostile input, fuzz), search documents (kinds, determinism, bounds, markdown), settings validation, every hard filter and combination, the weighted model (renormalisation, confidence, coverage, framework, architecture, design hints, quality not measured, reuse), the relevance gate, strategies (defaults specificity and ties, user choice never substituted, fallbacks), determinism fuzz |
| Domain unit total | 804 passed |
| Worker unit 60 · admin 348 (12 new) · i18n 9 · ui 24 · db 55 · adapter 26 · API unit 1070 | all passed |
| Worker integration (real PostgreSQL, role `nuzm_worker`) | **92 passed** (8 files; 8 new for the INDEX stage) |
| `index-stage.int.spec.ts` | **8 passed**: documents of every kind and English/Arabic full-text search, only after the last enabled stage, detect-only and components-only chains, flag off and INDEX without DETECT, quarantined/rejected never reach it, hostile documentation (huge, NUL, 1 500 headings, instruction-like text treated as data), cancellation writes nothing, worker write limits and no access to the settings tables |
| API integration, knowledge | **71 passed** (12 new): hard filters before ranking with every exclusion reason, Arabic and English requirements, design/framework/quality/architecture entering the score, user choice honoured or explained and never substituted, mode and AI-processing filters, below-threshold generate-from-scratch, admin defaults (permission, upsert, ineligible fallback, wrong pin), weights (permission, validation, stale 412, history, append-only, audit), search (filters, eligibility reasons, hostile text), requirement validation, no writes, determinism, INDEX retry |
| Other integration | db 93 · platform 32 |
| Browser E2E `15-ai-ingestion.spec.ts` (Arabic + English, real worker process, INDEX on) | **8/8 passed**, axe WCAG A/AA clean: search shows the private resource as not eligible with its reasons; the Arabic recommendation explains why nothing is eligible; after publishing, the recommendation ranks it with a score bar and a breakdown that says quality was not measured; weights saved with a reason and shown in the history; DB checks (documents written, revision and audit rows) |
| `pnpm lint`, `pnpm typecheck` (52/52), `pnpm build` (28/28), `spec:lint`, `spec:drift` (492 routes), `sdk:check`, `compliance:claims-guard` | PASS |
| `db:test-rls`, `compliance:classification-coverage` (3354 columns in 267 tables), `compliance:ropa-coverage` | PASS against this worktree's database |
| Migration reversal (1865 down, then up again) | PASS on a scratch database: migrated to head (2 new tables), `1865…down.sql` applied (0), `1865…sql` applied again (2); database dropped |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched); mine are clean |
Not run: `pnpm verify:full`; the full API integration suite (only the knowledge subset, the API changes being confined to that module).

## F. Security, tenant isolation, billing, residency
- Permission-first by construction and by test: a private, unpermitted or restrictively licensed resource is never ranked, even when it is the best text match; the exclusion is explained. Reading needs `admin:ai_knowledge:read`, changing weights or defaults `admin:ai_knowledge:publish`; customers are refused (platform realm).
- Query text cannot carry operators (terms restricted to letters and digits before `to_tsquery`; hostile strings tested over HTTP and as a fuzz property). The recommendation endpoint writes nothing (row counts of usage events, documents, tokens, defaults and settings are unchanged by a call). Settings history is append-only in the database.
- Worker: search documents are insert-only, platform rows only, only for a version in `ANALYZING`; no access to the settings tables. Documentation is split by heading with a linear, capped reader and never executed; instruction-like text in a README is indexed as plain words.
- Billing, metering, residency: not touched (no vendor call, no model).
- Known gaps: the bilingual concept table is a small, code-reviewed list (not a claim of completeness); simulations do not record `usage_events`; no UI to edit admin defaults.

## G. Human gates and live checks still needed
- **D-42 (BLOCKS production)** unchanged (see `D-42-D-45-status.md`): production uploads, ingestion and every analysis stage stay off.
- **D-47:** the semantic layer needs the `vector` capability probe on the managed Postgres, an approved embedding model, residency and data terms (HG-09-01); until then the flag `knowledge.semantic_search` stays off.
- **D-48 follow-through:** the weights are configuration to be evaluated against outcomes (`usage_events`, `generation_evaluations`), never auto-tuned; that evaluation starts with S-K7.
- D-45 grammar go-ahead, D-43, D-44, D-21 unchanged.

## H. Acceptance checklist (S-K5 criteria, plan §5)
| Criterion | Status |
|---|---|
| Metadata + lexical + symbol retrieval, permission-aware, ranked output | PASS |
| Hard filters in SQL-eligible order before any ranking; every exclusion explained | PASS |
| Recommendation with configurable weights (D-48), audit trail, strategies incl. never-substituted user choice and admin defaults | PASS |
| Arabic and English requirements | PASS |
| Evidence-based quality ("not measured" never a number); no model call; nothing written by a recommendation | PASS |
| Hostile text, tenant/realm isolation, write limits, determinism tests | PASS |
| Arabic/English UI with e2e, axe and screenshots; spec lint, drift, SDK, ownership classification | PASS |
| Flag default off; quarantine, approval, audit, tenant isolation unchanged; production blocked on D-42 | PASS / BLOCKED (D-42) |
| Semantic (embedding) retrieval | BLOCKED (D-47) |
| Customer-facing search and recommendation | NOT BUILT (S-K7) |

## I. Handoff
Next slices (`AUDIT_AND_PLAN.md`): S-K6 (orchestration: plan, context assembly, workspace copy/diff, integration with the run engine; coding agent only via a tool-use adapter extension, D-46) and S-K7 (customer gallery, start-from-template, import, adaptation modes), which will call this engine through the published view and record `usage_events`. Open for the owner: go-ahead for S-K6/S-K7; D-46; D-47 probe and model; the D-45 grammar dependency review; D-42 items.
