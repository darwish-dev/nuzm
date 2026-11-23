# AI Intelligence Center — slice S-K2c report (component and architecture analysis)

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K2a `a37c2a0` and S-K2b `c59d148` preserved; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; the stage is OFF by default (`KNOWLEDGE_COMPONENTS_ENABLED`); production activation stays BLOCKED on D-42**.
Governing documents: ADR-065 (addendum C), SCR-K-04 (`docs/spec-change-requests/SCR-K-04-components-architecture.md`), preparation `docs/ai-intelligence/S-K2c-PREP.md`.

## A. Repository findings and assumptions
- S-K2b ends a clean package at `AWAITING_REVIEW` with a schema-1 manifest whose `components` was reserved and empty. S-K2c inserts a COMPONENTS stage after DETECT (same queue, lease, cancel, retry, dead letter; same `nuzm_worker` role and scope).
- **Deviations from the preparation (recorded, reversible):** (1) no Dart grammar was bundled (D-45 is DECIDED in `docs/07` as bundled tree-sitter, but selecting, licence-checking and pinning the grammar was not done; this report first called D-45 undecided, which was wrong, see K-S2c-sandbox-report): Dart is read by an interim *lexical* analyzer (blanked comments/strings, brace matching) that extracts only what regular Flutter code declares and otherwise says nothing; (2) the proposed **`worker_threads` parser sandbox was not built in this slice** (added afterwards, see K-S2c-sandbox-report): analysis ran in the worker process under per-file hard limits (512 KiB, minified/NUL files skipped, a 400 000-node budget, per-file caps, iterative traversal) plus the lease/cancel machinery. Both are listed as open items.
- Assumptions: component rows are never reusable (`reuse_allowed` stays false; the database refuses otherwise); example/test/docs projects are not analysed unless nothing else exists; generated, test, story, `dist` and `.d.ts` files are not components.
- Environment: this worktree used its own Postgres on :54339 and E2E ports 3300/3301/4300/4310 (another workspace owns :54329); nothing of it was touched.

## B. Plan and changed files
- `packages/domain/src/knowledge/components/**`: `types, dart, resolve, assemble` (+ `components.spec.ts`); `detect/index.ts` exports `parseJsonc`.
- `apps/worker/src/knowledge/{ast/ts-file.ts, components-stage.ts, ingest-service.ts, main.ts}` and specs (`ast/ts-file.spec.ts`, `components-stage.int.spec.ts`); `typescript` is now a worker dependency (pinned 5.9.3), `fast-check` a dev dependency.
- `packages/db/migrations/knowledge/1863__knowledge__components(.down).sql`.
- API: `review.service.ts` (components, relationships, COMPONENTS retry), `admin-knowledge-processing.controller.ts`, tests in `review.int.spec.ts`; `spec/openapi/openapi.yaml` (+2 operations, +4 schemas), `packages/sdk/src/schema.ts`.
- Admin UI: `components/KnowledgeIngestion.tsx` ("Components and architecture" card), `lib/knowledge.ts`, 83 message keys (ar/en), spec.
- E2E: `e2e/tests/15-ai-ingestion.spec.ts` (COMPONENTS on, new assertions); `.env.example`.
- Docs: this report, SCR-K-04, ADR-065 addendum C, plan and preparation status.

## C. Implemented
1. **TypeScript/JavaScript analysis (parse-only AST)**: React function/arrow/`memo`/`forwardRef`/class components; props from declared types, inline types, intersections, `FC<Props>` and destructuring defaults (required/optional); hooks; rendered children (JSX tags, namespace members); imports (default, namespace, renamed, type, style and asset flags, `require`, literal dynamic imports), exports, re-exports/barrels, directives, Next.js conventions; NestJS modules/controllers/providers/DTOs with `imports/declares/exports/injects/guarded_by` read from decorators.
2. **Dart/Flutter (lexical)**: widgets, stateful widgets with their `State`, state holders (Bloc/Cubit/notifiers), Riverpod providers, constructor props with types and requiredness, widget calls in `build`, imports, `GoRoute` → screen, `ThemeData`.
3. **Assembly**: component rows (dependencies, style imports, assets, platforms), relationships with `path:line` evidence (`renders` resolved through tsconfig aliases, barrels, renamed and default imports; `imports`, `declares`, `injects`, `routes_to`, `route_renders`, …), Next page/layout kinds from the folder convention, **architecture** (layers, modules with weighted dependencies, circular imports via strongly connected components, reachability from entry points/routes, library public surface, unused components, skipped files, unresolved imports).
4. **Schema-2 manifest** (a second append-only row): v1 content + components, component index, stats and architecture.
5. **Incremental analysis**: path-independent per-file facts cached by content hash in `analysis_results`; a changed file re-parses one file, an identical version parses none, results are reused across versions of the same resource.
6. **One transaction** writes components, relationships, the manifest, the cache and the summary; cancellation or lease loss writes nothing; an operator retry re-queues COMPONENTS.
7. **API/UI**: component and relationship endpoints (filters, paging, evidence), the manifest endpoint serves schema 2; a searchable/filterable Arabic/English card with component details, relationships, a "not reusable yet" marker and the architecture panel.
8. **Controls preserved**: S-K2a quarantine, two-person approval, activation guard, audit and tenant isolation unchanged; blocked/rejected packages never reach COMPONENTS.

## D. Migrations and rollback
`1863__knowledge__components.sql`: natural unique keys, `worker_knowledge` policies (components also require `reuse_allowed = false`), INSERT grants, the `ANALYZING` guard. Down note in `.down.sql` (dev/staging; production forward-fix). Behaviour rollback: `KNOWLEDGE_COMPONENTS_ENABLED=false` (default).

