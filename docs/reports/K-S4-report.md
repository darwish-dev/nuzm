# AI Intelligence Center — slice S-K4 report (Design DNA and theme intelligence)

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K1, S-K2a `a37c2a0`, S-K2b `c59d148`, S-K2c `5c31f1e`, sandbox `b3dc6fd` preserved; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; the DESIGN stage is OFF by default (`KNOWLEDGE_DESIGN_ENABLED`); production activation stays BLOCKED on D-42**.
Governing documents: ADR-065 (addendum E), SCR-K-06 (`docs/spec-change-requests/SCR-K-06-design-dna.md`), preparation `docs/ai-intelligence/S-K4-PREP.md`, `docs/ai-intelligence/D-42-D-45-status.md`.

## A. Repository findings and assumptions
- S-K2c leaves a version at `AWAITING_REVIEW` with a schema-2 manifest; S-K4 inserts a DESIGN stage after COMPONENTS (same queue, lease, cancel, retry and dead letter, same `nuzm_worker` role and scope) and adds a schema-3 manifest. `theme_tokens` and `theme_variants` already existed (migration 1860) without worker policies.
- The S-K4-PREP proposals were built as written: no CSS parser dependency (a small string-aware reader inside the sandbox), configuration files read as syntax trees and never evaluated, the lexical reader for Flutter (the bundled grammar of D-45 is decided but not yet bundled), no rendering (D-21), tokens never reusable.
- **Deviation from the preparation:** the full Design DNA document is stored as an append-only `analysis_results` row (`design-dna`), not inside the manifest; the schema-3 manifest carries a compact summary. Reason: the manifest is returned whole by an existing endpoint and the DNA can be large; the new `/design` endpoint serves the row. The DNA is bounded (150 000 bytes, trimmed deterministically).
- **Refactor made on the way:** the parsing lanes (one lane per sandbox thread, cancellation within ~200 ms, wall-clock budget, failure breaker, typed skips) moved from the COMPONENTS stage into a shared helper (`ast/parse-lanes.ts`) used by both stages; the COMPONENTS stage behaves as before (its 17 integration tests pass unchanged).
- Environment: this worktree's Postgres on :54339 and E2E ports 3300/3301/4300/4310; the machine was under very heavy load from other sessions (load average in the hundreds), so the browser E2E used a temporary config with longer server-start timeouts (deleted afterwards) and a few suites needed a rerun after setup timeouts.

## B. Plan and changed files
- Domain `packages/domain/src/knowledge/design/**`: `types, color, css, tokens-json, flutter, assemble` (+ `design.spec.ts`, 24 tests); `knowledge/index.ts` exports it.
- Worker: `ast/theme-config.ts` (+ spec), `ast/parse-lanes.ts`, `ast/scripted-sandbox.testing.ts` (test helper, excluded from the build), `design-stage.ts` (+ `design-stage.int.spec.ts`), sandbox protocol/thread/pool extended with four file kinds, `components-stage.ts` (hands off to DESIGN; uses the shared lanes), `ingest-service.ts`, `main.ts`, `tsconfig.build.json`.
- Database: `1864__knowledge__design_dna(.down).sql`; `spec/db/ownership.yaml` (five columns classified).
- API: `review.service.ts` (`design`, `themeTokens`, `themeVariants`, DESIGN retry), `admin-knowledge-processing.controller.ts`, tests in `review.int.spec.ts`; OpenAPI (+3 operations, +5 schemas) and `packages/sdk/src/schema.ts`.
- Admin: `components/KnowledgeIngestion.tsx` ("Design DNA" card), `lib/knowledge.ts`, 110 message keys (ar/en), `packages/ui/src/console-css.ts` (swatch styles), spec (+7 tests).
- E2E: `e2e/tests/15-ai-ingestion.spec.ts`, `e2e/tests/fixtures/samples.ts` (a stylesheet and a Flutter theme file added to two samples); screenshots regenerated.
- Docs: this report, SCR-K-06, ADR-065 addendum E, S-K4-PREP status, `.env.example`.

