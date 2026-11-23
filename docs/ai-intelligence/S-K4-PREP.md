# S-K4 preparation — Design DNA and theme intelligence

Date: 2026-11-21 · Status: **IMPLEMENTED 2026-11-21 (see docs/reports/K-S4-report.md and SCR-K-06)** · Depends on S-K2a (snapshots, file inventory), S-K2b (manifest), S-K2c (components, style imports, `hasTheme`) and the parser sandbox (SCR-K-05) · Plan: `AUDIT_AND_PLAN.md` §5 (S-K4), ADR-065 point 6.
Rule unchanged: **nothing from a package is executed, installed, built or imported**. A theme's configuration files (`tailwind.config.js`, `theme.ts`, `tokens.js`) are JavaScript: they are READ as syntax trees, never `require`d or evaluated. All parsing of package content runs in the parser sandbox with its limits.

## 1. What S-K2c leaves for S-K4
| Available now | Where | Use in S-K4 |
|---|---|---|
| Style imports per component (`styleDeps`), asset imports, `hasTheme` for `ThemeData` | `resource_components`, per-file facts | which stylesheets and theme files belong to which components |
| Per-project frameworks, build config, workspaces | schema-1/2 manifest | choose analyzers (Tailwind v3/v4, CSS Modules, styled-components, MUI/Chakra, Flutter) |
| Tables `knowledge.theme_tokens` (category, name, value, source_path) and `knowledge.theme_variants` (kind, name, descriptor jsonb, preview_key) | migration 1860 | storage; RLS exists, worker policies and grants do NOT yet |
| Parser sandbox (typed limits, kill on timeout, empty environment) | `apps/worker/src/knowledge/ast/` | run the CSS, config-AST and (after D-45 work) tree-sitter analyzers |
| Cache by content hash in `analysis_results` | S-K2c | same incremental rule |

## 2. Scope
1. **Tokens from static sources**: CSS custom properties (`:root`, `[data-theme]`, `.dark`), Tailwind config read as an AST (theme/extend: colors, fontFamily, spacing, borderRadius, boxShadow, screens, animation), Tailwind v4 `@theme`, SCSS/Less variables (declarations only, no compilation), `theme.json`/design-token JSON (W3C-style), JS/TS theme objects (MUI `createTheme`, Chakra `extendTheme`, vanilla-extract/stitches shapes read as literals only), Flutter `ThemeData`/`ColorScheme`/`TextTheme` (through the lexical analyzer now, tree-sitter later). A value that is computed (a function call, a variable from outside the file) is recorded as `dynamic` with its source, never guessed.
2. **Design DNA** (a schema-versioned JSON per version, stored as an analysis result and summarised in the manifest): palette with roles (primary, surface, text, accent, semantic) derived from names AND usage evidence, light/dark modes, typography scale and families, spacing and radius scales, elevation, breakpoints, motion; contrast ratios of role pairs computed arithmetically (WCAG formula, no rendering); density and layout traits only when evidenced (sidebar/header/grid components from S-K2c); every field carries `path:line` evidence and a confidence.
3. **Variants** (`theme_variants`): layouts, sidebars, headers, page templates, dashboard shells, detected from components and routes (S-K2c), each with a descriptor and the evidence.
4. **Screenshot references**: stored references only (key + hash) for owner-uploaded previews; **rendering a theme to a screenshot is BLOCKED (D-21: no browser/build sandbox accepted)** and stays so.
5. **Admin UI** (Arabic/English): a "Design DNA" card on the version page (palette swatches with names and contrast, type scale, spacing, variants, evidence list, not-reusable marker), states loading/empty/error/forbidden.
6. **API**: read endpoints for tokens, variants and the DNA document (platform admin, `admin:ai_knowledge:read`); spec first.

## 3. Proposals to confirm (defaults are the restrictive, reversible choice)
| Topic | Proposal | Why |
|---|---|---|
| CSS parsing | a small hand-written tokenizer for declarations and at-rules inside the sandbox (no new dependency), bounded by the same limits | no supply-chain addition; the grammar needed (custom properties, `@theme`, `@media` names) is small. A parser library (postcss) only with dependency review |
| Config files | TypeScript-API AST of the object literal; references resolved only inside the same file; `require`, spread of imports and function calls become `dynamic` | never evaluates user code |
| Sandbox | extend `FileKind` with `css`, `theme-config`; same limits | one isolation mechanism |
| Flags | `KNOWLEDGE_DESIGN_ENABLED` (default off, needs components); feature flag at the API | CLAUDE.md §4 |
| Persistence | worker policies and INSERT grants on `theme_tokens`, `theme_variants` (platform rows only, `ANALYZING` guard), natural keys, append-only | same pattern as migration 1863 |
| Stage | `DESIGN` job after COMPONENTS, one transaction, cancel/retry like the others | same queue |
| Tokens never reusable | `reuse_allowed` semantics stay false; reuse is a later permission-gated decision | D-43 |

## 4. Acceptance criteria
1. Golden Design DNA for three sample themes (a Tailwind dashboard theme, a CSS-variables theme, a Flutter `ThemeData` app) with evidence for every value; a theme with only computed values yields `dynamic`, not invented numbers.
2. Deterministic: same input, same bytes; incremental by content hash.
3. Nothing executed: a config file containing code that would leave a marker leaves none; hostile CSS/config (huge files, deep nesting, 100 000 declarations, odd names, `__proto__`) contained by the sandbox limits.
4. Positive, negative (colours in comments or strings, README snippets), ambiguous (several themes in one package, dark/light duplicates) and fuzz tests; integration through the worker; cross-tenant and write-limit tests like S-K2c.
5. Arabic/English UI with e2e, axe and screenshots; spec lint/drift/SDK checks.
6. Flag off by default; quarantine, approval, audit, tenant isolation unchanged; production blocked on D-42.

## 5. Dependencies and open items
- **D-42** stays the production gate. **D-45**: the approach is decided; the Dart grammar (selection, licence, pin, WASM provenance, dependency review) needs the owner's go-ahead and is not required for the CSS/Tailwind/JS parts, so S-K4 can start without it, using the lexical `ThemeData` reader for Flutter.
- **D-21** blocks rendering/screenshots; S-K4 stays static.
- Retrieval over tokens and DNA is S-K5; generation use is S-K6/S-K7.
- Estimated work: CSS and config analyzers (2), DNA assembly and contrast (1), migration and worker stage (1), API/UI (1), tests and golden outputs (2).
