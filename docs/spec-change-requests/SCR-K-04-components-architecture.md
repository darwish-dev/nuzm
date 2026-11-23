# SCR-K-04 — Component and architecture analysis (AI Intelligence Center, slice S-K2c)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (addendum C), SCR-K-01 (approved), SCR-K-02 (S-K2a), SCR-K-03 (S-K2b).
Platform-admin only, behind the flag `knowledge.library`; the worker stage is behind `KNOWLEDGE_COMPONENTS_ENABLED` (default **off**, needs `KNOWLEDGE_DETECT_ENABLED`). Prepared in `docs/ai-intelligence/S-K2c-PREP.md`.

## 1. What it adds
A parse-only analysis of the stored source files that fills the component registry (`resource_components`), the relationships (`resource_relationships`) and a schema-2 manifest (components + architecture), with the file and line that prove each fact.
It never executes, imports, installs or builds anything; it never resolves a module outside the snapshot.

## 2. Decisions recorded (the PREP proposals, as built)
| Topic | Built | Note |
|---|---|---|
| TypeScript/JavaScript | the TypeScript compiler API in **parse-only** mode (`ts.createSourceFile` only: no program, no type checker, no module resolution, no plugins), iterative traversal, node budget (400 000), minified/NUL files skipped | `typescript` is a worker dependency (pinned 5.9.3) |
| Dart (**D-45**) | an interim **lexical analyzer** (comments and string contents blanked, declarations read by brace matching); no grammar is bundled | D-45 is DECIDED (`docs/07`: bundled tree-sitter parsers, no SDK execution) but the grammar is not bundled yet (its selection, licence, pin and build provenance are still to be verified); until then the lexical analyzer is an interim, reversible and labelled as such. (An earlier text of this SCR said D-45 was undecided; corrected by SCR-K-05.) Reads widgets, state classes, state holders, Riverpod providers, constructor parameters with types, `build()` widget calls, imports, `GoRoute` → screen. Anything it cannot read with certainty is absent |
| Parser isolation | first built in-process under per-file limits; the isolated `worker_threads` sandbox was added afterwards (SCR-K-05, ADR-065 addendum D) | superseded |
| Incrementality | per-file facts are path-independent and cached by content hash in `analysis_results` (`ast-file`); an unchanged file is never parsed again, across versions of the same resource | proved: a changed file re-parses one file; an identical version parses none |
| Manifest | manifests are append-only: schema **2** is a second row (v1 content + `components`, `componentIndex`, `componentStats`, `architecture`); the API serves the newest | |
| Reuse | `reuse_allowed` is always `false`; the database policy refuses any other value from the worker | reuse is a later, explicit, permission-gated decision |

## 3. Facts extracted
- **React/Next.js** (TS/JS/TSX/JSX): function, arrow, `memo`/`forwardRef`/`observer`/`lazy`-wrapped and class components; props from declared types, inline types, intersections, `FC<Props>` and destructuring defaults (required/optional); hooks used; rendered children; imports with binding names (default, namespace, renamed), style and asset imports, `require` and literal dynamic imports; exports, re-exports (barrels), `'use client'`/`'use server'`, `metadata`/`generateStaticParams`. The default export of a route file becomes `next-page` or `next-layout` from the folder convention.
- **NestJS**: `@Module` (imports, controllers, providers, exports), `@Controller`, `@Injectable`, DTO classes (class-validator decorators), constructor injection, `@UseGuards`.
- **Flutter**: `StatelessWidget`, `StatefulWidget` (+ its `State`), Consumer/Hook/GetX widgets, Bloc/Cubit/ChangeNotifier/StateNotifier holders, Riverpod providers, constructor props with types, widget calls in `build`, `GoRoute(path, builder)` → screen, `ThemeData` presence.
- **Relationships** (evidence `path`, `line`): `renders`, `imports` (file → file, resolved inside the snapshot with tsconfig `paths`/`baseUrl`, relative and `package:` imports), `declares`, `exports`, `injects`, `guarded_by`, `state_of`, `routes_to`, `route_renders`.
- **Architecture**: layers (first-level folders classified by name), modules with weighted dependencies, circular imports (strongly connected components), reachability from entry points/routes/framework files, public surface of libraries, components nobody uses, skipped files by reason, unresolved imports, truncation markers.
- Caps: 3 000 files, 5 000 components, 20 000 relationships, 200 components/file, 40 props/component, 80 children/component; every cut is named.

## 4. Database (migration `1863__knowledge__components`, down note in `.down.sql`; production forward-fix)
Natural unique indexes on components `(version, path, name, kind)` and relationships `(version, from, to, relation)`; policy `worker_knowledge` (platform rows only; for components also `reuse_allowed = false`); `INSERT` grant to `nuzm_worker`; the `worker_derived_guard` trigger of 1862 (only for a version in `ANALYZING`). The worker has no UPDATE or DELETE on either table. No ownership change (no new table).

## 5. Worker
`KNOWLEDGE_COMPONENTS_ENABLED=true` (with detect): DETECT queues COMPONENTS in the same transaction instead of moving to review; COMPONENTS selects candidate files (TS/JS/Dart with stored content; test, spec, story, generated, `dist`, `.d.ts`, minified files and example projects excluded), reuses cached per-file facts, parses the rest, assembles, and writes components, relationships, the schema-2 manifest, the per-file cache, an `ast-components` result and the `ingest_summary.components` merge in ONE transaction, then moves the version to `AWAITING_REVIEW`. Cancellation or lease loss stops it with nothing written; an operator retry (`reprocessing`) re-queues COMPONENTS for a version with only the schema-1 manifest. With the flag off the S-K2b flow is unchanged.

## 6. API (platform admin, `admin:ai_knowledge:read`)
`GET /v1/admin/knowledge/resources/{id}/versions/{versionId}/components` (`q`, `kind`, `framework`, cursor) and `.../relationships` (`relation`, `ref`, cursor); `getKnowledgeManifest` now returns the schema-2 manifest when it exists. No new error code, permission or flag at the API.

## 7. Admin UI
"Components and architecture" card on the version page (Arabic/English): searchable, filterable component table, details with props, dependencies, style imports, assets, platforms and the component's relationships, a "not reusable yet" marker; the architecture panel (layers, modules, cycles, reachability, library surface, unused components, skipped files, truncation). States: loading, empty, error, forbidden.

## 8. Not in this change
Design DNA and theme tokens (S-K4), retrieval/recommendation (S-K5), generation (S-K7), the bundled Dart grammar (D-45), a parser thread sandbox (built in SCR-K-05), cross-package dependency resolution of workspaces beyond tsconfig aliases, and production activation (D-42).

## 9. Rollback
`KNOWLEDGE_COMPONENTS_ENABLED=false` (default) returns to the S-K2b flow; queued COMPONENTS jobs wait. Dev/staging: `1863__…down.sql`; production is forward-fix (derived evidence).