## C. Implemented
1. **Readers (all inside the parser sandbox, all parse-only):** CSS/SCSS/Less custom properties with the mode they apply to (`:root`, `.dark`, `[data-theme=…]`, `@media (prefers-color-scheme: dark)`, named schemes, component-scoped), Tailwind v4 `@theme`, SCSS and Less variables, property usage (background, text, border), RTL and logical-property evidence; design-token JSON (W3C, Style Dictionary, `theme.json` presets, aliases); JavaScript/TypeScript theme configuration through the syntax tree (Tailwind `theme`/`extend`, `createTheme`, `extendTheme`, exported token objects) where computed values are recorded as **dynamic with no value**; Flutter theme code (colours, colour scheme, fonts, text styles, radii, brightness).
2. **Assembly:** tokens with references resolved inside the project (`var()` with fallbacks, `{alias}`, shadcn colour channels), cycle-safe; colour roles per mode (cascade: base overridden by the mode) from names and property usage, with confidence and evidence; WCAG contrast of role pairs over resolved opaque colours; typography, spacing with base unit (declared or inferred, labelled), radius, shadows, breakpoints, motion; traits (dark mode, several colour schemes, RTL, Arabic font, Tailwind, CSS variables, Material 3); theme variants (colour schemes, layouts, sidebars, headers, footers, page templates, dashboard shells, screens). One DNA per project, deterministic whatever the input order.
3. **Persistence:** one transaction writes tokens, variants, the DNA row, the schema-3 manifest, the per-file cache and the summary; per-file facts are cached by content hash across versions of the same resource and are not cached when a parser limit was hit.
4. **API:** `GET …/design`, `…/theme-tokens` (q, category, mode, origin, dynamic, paging), `…/theme-variants` (kind, paging).
5. **UI (Arabic/English):** swatches per role with token, hex, confidence and evidence; contrast table with AA/AAA; typography, spacing, radius, shadows, breakpoints, motion; traits; computed values with their location; token table with filters and resolved values; variants; project and mode selectors; "not reusable yet" marker; states loading, empty, error, forbidden. A colour reaches a style attribute only if it is a plain hex the analyzer produced.
6. **Controls preserved:** S-K2a quarantine, two-person approval, activation guard, audit and tenant isolation are unchanged; quarantined or rejected packages never reach DESIGN; flag off by default.

## D. Migrations and rollback
`1864__knowledge__design_dna.sql`: expand-only (`mode`, `line`, `origin`, `dynamic`, `resolved_value`, all defaulted; `value` nullable but required unless `dynamic`), natural unique keys, `worker_knowledge` policies, INSERT grants, the `ANALYZING` guard trigger. Reversal in `.down.sql` (dev/staging; production forward-fix). Behaviour rollback: `KNOWLEDGE_DESIGN_ENABLED=false` (default).

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| Domain `design.spec.ts` | **24 passed**: colour parsing (hex, rgb, hsl, oklch, named) and refusal of what cannot be evaluated, WCAG ratio, categories, CSS reader (modes, schemes, `@theme`, SCSS/Less, negatives, hostile input, fuzz), token JSON (W3C, Style Dictionary, `theme.json`, depth/size bombs, `__proto__`), Flutter reader, assembly (roles, usage evidence, resolution, cycles, dynamic never invented, unresolved reported, variants, determinism, bounds, projects) |
| Worker unit `ast/theme-config.spec.ts` | **6 passed**: Tailwind, MUI/Chakra/plain tokens, **no execution** (marker test), negatives, hostile input, fuzz |
| Worker unit `parser-sandbox.spec.ts` (design kinds added) | 35 passed (3 new: real-thread parity for the four kinds, reply-shape validation, hostile design input) |
| Domain unit total | 771 passed · worker unit 60 · admin 336 · i18n 9 · ui 24 · db 55 · adapter 26 · API unit 1070 |
| Worker integration, real PostgreSQL under `nuzm_worker` | **84 passed** (7 files; a first full run had three files fail at suite setup under extreme machine load and they passed on the rerun and in isolation) |
| `design-stage.int.spec.ts` | **11 passed**: Next.js + Tailwind end to end (tokens by mode, resolved references, dynamic entry without value, roles with evidence, contrast, variants, schema 1/2/3 manifests), Flutter, flags, quarantined/rejected never reach DESIGN, incrementality (1 file re-parsed, identical version 0), **no execution** (marker file absent), hostile package (minified, NUL, deep JSON/CSS, 4 000 custom properties, odd names), limit hits skipped and not cached, sandbox unavailable (retry then success), cancellation in flight (nothing written), own-sandbox lifecycle, worker write limits |
| API integration, knowledge | 59 passed (2 new: design/tokens/variants with filters, paging, 422s, cross-resource 404, customer denied; DESIGN retry) |
| Other integration | db 93 · platform 32 |
| Browser E2E `15-ai-ingestion.spec.ts` (Arabic + English, real worker process, design on, threads started from source) | **8/8 passed**, axe WCAG A/AA clean; the Next.js sample shows roles, contrast, traits and tokens; the Flutter sample shows the `#1e88e5` primary and Material 3; database checks: tokens written with files and modes, none without a value unless dynamic, DNA rows, schema 1/2/3 manifests, variants |
| `pnpm lint`, `pnpm typecheck` (52/52), `pnpm build` (28/28), `pnpm spec:lint`, `pnpm spec:drift` (484 routes), `pnpm sdk:check`, `pnpm compliance:claims-guard` | PASS |
| `db:test-rls`, `compliance:classification-coverage` (3341 columns in 265 tables) | PASS against this worktree's database (`DATABASE_ADMIN_URL=…:54339/nuzm_dev`) |
| Migration reversal (1864 down, then up again) | PASS on a scratch database: migrated to head (5 new columns), `1864…down.sql` applied (0), `1864…sql` applied again (5); database dropped |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched); mine are clean |
Not run: `pnpm verify:full`; the full API integration suite (only the knowledge subset, the API changes being confined to that module).

