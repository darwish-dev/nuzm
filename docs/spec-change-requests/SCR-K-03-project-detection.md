# SCR-K-03 — Project detection and the project manifest (AI Intelligence Center, slice S-K2b)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (addendum B), SCR-K-01 (approved) and SCR-K-02 (S-K2a).
Platform-admin only, behind the flag `knowledge.library`; the worker stage is behind `KNOWLEDGE_DETECT_ENABLED` (default **off**).

## 1. What it adds
A static, deterministic analysis of an ingested package that produces an evidence-backed **project manifest** (frameworks, versions, package managers, projects and workspaces, build configuration,
dependencies, routes, screens, modules, capabilities, ambiguities). It reads only TEXT that S-K2a already stored in the snapshot; it never executes, imports, installs or resolves anything.

## 2. Rules the analyzer follows (all tested)
1. **No detection without evidence.** Every detection and capability carries evidence items `{kind, path, line?, detail?}` (a dependency line, a config file, an entry point, a directory convention). Prose
   (README, docs) is never evidence. Evidence points at real paths of the package.
2. **Confidence is derived, not guessed**: a runtime dependency 0.6, dev 0.4, peer 0.3; a config file +0.25; a structure/entry-point +0.1–0.15; capped at 0.99. `high ≥ 0.8`, `medium ≥ 0.5`, `low` below. A framework counts for the
   package (`frameworks[]`) only at ≥ 0.5.
3. **Versions**: from a lockfile when one is readable (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `pubspec.lock`), otherwise the declared range's first number, labelled `declared`.
4. **Ambiguity is reported, not resolved**: `next_without_routes`, `nest_without_main`, `framework_dev_dependency_only`, `conflicting_frameworks`, `mixed_ecosystems`, `flutter_layout_without_sdk`, `multiple_package_managers`,
   `only_example_paths`, `examples_excluded`, `no_manifest`, `detection_failed`.
5. **Examples are not the package**: projects under `example(s)`, `test(s)`, `e2e`, `docs`, `samples`, `templates`, … are listed with kind `example` and excluded from `frameworks[]` (unless nothing else exists).
6. **Bounded**: 512 KiB per file read, 24 MiB / 4000 files / 200 projects / 1500 routes per package, a 60 s budget; every cut is named in `stats.truncated`. Text from the package reaches the manifest only through a printable,
   single-line, length-limited filter; route text is restricted to a route alphabet (anything else becomes `(invalid)`); regex work is line-based with capped line length.
7. **Deterministic**: everything is sorted; no timestamps; the same package in any file order gives byte-identical output (golden manifests pin the output).

## 3. Detected
Frameworks and runtimes: Next.js (app and pages router), React, React Native, Expo, Vue, Nuxt, Angular, Svelte, NestJS, Express, Fastify, Koa, Hono, Node.js, Flutter, Dart (and Dart Frog, Shelf, Serverpod), Django, Flask,
FastAPI, Laravel; tools and libraries: TypeScript, Tailwind CSS, Prisma, TypeORM, Drizzle, Vite, Storybook, Bloc, Riverpod, Provider, GetX, go_router.
Package managers: npm, pnpm, yarn, bun, pub, pip, poetry, pipenv, composer, go, bundler (from `packageManager`, lockfiles, manifests; none is assumed when there is no evidence).
Workspaces: pnpm, npm/yarn `workspaces`, lerna, nx, turbo, melos, and the `apps/*`, `packages/*` convention.
Routes and structure: Next.js routes from the folder convention (groups and slots removed, dynamic segments kept, route-handler methods), NestJS controllers/routes/modules (global prefix applied), Flutter screens and routes
(`GoRoute`, named routes, `GetPage`, `auto_route`), entry points, build scripts, tsconfig facts, Dockerfile base images, CI files, Flutter platforms and SDK constraints.
Capabilities (dependency and structure signals): authentication, database access, internationalization, styling system, state management, data fetching, forms and validation, automated testing, API documentation, real-time,
payments, charts, animation, maps, push notifications, analytics and monitoring, component documentation, background jobs, configuration, HTTP API, request middleware, authorization guards, containerization, continuous integration.
Component-level analysis (props, imports, widget trees) is **S-K2c**; `components` is reserved and empty.

## 4. Database (migration `1862__knowledge__project_detection`, down note in `.down.sql`)
- `resource_manifests` and `analysis_results`: size checks (2 MB / 200 KB); policy `worker_knowledge` and `INSERT` for `nuzm_worker` on platform rows only; trigger `worker_derived_guard`: the worker may write them only for a
  version in `ANALYZING`. Both tables stay append-only (S-K1). No new table, no ownership change.
- State machine, activation guard and review guard of 1861 are unchanged: a clean package reaches `AWAITING_REVIEW` only after DETECT succeeded; blocked or rejected packages never reach DETECT; approvals still belong to the
  EXTRACT analysis.

## 5. Worker
`KNOWLEDGE_DETECT_ENABLED=true` (with `KNOWLEDGE_INGEST_ENABLED=true`): a clean EXTRACT queues `DETECT` in the same transaction and keeps the version `ANALYZING`; DETECT reads the stored files, writes the manifest and an analysis result
(`project-detect`, version, content hash), merges a `detect` summary into `ingest_summary`, and moves the version to `AWAITING_REVIEW`. Cancellation and lease loss stop it without writing; an infrastructure failure is retried and then
dead-lettered (version `FAILED`, retry with `reprocessing`, which re-queues DETECT for an analysed version without a manifest); an analyzer fault stores an empty manifest with the ambiguity `detection_failed` instead of holding
the package hostage. With the flag off the S-K2a flow is unchanged (EXTRACT → review).

## 6. API (platform admin)
| Operation | Path | Permission |
|---|---|---|
| `getKnowledgeManifest` (new) | `GET /v1/admin/knowledge/resources/{id}/versions/{versionId}/manifest` → `{versionId, schemaVersion, createdAt, manifest}` (`manifest: null` before detection) | `admin:ai_knowledge:read` |
| `reprocessKnowledgeVersion` (extended) | re-queues DETECT for an analysed version whose detection failed (no manifest) | `admin:ai_knowledge:manage` |
The resource summary (`manifest` in `KnowledgeResourceDetail`) now reads real data: frameworks, languages, modules and capabilities with evidence.

## 7. Admin UI
A "Detected project" card on the version review panel (Arabic/English): frameworks with version, source (lockfile/declared), confidence and evidence; languages; package managers; projects and boundaries; workspaces; capabilities
with evidence; routes (paged), screens and modules; translated ambiguities; truncation notice. States: loading, empty (not run), error, forbidden.

## 8. Not in this change
AST/component/architecture analysis and import graphs (S-K2c); Design DNA (S-K4); retrieval (S-K5); a platform dependency deny-list wiring; production activation (D-42 is unverified against a real provider).

## 9. Rollback
`KNOWLEDGE_DETECT_ENABLED=false` (default) returns to the S-K2a flow; jobs already queued wait. Dev/staging: `1862__…down.sql`; production is forward-fix (manifests are evidence).