## E. Test report (actual results, this worktree)
| Suite | Result |
|---|---|
| Domain `components.spec.ts` | **17 passed**: Dart analyzer (positive, comment/string/plain-class negatives, GoRoute links, hostile: minified line, NUL, 200 000-deep braces, unterminated strings, 20 000 classes, `__proto__`; fuzz 400 runs), import resolution (relative, index, `.js`→`.ts`, aliases, `package:`, nothing outside the package), assembly (rows, barrels/aliases/renamed/default imports, cycles, reachability, orphans, determinism under input order, manifest v2, caps, fuzz 200 runs) |
| Worker unit `ast/ts-file.spec.ts` | **14 passed**: every component shape, props, hooks/children, exports/directives, imports; NestJS decorators; negatives (comments, strings, template literals, markdown, JSON-in-.ts, no-JSX functions); hostile (minified, NUL, invalid syntax, 20 000-deep nesting, 300 000-element array, 1 000 components, odd names, no execution); fuzz 300 runs; determinism |
| Domain package total | 747 passed (139 in `knowledge`) |
| Worker integration (real PostgreSQL, role `nuzm_worker`) | **66 passed** (10 new for COMPONENTS: Next.js, NestJS and Flutter end to end; flags; blocked/rejected never reach it; **incrementality** (changed file → 1 parse; identical version → 0); hostile sources inside a package; no execution; cancellation mid-analysis writes nothing; worker write limits: only while `ANALYZING`, never `reuse_allowed`, no update/delete, no tenant rows, natural key) |
| API integration | 1968 passed, 1 failed, 2 skipped; 25 knowledge review tests (2 new: components/relationships listing, filters, paging, 422s, cross-resource 404, COMPONENTS retry matrix). The 1 failure is `domains-search` (registrar probe matrix): pre-existing, from another session's DNet registrar, unrelated |
| Other integration | db 93, platform 32 passed |
| Admin component tests | 329 passed (6 new: list, filters, details with relationships, architecture panel, clean architecture, Arabic, not-analysed/forbidden/failed) |
| Browser E2E `15-ai-ingestion.spec.ts` (Arabic + English, real worker process, detect + components on) | **8/8 passed**, axe WCAG A/AA clean: the Next.js, Flutter and full-stack samples show components (HomeScreen, PropertiesController, Sidebar, …), kinds, details, architecture; DB checks: components written, none reusable, relationships present, manifests `1` and `2` |
| `pnpm lint`, `pnpm typecheck` (52/52), `pnpm build` (28/28), spec lint/drift (481 routes), SDK check, claims guard, classification coverage, `db:test-rls` | PASS |
| `pnpm scan:secrets` | one hit, in another session's file (`registrar-dnet-settings.spec.ts:9`, untouched); mine are clean |
| Unit run under heavy parallel load | one S-K1 upload test timed out at 30 s (`knowledge-upload.spec.ts`); it passes alone (22/22): load-induced, not related to this slice |
Not run: `pnpm verify:full` (browser E2E of other milestones was not re-run; only 15 plus its config).

## F. Security, tenant isolation, billing, residency
- Parse-only and bounded: no program, type checker, module resolution, file-system access or plugin; iterative traversal (no stack overflow), node and per-file caps, minified/NUL/oversized files skipped and counted; every name from source restricted to identifier characters (`__proto__` is only ever a value); regex work is linear on hostile lines. A source file and a config that would leave a marker were only parsed (unit, worker and E2E).
- Isolation: components, relationships and manifests are platform rows written only under the worker scope, only for a version in `ANALYZING`, never reusable; customers read none of this schema. Audit: unchanged API audit events; worker steps in `processing_logs` (`components.begin|done`). Billing/metering: none. Residency: no vendor call.
- Known gaps (open items): no memory-limited parser thread; the worker still does not write the hash-chained audit log.

## G. Human gates and live checks still needed
- **D-42 (BLOCKING production)**: real provider, region, retention, `selfTest()` against the real bucket, vault credentials, attestation `HG-…`; the S3 adapter is verified only against a signature-verifying fake. Production uploads, ingestion, detection and component analysis stay off.
- D-45 grammar selection, licence check and pin (the approach is decided); D-43 (counsel review for commercial themes); D-44 (no malware claim).

## H. Acceptance checklist (S-K2c criteria)
| Criterion | Status |
|---|---|
| Components and imports of the three sample packages found; routes/screens consistent with S-K2b | PASS (worker integration + E2E on the sample packages) |
| No fact without evidence; unresolved imports counted, never guessed; dynamic imports labelled | PASS (assembly tests; `unresolvedImports`, `dynamic` kind) |
| Incremental: unchanged version writes no per-file results; a changed file re-parses only that file | PASS |
| Parse-only proven (marker test); parser limits proven by hostile fixtures | PASS |
| Parser thread isolation with kill-on-timeout | NOT BUILT (deferred, see A) |
| Dart analysis via a bundled grammar (D-45) | NOT BUILT (interim lexical analyzer; coverage limited to regular Flutter declarations) |
| Positive, negative, ambiguous (barrels, renamed/default imports), fuzz and hostile tests; integration through the worker | PASS |
| Arabic/English UI with e2e and screenshots | PASS |
| Flag default off; quarantine, review, audit and tenant isolation unchanged; production blocked on D-42 | PASS / BLOCKED (D-42) |

## I. Handoff
Next slices of the S-K plan (`AUDIT_AND_PLAN.md`): S-K4 (Design DNA and theme intelligence: consumes `hasTheme`, style imports, Tailwind/`ThemeData` evidence), S-K5 (retrieval and recommendation over components and relationships), S-K7 (customer experience). Open: D-42, D-45; a parser thread sandbox; worker writes to the audit chain; the platform dependency deny-list wiring; reuse permissions for components (explicit, publish-gated).
