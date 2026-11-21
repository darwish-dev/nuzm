# S-K2c preparation — AST-based component and architecture analysis

Date: 2026-11-21 · Status: **PREPARED, not started** · Depends on S-K2a (snapshots, file inventory), S-K2b (manifest, project boundaries, routes) · Plan section: `S-K2-PLAN.md` §7.
Rule unchanged: **nothing from a package is executed, installed, built or imported**; analysis is parse-only, bounded, deterministic, evidence-backed, and runs in the isolated worker (`nuzm_worker`, scope `knowledge`).

## 1. What S-K2b leaves for S-K2c
| S-K2b output | Limit it has | What S-K2c does with it |
|---|---|---|
| `projects[]`, `workspaces[]`, `entryPoints[]` | boundaries by manifest, not by import | uses them as analysis units and resolves cross-project imports inside the workspace |
| `routes[]` (Next by path; Nest, Flutter by line patterns) | heuristic, confidence 0.7–0.9 | replaces patterns with AST facts (decorators, `GoRoute` calls), keeps the S-K2b rows as the fallback and records which source won |
| `screens[]`, `moduleFacts[]` | class-name heuristics (`*Screen/*Page/*View`) | real widget/component discovery with props, children and usage |
| `components: []` | reserved | filled: component registry rows |
| `capabilities[]` from dependencies | dependency presence only | adds usage evidence (imports and call sites of the library) and lowers confidence for unused dependencies |

## 2. Scope of S-K2c
1. **TypeScript/JavaScript (and TSX/JSX)**: the TypeScript compiler API in *parse-only* mode (`ts.createSourceFile`, no program, no type-check, no module resolution from disk, no plugins, no `require`), with a per-file node and time
   budget. Extract: exports, React components (function/class/`forwardRef`/`memo`), props (from type annotations and destructuring), hooks used, JSX element usage (component graph), Next.js `metadata`/`generateStaticParams`/server
   actions (`'use server'`), Nest decorators with arguments (modules → controllers → providers graph, guards, DTO classes), imports/exports (relative imports resolved inside the snapshot only), route handlers with exported methods.
2. **Dart/Flutter** (decision D-45: bundled tree-sitter grammar, WASM or native binding, parse-only): widgets (`StatelessWidget`, `StatefulWidget`, `ConsumerWidget`, …), `build()` widget trees (depth-limited), routes (`GoRoute`,
   `AutoRoute`, `GetPage`, named routes), providers/blocs, theme (`ThemeData`) tokens for S-K4, package imports.
3. **Architecture**: layers (feature folders, clean-architecture folders), module/dependency graph (internal imports → `resource_relationships`), entry-point reachability, circular-import detection, public-surface of libraries,
   `resource_components` rows (`name, kind, framework, path, props, dependencies, style_deps, assets, platforms, reuse_allowed=false`, never allowed automatically).
4. **Incrementality**: `analysis_results` keyed by `(version, analyzer, analyzer_version, content_hash)` — unchanged files are not re-parsed; a new analyzer version re-runs only its own results.
5. **Jobs**: `ANALYZE` and `COMPONENTS` (existing kinds) after DETECT; the version stays `ANALYZING` until the last stage commits; a stage failure degrades to "no component data" with an ambiguity, never to claims without evidence.

## 3. Architecture and safety decisions to confirm before starting
| Topic | Proposal | Why |
|---|---|---|
| Parser isolation | run parsing in a `worker_threads` worker with `resourceLimits` (memory) and a hard timeout; the thread has no DB, no network, no environment | a parser bug or a pathological file cannot take the ingestion worker down; this is the "isolated worker" hardening S-K2a deferred |
| TypeScript dependency | `typescript` as a worker dependency, used only for `createSourceFile` | already in the monorepo; no extra parser to vet |
| Dart parser (D-45) | tree-sitter-dart, pinned, built to WASM, loaded from the repo (no download at run time) | deterministic and offline; needs owner confirmation of the grammar's licence |
| Output size | per-version caps (components 5 000, relationships 20 000, props 50 per component); everything over is counted, not stored | keeps rows and manifests bounded |
| Evidence | every component, route and relationship stores `path:line` of the node that proves it | same rule as S-K2b |
| Security tests | parse bombs (deep nesting, 10 MB single line, 1M-token files, invalid UTF-8, NUL bytes), prototype-pollution names, decorator injection strings, generated minified bundles (skipped by a size/line heuristic and reported) | the same hostile-input discipline as S-K2a/b |

## 4. Acceptance criteria for S-K2c
1. Components and imports of the three sample packages (Next.js theme, Flutter starter, Next.js + NestJS) are found and match committed golden outputs; routes from AST agree with or refine the S-K2b routes.
2. No fact without evidence; unresolved imports are listed as external or unresolved, never guessed; dynamic imports and computed routes are reported as `dynamic`.
3. Incremental: re-analysing an unchanged version writes nothing; changing one file re-parses only that file.
4. Parse-only proven: a package containing code that would leave a marker if run leaves none; parser limits proven by hostile fixtures; thread isolation proven by a killed-on-timeout test.
5. Positive, negative (a README that shows code, commented-out code, strings that look like components), ambiguous (re-exports, barrel files, HOCs) and fuzz tests; hostile-input and integration tests through the existing worker architecture;
   Arabic/English UI for the component and architecture views with e2e and screenshots.
6. Flags: `KNOWLEDGE_COMPONENTS_ENABLED` default off; quarantine, review, audit and tenant isolation unchanged; production activation stays blocked until D-42 is verified against a real provider.

## 5. Dependencies and open items
- D-45 (Dart parser) must be confirmed; D-42 remains the production gate; D-43/D-44 unchanged.
- Design DNA extraction (tokens, variants) is S-K4 and consumes the S-K2c theme facts; retrieval (S-K5) consumes components and relationships.
- Wire the platform dependency deny-list into the dependency scan (needs the policy extracted into a shared module).
- Estimated work: parser isolation (1), TS analyzers (2), Dart analyzer (2), architecture graph (1), persistence and incrementality (1), API/UI (1), tests and golden outputs (2).
