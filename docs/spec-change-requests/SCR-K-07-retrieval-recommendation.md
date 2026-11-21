# SCR-K-07 — Retrieval and recommendation (AI Intelligence Center, slice S-K5)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (points 7 and 8, addendum F), SCR-K-01 (approved), SCR-K-04, SCR-K-06; decisions D-47 (lexical, metadata and symbol retrieval first; embeddings BLOCKED) and D-48 (initial weights as editable configuration).
Platform-admin only, behind the flag `knowledge.library`; the worker stage is behind `KNOWLEDGE_INDEX_ENABLED` (default **off**, needs `KNOWLEDGE_DETECT_ENABLED`). Customer endpoints are S-K7. Production stays blocked on D-42.

## 1. What it adds
1. **INDEX stage**: after the earlier stages, a bounded set of search documents per version (summary, features and routes, components, exported symbols, design, README and documentation sections), built only from facts already proved and files already scanned and stored.
2. **Search** over the platform library: structured filters, lexical matching (`tsvector`, prefix matching, bilingual Arabic/English concept groups), component and symbol names, Design DNA words, resource metadata. Every hit says whether it is eligible and why not.
3. **Recommendation**: hard filters first, then the weighted model (D-48), then the strategy, with a full explanation. Read-only.
4. **Weights and defaults**: the model weights are platform settings with optimistic revisions, an append-only history and audit events; admin defaults (`template_defaults`) get an API.
No model is called and no embedding exists: the semantic layer stays BLOCKED (D-47, capability probe, data terms).

## 2. Order of operations (permission-first)
1. **Hard filters** (`evaluateEligibility`), on every platform resource, before any text is matched or any score computed: not archived, active, published, licence ALLOWED (resource and version), a reuse permission, platform compatibility (unknown is unsupported), required frameworks, the adaptation mode's permission (STRICT: a permitted full starter; ADAPTIVE: components or a starter), AI processing when the generation will send source to a model, a default's version pin. Every reason is reported; excluded resources are listed with all of them.
2. **Weighted model** over the eligible ones only: functional 25, framework 20, architecture 20, design 15, quality 10, reuse efficiency 10 by default. A dimension counts only when the requirement exercises it and it has evidence; the weights are renormalised over those, and `confidence` is the share of the configured weight that was exercised. Quality with no measured evidence is "not measured", never a number.
3. **Relevance gate**: when the requirement states needs (text, frameworks, design hints) and the resource meets none of them, its score is 0 whatever its structure, quality or permissions, so it can never be chosen on intrinsic qualities alone.
4. **Strategy**: AUTO_SELECT (best at or above the minimum score, else GENERATE_FROM_SCRATCH), USER_SELECTED (honoured when eligible; otherwise explained with its reasons and **never substituted**; alternatives are shown, not applied), ADMIN_DEFAULT (the most specific matching rule, still through the hard filters and its pin; otherwise the automatic choice, saying why), GENERATE_FROM_SCRATCH.

## 3. Retrieval details
- Text: Arabic is normalised (diacritics, tatweel, alef/yeh/teh-marbuta folding) and indexed together with its normalised form; identifiers are split; stop words dropped. A small bilingual concept table (data, reviewed in code) groups words that mean the same ("متجر", store, shop, checkout …) so each group counts once.
- Query text can never carry operators: terms are restricted to letters and digits before they reach `to_tsquery`.
- Coverage by where a match was found (summary/feature 1.0, component 0.9, metadata 0.8, documentation 0.7, symbol 0.6, design 0.4).
- Design: traits (dark mode, RTL, Arabic font, Tailwind) and primary-colour distance (CIE76) against the Design DNA; a hint the DNA cannot answer counts as unmet.

## 4. Database (migration `1865__knowledge__retrieval`, reversal in `.down.sql`; production forward-fix)
`worker_knowledge` policy, INSERT grant and the `ANALYZING` guard trigger on `resource_search_documents` (platform rows only, insert-only, natural key already exists); new platform-only tables `engine_settings` (current value and revision of a key) and `engine_setting_revisions` (append-only: who, why, value, previous). `spec/db/ownership.yaml` lists and classifies them. No embedding column.

## 5. API (platform admin)
`GET /v1/admin/knowledge/search`, `POST /v1/admin/knowledge/recommendations` (computation, no writes), `GET|PUT /v1/admin/knowledge/settings/recommendation` (`If-Match` revision, reason, integer weights adding to 100, publish permission), `GET …/settings/recommendation/revisions`, `GET|PUT /v1/admin/knowledge/defaults`, `DELETE …/defaults/{id}` (publish permission, audited). Reprocessing retries INDEX when the indexing job was the one interrupted.

## 6. Admin UI
"Search and recommendations" page (Arabic/English): search form with results, relevance, eligibility reasons and evidence; a recommendation simulator with a decision banner, ranked candidates with a score bar and a per-dimension breakdown (weight, effective weight, score, points, why), the user-choice explanation and alternatives, and every exclusion with its reasons; the weights with live sum check, reason, revision, history and the defaults list. States: loading, empty, error, forbidden; read-only without the publish permission.

## 7. Not in this change
Customer-facing endpoints and the gallery (S-K7); the semantic layer (D-47, BLOCKED); recording `usage_events` for simulations; a UI to edit admin defaults (API only); generation (S-K6); updating `v_published_templates`' design summary; production activation (D-42).

## 8. Rollback
`KNOWLEDGE_INDEX_ENABLED=false` (default) returns to the S-K4 flow; queued INDEX jobs wait. Dev/staging: `1865__…down.sql`; production is forward-fix.