## F. Security, tenant isolation, billing, residency
- Parse-only and bounded, in the isolated parser threads: configuration is never required or evaluated (marker tests at unit, integration and worker-process levels); every name from source is restricted to a safe alphabet and used only as a value or in a map; limits (time, heap, size, nodes, result size, stage budget, failure breaker) are those of the sandbox and proved with hostile inputs for all four kinds.
- Isolation: tokens and variants are platform rows written only under the worker scope and only for a version in `ANALYZING`, insert-only, natural keys; customers read none of this schema; the UI puts only analyzer-produced hex into style attributes. Audit: unchanged API audit events; worker steps in `processing_logs` (`design.begin`, `design.parser`/`design.parser_limits`, `design.done`). Billing/metering: none. Residency: no vendor call.
- Known gaps: wall time stands in for CPU time (Node 22); no OS-level boundary around the parser threads (a deployment concern); the worker still does not write to the hash-chained audit log.

## G. Human gates and live checks still needed
- **D-42 (BLOCKS production)**: provider, region, retention, bucket policy, vault credentials, `selfTest()` against the real bucket, attestation `HG-…` (see `D-42-D-45-status.md`). Nothing in this slice touches those gates; production uploads, ingestion, detection, component and design analysis stay off.
- **D-45**: approach decided; the grammar's selection, licence, pin and build provenance and the dependency review need the owner's go-ahead. Flutter themes are read by the lexical reader until then.
- D-21 (no browser/build sandbox): rendering and screenshots of themes stay blocked. D-43 (counsel review for commercial themes) and D-44 (no malware claim) unchanged.

## H. Acceptance checklist (S-K4 criteria)
| Criterion | Status |
|---|---|
| Design DNA with evidence for every value, for a Tailwind/CSS-variables theme and a Flutter `ThemeData` app (integration + E2E) | PASS |
| Computed values are `dynamic`, never invented; unresolved references reported | PASS |
| Deterministic; incremental by content hash (changed file re-parsed alone; identical version parses none; limit hits not cached) | PASS |
| Nothing executed (marker tests); hostile CSS/JSON/config/Dart contained by the sandbox limits | PASS |
| Positive, negative, ambiguous (dark/light, several schemes, scoped properties), fuzz tests; integration through the worker; cross-tenant and write-limit tests | PASS |
| Arabic/English UI with e2e, axe and screenshots | PASS |
| Spec lint, drift, SDK, ownership classification | PASS |
| Flag default off; quarantine, approval, audit, tenant isolation unchanged; production blocked on D-42 | PASS / BLOCKED (D-42) |
| Screenshots of rendered themes | BLOCKED (D-21), not attempted |
| Bundled tree-sitter Dart grammar | NOT BUILT (D-45 dependency go-ahead needed) |

## I. Handoff
Next slices of the S-K plan (`AUDIT_AND_PLAN.md`): S-K5 (retrieval and recommendation over components, relationships, tokens and the Design DNA: lexical + metadata + symbol first, D-47; recommendation weights D-48), then S-K6/S-K7. Open for the owner: go-ahead for S-K5; the D-45 grammar dependency review; D-42 items; reuse permissions for design values (explicit, publish-gated, D-43).
