# AI Intelligence Center — slice S-K2b report (framework detection and project manifest) — test report

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K2a commit `a37c2a0` preserved; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; the stage is OFF by default (`KNOWLEDGE_DETECT_ENABLED`); production activation stays BLOCKED on D-42**.
Governing documents: ADR-065 (addendum B), SCR-K-03 (`docs/spec-change-requests/SCR-K-03-project-detection.md`), plan `docs/ai-intelligence/S-K2-PLAN.md` §6–7, preparation of the next slice `docs/ai-intelligence/S-K2c-PREP.md`.

## A. Repository findings and assumptions
- S-K2a ends a clean package at `AWAITING_REVIEW` after EXTRACT. S-K2b inserts a DETECT stage before review: the same queue, lease, cancel, retry and dead-letter machinery; the same `nuzm_worker` role and scope.
- Assumptions: (1) AST-level analysis (props, widget trees, import graphs) is S-K2c, so routes, screens and modules in S-K2b are labelled static heuristics with confidence; (2) a package wrapped in one top-level folder keeps that folder in every path
  (roots are reported as found); (3) a project under `example/test/docs/samples/template` folders is listed but not counted as the package's framework unless nothing else exists; (4) the platform dependency deny-list is not wired (it lives in the API module).
- Environment: another workspace owns Postgres :54329, so this worktree used its own cluster :54339 and E2E ports 3300/3301/4300/4310 (nothing of the other workspace was touched).

## B. Plan and changed files
- `packages/domain/src/knowledge/detect/**`: `types, util, lock, manifests, rules, routes, analyze, testing/fixtures`, golden manifests (`golden/*.json`), `detect.spec.ts`.
- `packages/db/migrations/knowledge/1862__knowledge__project_detection(.down).sql`.
- `apps/worker/src/knowledge/ingest-service.ts` (DETECT stage, EXTRACT hand-off), `main.ts` (flag), `detect-stage.int.spec.ts`.
- `apps/api/src/modules/knowledge/{internal/review.service.ts, admin-knowledge-processing.controller.ts}` (manifest endpoint, DETECT retry), `review.int.spec.ts`; `spec/openapi/openapi.yaml` (+1 operation, +1 schema), `packages/sdk/src/schema.ts`.
- Admin UI: `components/KnowledgeIngestion.tsx` ("Detected project" card), `lib/knowledge.ts`, 72 message keys (ar/en), spec additions.
- E2E: `e2e/tests/15-ai-ingestion.spec.ts` (+1b, DETECT assertions); `.prettierignore` (golden files), `.env.example`.
- Docs: this report, SCR-K-03, ADR-065 addendum B, S-K2c preparation, plan status.

## C. Implemented
1. **Detection** (static, deterministic, no execution): Next.js (app/pages router), React, React Native, Expo, Vue, Nuxt, Angular, Svelte, NestJS, Express, Fastify, Koa, Hono, **Node.js**, **Flutter**, **Dart** (+ Dart Frog, Shelf, Serverpod), Django, Flask, FastAPI, Laravel; TypeScript, Tailwind, Prisma, TypeORM, Drizzle, Vite, Storybook, Bloc, Riverpod, Provider, GetX, go_router. Full-stack combinations are per application (a pnpm/Turborepo monorepo with a Next.js app, a NestJS API and a UI library is reported as three projects with their own detections, roles and routes).
2. **Manifest** (schema `1`, analyzer `project-detect@1.0.0`): frameworks/languages/versions (lockfile or declared), package managers (npm, pnpm, yarn, bun, pub, pip, poetry, pipenv, composer, go, bundler), projects and kinds (application, library, example, workspace root), workspaces (pnpm, npm/yarn, lerna, nx, turbo, melos, convention), entry points, build configuration (scripts, tsconfig, Docker base images, CI files, Flutter platforms and SDK constraints), dependencies (with resolved versions), routes, screens, modules, capabilities (24 kinds), ambiguities, stats and truncation markers. Every detection and capability has evidence (`path`, `line`, `kind`, `detail`) and a derived confidence level.
3. **Ambiguity handling**: 11 reported cases (Next without routes, Nest without main, dev-dependency-only frameworks, conflicting UI frameworks, mixed ecosystems, Flutter layout without the SDK, several lockfiles, only-example packages, examples excluded, no manifest, analyzer failure).
4. **Pipeline**: clean EXTRACT queues DETECT in the same transaction; the version stays `ANALYZING`; DETECT writes the manifest and an analysis result and moves the version to `AWAITING_REVIEW`. Quarantined or rejected packages never reach it. Cancellation, lease loss, retry, dead letter and an operator retry (`reprocessing` re-queues DETECT) are covered. An analyzer fault stores an empty manifest with `detection_failed` instead of blocking the package.
5. **Controls preserved**: S-K2a quarantine, two-person approval, activation guard, audit and tenant isolation unchanged; the worker can write a manifest only for a platform version in `ANALYZING` (database trigger), bounded in size, append-only.
6. **API/UI**: `getKnowledgeManifest`; the resource summary now shows real frameworks/capabilities with evidence; a "Detected project" card (Arabic/English, loading/empty/error/forbidden states, paged routes, translated ambiguities).

## D. Migrations and rollback
`1862__knowledge__project_detection.sql`: size checks on manifests (2 MB) and analysis results (200 KB), `worker_knowledge` policies and INSERT grants, trigger `worker_derived_guard`. Down note in the `.down.sql` (dev/staging; production forward-fix, manifests are evidence). Behavioural rollback: `KNOWLEDGE_DETECT_ENABLED=false` (default) restores the S-K2a flow.

