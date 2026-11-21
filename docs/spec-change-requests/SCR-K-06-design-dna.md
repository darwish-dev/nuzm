# SCR-K-06 — Design DNA and theme intelligence (AI Intelligence Center, slice S-K4)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (addendum E), SCR-K-01 (approved), SCR-K-04, SCR-K-05. Prepared in `docs/ai-intelligence/S-K4-PREP.md`.
Platform-admin only, behind the flag `knowledge.library`; the worker stage is behind `KNOWLEDGE_DESIGN_ENABLED` (default **off**, needs `KNOWLEDGE_COMPONENTS_ENABLED`). Production stays blocked on D-42. Nothing is rendered or screenshotted (D-21).

## 1. What it adds
A static analysis of the visual language of a package: design tokens, colour roles per mode, WCAG contrast of role pairs, typography, spacing, radius, shadows, breakpoints, motion, traits (dark mode, several colour schemes, RTL, Arabic font, Tailwind, CSS variables, Material 3), and theme variants (colour schemes, layouts, sidebars, headers, page templates, screens). Every value carries the file and line (or token path) that proves it. It never executes, imports, installs or builds anything; configuration written in JavaScript is read as a syntax tree and never evaluated.

## 2. Decisions recorded (the S-K4-PREP proposals, as built)
| Topic | Built | Note |
|---|---|---|
| CSS, SCSS, Less | a linear, string- and parenthesis-aware reader inside the parser sandbox (no new dependency): custom properties with their mode (`:root`, `.dark`, `[data-theme=…]`, `@media (prefers-color-scheme: dark)`, named schemes, component-scoped), Tailwind v4 `@theme`, SCSS/Less variable declarations, how custom properties are used (background, text, border), RTL and logical-property evidence | not a stylesheet parser; nothing is compiled or imported |
| Token JSON | W3C design tokens (`$value`/`$type`), Style Dictionary, `theme.json` presets, plain nested tokens, `{alias}` references; `JSON.parse` under node and depth budgets | keys are only read, never assigned |
| JS/TS theme configuration | the TypeScript syntax tree (parse only): Tailwind `theme`/`extend`, `createTheme`, `extendTheme`, exported `theme`/`tokens`/`colors`/`palette` objects; spreads, calls, identifiers, functions and templates with parts are recorded as **dynamic** (location, no value) | `plugins`, `content`, `keyframes` are skipped |
| Flutter | the lexical reader (D-45's bundled grammar is decided but not yet bundled): colours (`Color(0x…)`, `fromARGB`, `fromRGBO`), colour scheme and theme parameters, text styles, font families, border radii, brightness | named colours kept as written |
| Isolation | the same parser sandbox (SCR-K-05) with four new file kinds (`css`, `tokens-json`, `theme-config`, `dart-theme`); replies are validated against the kind asked | same limits |
| References | `var(--x, fallback)` and `{alias.path}` are resolved inside the same project (mode first, then base), depth-limited and cycle-safe; anything unresolved is reported, never guessed | shadcn-style channels (`222 47% 11%`) are understood |
| Roles | inferred from token names AND how properties use them, with confidence and evidence; contrast is the WCAG ratio over resolved opaque colours (transparent colours are not rated) | roles per mode follow the cascade (base, overridden by the mode) |
| Reuse | design values carry no reuse permission; nothing here makes anything reusable | D-43 |

## 3. Database (migration `1864__knowledge__design_dna`, reversal in `.down.sql`; production forward-fix)
`theme_tokens` gains `mode`, `line`, `origin`, `dynamic`, `resolved_value` (every column defaulted; `value` becomes nullable but is required unless `dynamic`); natural unique keys on tokens `(version, file, mode, name)` and variants `(version, kind, name)`; policy `worker_knowledge` (platform rows only), `INSERT` grant to `nuzm_worker`, the `worker_derived_guard` trigger of 1862 (only for a version in `ANALYZING`); the worker has no UPDATE or DELETE. `spec/db/ownership.yaml` classifies the five new columns. No new table. The Design DNA document is an append-only `analysis_results` row (`design-dna`); the schema-3 manifest (append-only) is the schema-2 content plus a design summary.

## 4. Worker
`KNOWLEDGE_DESIGN_ENABLED=true` (with detect and components): COMPONENTS queues DESIGN in the same transaction instead of moving the version to review. DESIGN selects style, token, theme-config and Flutter theme files (not vendored, built, minified, test or generated; example projects excluded), reuses cached per-file facts (`design-file`, by content hash, across versions of the same resource), parses the rest through the shared lanes (cancellation, budget, failure breaker, typed skips, never cached when a limit was hit), assembles, and writes tokens, variants, the DNA row, the schema-3 manifest, the per-file cache and the `ingest_summary.design` merge in ONE transaction, then moves the version to `AWAITING_REVIEW`. Cancellation or lease loss writes nothing; an operator retry re-queues DESIGN for a version that has schema 2 but not 3.

## 5. API (platform admin, `admin:ai_knowledge:read`)
`GET /v1/admin/knowledge/resources/{id}/versions/{versionId}/design` (the DNA, or `design: null`), `.../theme-tokens` (`q`, `category`, `mode`, `origin`, `dynamic`, cursor) and `.../theme-variants` (`kind`, cursor). No new error code, permission or flag at the API; the manifest endpoint now serves schema 3 when it exists.

## 6. Admin UI
"Design DNA" card on the version page (Arabic/English): colour roles per mode as swatches with token, hex, confidence and evidence; every colour; contrast table with AA/AAA; typography, spacing with the base unit, radius, shadows, breakpoints, motion; traits; computed (dynamic) values with their location and the note that nothing is executed; searchable, filterable token table with resolved values; theme variants; a project and mode selector; the "not reusable yet" marker. States: loading, empty, error, forbidden. A colour reaches a style attribute only if it is a plain hex the analyzer produced.

## 7. Not in this change
Rendering or screenshots (D-21), the bundled tree-sitter Dart grammar (D-45, owner go-ahead for the dependency), retrieval over tokens (S-K5), generation use (S-K6/S-K7), reuse permissions, a CSS parser dependency, production activation (D-42).

## 8. Rollback
`KNOWLEDGE_DESIGN_ENABLED=false` (default) returns to the S-K2c flow; queued DESIGN jobs wait. Dev/staging: `1864__…down.sql`; production is forward-fix (derived evidence).