## E. Test report (actual results, this worktree)
| Suite | Result |
|---|---|
| Detection unit tests (`detect.spec.ts`) | **32 passed**: 7 positive fixtures (Next app + pages router, NestJS, Flutter, Dart CLI, pnpm+Turbo full stack, React/Vite, Express/yarn, Django, Laravel), 5 negative (README-only, empty/absent manifest, Flutter-shaped folder without pubspec, dev-only framework, Dart-not-Flutter, vendored examples), 3 ambiguous groups, determinism (shuffled file order → byte-identical), no-execution marker, read minimisation, budgets (reads, bytes, time, projects, routes), 6 hostile-input cases (prototype pollution keys, 200-deep JSON, 20 000-entry dependency list, 400 KB lines, a million `@Controller(` tokens, control/bidi characters, odd paths, manifest size), a 300-run property/fuzz test, an evidence-integrity test over every fixture, **6 golden manifests** pinned byte for byte |
| Domain package total | 730 passed (122 in `knowledge`: 67 archive, 16 scanners, 7 ingest, 32 detection) |
| Worker integration (real PostgreSQL, role `nuzm_worker`) | **56 passed** (11 new for DETECT: stage order and states, manifest/analysis rows, append-only, blocked/rejected never reach DETECT, flag off = S-K2a flow, flag off leaves a queued DETECT alone, hostile manifests inside a package, no execution, cancellation mid-detection, dead letter, worker write limits) |
| API integration | 1964 passed, 1 failed, 2 skipped; 21 knowledge review tests (4 new: manifest null/real, resource summary, cross-resource 404, DETECT retry and refusal after a manifest exists). The 1 failure is `domains-search` registrar probe matrix: pre-existing, caused by another session's DNet registrar, unrelated |
| Other integration | db 93, platform 32 passed |
| Admin component tests | 323 passed (6 new for the manifest card, incl. Arabic) |
| Browser E2E `15-ai-ingestion.spec.ts` (Arabic + English, real worker process, DETECT on) | **8/8 passed**, axe WCAG A/AA clean; new test 1b detects the Flutter and full-stack sample packages from their files; screenshots `docs/reports/screenshots/{ar,en}/ai-ingestion-*.png` incl. `-manifest-flutter` and `-manifest-fullstack` |
| `pnpm lint`, `pnpm typecheck` (52/52), `pnpm build` (28/28), spec lint/drift (479 routes), SDK check, claims guard, classification coverage (3336 columns), `db:test-rls` | PASS |
| `pnpm scan:secrets` | one hit, in another session's file (`registrar-dnet-settings.spec.ts:9`, untouched); mine are clean |
| Unit run under load | one timing flake (S3 multipart cases, 5 s default under parallel load) fixed with a 60 s test timeout and re-run green |
Not run: `pnpm verify:full` (the browser E2E of other milestones was not re-run; only 15, the file this slice touches, plus its shared config change).

## F. Security, tenant isolation, billing, residency
- Static analysis only: manifests/configs are read as text; a config file and a lifecycle script that would leave a marker were never run (unit, worker and E2E). Reads are limited to stored files, 512 KiB each, with total, count, project, route and time budgets; every cut is reported.
- Output hygiene: package text reaches a manifest only through a printable, length-limited filter; route text is restricted to a route alphabet; hostile names become `(invalid)`; regex work is line-based with capped line length (linear on hostile input).
- Isolation: manifests are platform rows written under the dedicated worker scope; customers read none of this schema; the worker cannot write a manifest for a customer row or for a version that is not being analysed (tested with the real role).
- Billing/metering: none. Residency: no vendor call. Audit: unchanged API audit events; worker steps in `processing_logs` (`detect.begin|done|degraded`). Known gap carried from S-K2a: the worker does not write the hash-chained audit log.

## G. Human gates and live checks still needed
- **D-42 (BLOCKING production)**: real provider, region, retention, `selfTest()` against the real bucket, vault credentials, attestation `HG-…`. The S3 adapter is verified only against a signature-verifying fake (NOT VERIFIED against a real provider); production uploads, ingestion and detection stay off.
- D-43 (counsel review for commercial themes), D-44 (no malware claim), D-45 (Dart parser, needed by S-K2c).

## H. Acceptance checklist
| Requirement | Status |
|---|---|
| Detection for Next.js, React, NestJS, Node.js, Flutter, Dart and supported full-stack combinations | PASS (unit, golden, worker, E2E) |
| Manifest: frameworks, languages, versions, package managers | PASS |
| Manifest: structure, workspaces, application boundaries | PASS |
| Manifest: dependencies and build configuration | PASS |
| Manifest: routes, screens, modules, capabilities | PASS as static heuristics with confidence (AST precision is S-K2c) |
| Evidence paths and confidence for every detection | PASS (property test over all fixtures) |
| Static, deterministic, never executes uploaded code | PASS |
| Positive and negative fixtures, ambiguous-project handling | PASS |
| Security tests (hostile input, resource limits, no execution) | PASS |
| Integration tests on the existing worker architecture | PASS |
| S-K2a quarantine, approval, audit, tenant isolation preserved | PASS (all S-K2a suites re-run green) |
| Production activation blocked until D-42 verified on a real provider | BLOCKED (D-42), unchanged |
| Detection of Python/PHP beyond dependency evidence, Ruby, Go frameworks | NOT BUILT (dependency-level only; out of the requested set) |

## I. Handoff: S-K2c
`docs/ai-intelligence/S-K2c-PREP.md`: scope (parse-only TypeScript compiler API, Dart via a bundled tree-sitter grammar — D-45, architecture graph, components registry, incremental analysis), the S-K2b facts it refines, proposed thread isolation with memory/time limits for the parsers, hostile-input test plan, acceptance criteria and dependencies. Open decisions: D-45, D-42; carried items: worker audit-chain writes, dependency deny-list wiring.
