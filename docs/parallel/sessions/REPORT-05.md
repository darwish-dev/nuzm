# REPORT-05 — Session 05, AI Builder Tools and Code Generation

- Session ID: 05 · Branch: `feature/ai-builder-tools` · Worktree: `.claude/worktrees/ai-builder-tools`
- Baseline commit: `9d16e7f3` (docs on top of `f81872d5`) · Current commit: see `git log -1` (this file is committed with the last checkpoint; `git log 9d16e7f3..HEAD` lists all session commits)
- Own Postgres: port 54345 (started for the integration tests, stopped at the end; data dir `.dev-data/` is git-ignored) · **Migration ids 1960–1979: none used** (nothing needed a table: project memory is a project file)
- Machine load stayed ≤ 12 after the first minutes (it was 64 at start, before the other sessions' work settled); only targeted tests were run.

## Assigned scope (priority order) and result

| # | Area | Class | State |
|---|---|---|---|
| 1 | patch / diff / change preview / rollback / revert | READY | **VERIFIED offline** (pure domain + service unit tests) and **VERIFIED on the real change pipeline** (6 integration tests on DB + Git, own Postgres). HTTP endpoints parked behind **CONTRACT-1** |
| 2 | requirement analysis, task decomposition, implementation plan, cost estimate | READY | **VERIFIED offline** (bilingual analysis, validated plans). Endpoint parked behind **CONTRACT-2** |
| 3 | review pass + mock-driven build/repair loop | MOCKABLE | **VERIFIED offline** against a scripted stand-in `BuildPort`. Wiring to a real executor is **SECURITY-BLOCKED** (D-21 / HG-10-02 / ADR-067) and never required here |
| 4 | context compression, project memory, token and cost optimization | READY | **VERIFIED offline** (deterministic compressor, file-backed memory, estimates in integer minor units) |
| 5 | generation planners per product type | READY | **VERIFIED offline** for all 14 types, each in Arabic and English (website, landing, e-commerce, web app, mobile, Flutter, ERP, CRM, SaaS, full-stack, API, database schema, authentication, documentation). **What this is:** a verified _plan_ (tasks, files, acceptance criteria, approvals). It is not code generation by a model; the quality of generated code is NOT VERIFIED (needs S-AG4/S-AG5) |
| 6 | UI | READY | **VERIFIED by component tests** (jsdom, both languages, all states, keyboard operable controls). **NOT VERIFIED:** the pages that host the panels and call the API (need CONTRACT-1/2), the per-screen **E2E test and screenshot** that CLAUDE.md §4 asks for (heavy slot, and the endpoints do not exist yet) |

### Also delivered (scope list)
- File and code tools: code search and symbol search (`searchSymbols`), import analysis and import graph with cycles (`analyzeImports`), dependency analysis (undeclared / unused packages), code validation (`validateProject`), multi-file patches and diff generation (`diffFile`, `parseUnifiedDiff`, `applyHunks`, `opsFromUnifiedDiff`), reusable component discovery (`discoverComponents`), deletion policy (deletes ≥ 10 files, migrations, pipeline files need a human confirmation).
- Project management: structure analysis (existing `inspect_project` + `analyzeImports`), architecture planning and technology-stack selection (the plan, with a stated reason; unsupported stacks such as WordPress/Laravel are reported, never silently swapped), snapshots and version history (existing checkpoint tags + version list + new version diff), rollback and revert (new).
- Git operations: already covered by the existing offline `GitStore` (commit on `main` / `work/ai`, tags, log, tree read); no new Git interface was needed. Rollback commits to `main`, repairs to `work/ai`.
- Templates, skills, GitHub-based skills, existing-project ingestion, project instructions: **existing** implementations (S-K6/S-K7, AI Studio) are untouched and still used; the planners do not replace them.
- **Not done (listed, not hidden):** wiring the plan/review/repair into the existing S-AG3 agent loop run kind and into the run engine (needs Master-owned run-kind registration and Session 04's real `MockBuildPort`); a model-backed repair strategy is implemented as an interface (`modelRepairStrategy`) and tested with a scripted completion, but nothing calls a real model (S-AG4, owner gates).

## Hard rules kept
No executable tool is offered to a model (the four read-only tools are unchanged; the new code is pure and a test enforces it: `builder/separation.spec.ts`, plus the existing eslint rule that forbids any Node module in `agent-tools`, which is why SHA-256 is implemented in plain TypeScript and tested equal to `node:crypto`). No S-AG6 gate is touched; builds are only requested through an injected `BuildPort` whose only implementation is `ScriptedBuildPort` (`origin: 'MOCK'`); `ProjectRepairService` refuses to run without a port. Every new capability is behind flag `builder_tools.enabled` (default OFF). No live call, no credential, no customer data, no spend, no deployment.

## Modified / new files (ownership row 05 only, except the two requested exceptions below)
- Domain (pure): `packages/domain/src/ai/agent-tools/builder/**` — `diff.ts`, `changeset.ts`, `sha256.ts`, `code-intel.ts`, `validate.ts`, `diagnose.ts`, `build-port.ts`, `repair.ts`, `components.ts`, `planning/**` (types, features, profiles-core/a/b, analyze, plan), `context/**` (tokens, outline, compress, memory, cost) + specs; one export line in `agent-tools/index.ts` (`export * as builderTools`, so nothing collides with the domain root).
- API: `apps/api/src/modules/appbuilder/internal/changes/` — `change-tools.service.ts` (preview, version diff, rollback, revert), `builder-insight.service.ts` (plan, review, symbols, imports, components, project memory), `repair.service.ts`, `builder-tools-flag.ts` (flag + guard), specs; `change.service.ts` (one line: accepts `source: 'restore'`, which the DB check constraint and `ProjectVersion` already allowed); `appbuilder.module.ts` (3 providers); `change-tools.int.spec.ts`; `pending-contracts/*.controller.ts.pending` (two controllers, parked).
- Web: `apps/web/components/BuilderTools.tsx` + `.spec.tsx`.
- **i18n exception (as FILE-OWNERSHIP allows when `messages.ts` has no merge support):** a delimited block `// >>> Builder tools (S-05)` … `// <<< Builder tools (S-05)` of 165 `bt.*` keys appended at the end of both `ar` and `en` in `packages/i18n/src/messages.ts`. The Master resolves any textual conflict with other sessions' blocks.
- Docs: `docs/parallel/sessions/REPORT-05.md`, `CONTRACT-1-builder-change-tools.md`, `CONTRACT-2-builder-insight-and-memory.md`.

## Contract-change requests (Master to apply; all additive)
- **CONTRACT-1** — `POST …/change-previews`, `GET …/version-diff`, `POST …/rollbacks`, `POST …/reverts` (OpenAPI patch + proposed schemas in the file).
- **CONTRACT-2** — `POST /v1/builder/plan-previews`, `GET …/review`, `…/symbols`, `…/import-analysis`, `…/components`, `GET/POST …/memory`, `DELETE …/memory/{entryId}`.
- Apply together with the parked controllers (rename `*.controller.ts.pending` → `.ts`, register in the module's `controllers`), regenerate the SDK, register flag `builder_tools.enabled` (default off). Until then `pnpm spec:drift` is unaffected (the parked files have no `.ts` extension).
- Shared-contract note (SHARED-CONTRACTS §2): `BuildPort`, `BuildRequest`, `BuildResult`, `ArtifactRef` are implemented as a **stand-in** in `builder/build-port.ts` matching the 0.1 sketch. When Session 04's `MockBuildPort` / `ExecutionPort` land, replace the stand-in by an adapter; `repair.ts` depends only on the `BuildPort` interface.

## Test commands and ACTUAL results (all run in this worktree; nothing repo-wide)
| Command (cwd) | Result seen |
|---|---|
| `npx vitest run src/ai/agent-tools/builder` (packages/domain) | 8 files, **116 passed** (adds execution-build-port 4) (changeset 20, review-repair 21, context 15, planning 16, product-types 33, separation 5, sha256 2) |
| `npx vitest run src/ai` (packages/domain) | 16 files, **273 passed** (includes the existing agent-tools, agent-loop, prompts, tools specs: unchanged and green) |
| `npx tsc -p tsconfig.json --noEmit` (packages/domain) | no output (clean) |
| `npx vitest run src/modules/appbuilder/internal/changes` (apps/api) | 3 files, **17 passed** (change-tools 8, insight 5, repair 4) |
| `NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54345/postgres DATABASE_ADMIN_URL=…/nuzm_dev npx vitest run --config vitest.integration.config.mts src/modules/appbuilder/change-tools.int.spec.ts src/modules/appbuilder/builder-s46.int.spec.ts` (apps/api) | 2 files, **23 passed** (6 new on real DB + Git; the 17 existing change-pipeline tests still pass with the `restore` source line) |
| `npx vitest run components/BuilderTools.spec.tsx` (apps/web) | **29 passed** (ar + en) |
| `npx vitest run` (packages/i18n) | **9 passed** (ar/en key parity, placeholder parity) |
| `npx eslint` and `npx prettier --check` on every changed/new `.ts/.tsx` file | clean (after fixing 9 lint findings: a banned `node:crypto` import, irregular whitespace, control-character regexes, a useless assignment) |
| `tsc --noEmit` of apps/api and apps/web filtered to my files | no errors in my files (the only API errors are the pre-existing "package not built" ones in this fresh worktree) |
| **Not run** | `agent-tools.int.spec.ts`, `agent-loop.int.spec.ts` (workspace packages other than platform/domain/adapter-model are not built here; those suites do not exercise changed code: `agent-tools` only gained one export line), full `pnpm test`, `pnpm verify*`, E2E, console builds, spec lint/drift (no spec changed) |

What the integration tests proved on the real pipeline: preview stores nothing; rollback creates a NEW `restore` version on `main` whose files and Git tree equal the target; a stale base is refused; another organization gets `not_found`; a risky rollback (12 deletions) is refused without `confirmed` and applied with it; revert keeps later work; memory notes go through the pipeline as the user and a secret is refused; a simulated repair commits only on `work/ai` and nothing reaches `main`.

## Security findings (found and fixed during the work)
1. **Reserved path:** the first memory location `.nuzm/memory.json` was refused by the real pipeline (`.nuzm` is a reserved top-level directory). Found by the integration test, fixed (`nuzm.memory.json`), and the domain preview now mirrors the pipeline's path rules (reserved directories, reserved characters, trailing dot/space, 240 chars) so a preview can no longer say "ok" for a path the pipeline refuses (test added).
2. A diagnostic or finding never quotes file or log content (fixed messages; log text is control/bidi-stripped, length-bounded, deduplicated, ≤ 50). Repair prompts frame diagnostics as untrusted data inside the run's fence, and a forged closing marker is neutralised (tested).
3. Project memory is data, not instructions: secrets and canaries refused for every writer; links, shell commands and "ignore previous instructions"-style phrases refused for automated writers; a tampered file is refused on load instead of half-loaded; entries are shown to a model only inside an untrusted block.
4. Repairs that need a human (≥ 10 deletions, edited applied migrations, pipeline files, deploy manifest, very large change) are never auto-applied by the loop (`needs_approval`), and rollbacks/reverts need `confirmed: true`.
5. Planner output states "no compliance claim" for invoicing/tax and "test mode only, owner supplies the provider" for payments; a test asserts no plan text claims compliance, certification or guarantees.

## Integration requirements (for the Master)
1. Apply CONTRACT-1 and CONTRACT-2, rename the two parked controllers, register them, regenerate the SDK; register flag `builder_tools.enabled`.
2. Merge note: `packages/i18n/src/messages.ts` blocks of several sessions may conflict textually at the end of `ar`/`en`; mine is delimited.
3. Session 04's `ExecutionPort`/`MockExecutionPort` (branch `feature/ai-sandbox`): the adapter `ExecutionBuildPort` (`builder/execution-build-port.ts`, structural types, 4 tests with a fake of the same shape) is done. After the merge, construct `new ExecutionBuildPort(createMockExecutionPort(ctx), () => new Date().toISOString())` and pass it to `ProjectRepairService` in the module factory (today it is not registered, deliberately: no port means no run). It has NOT been run against the real `MockExecutionPort` yet (its branch is not merged here): re-run `execution-build-port.spec.ts` with the real mock after the merge.
4. Wiring into the S-AG3 agent loop (a post-apply review/repair stage, plan-driven opening message, project memory in the context) needs a run-kind registration (`apps/api/src/modules/ai/**` is Session 02's, `app.module.ts` is the Master's). Not started.

## Heavy-run requests (for the Master's slot)
- After CONTRACT-1/2 are applied: `pnpm spec:lint`, `pnpm spec:drift`, `pnpm sdk:check`, then the API integration suite for `appbuilder` (including `agent-tools.int.spec.ts` and `agent-loop.int.spec.ts`, not run here) and HTTP-level tests of the new controllers (not written: they need the controllers registered).
- E2E for the builder screens (Arabic + English, screenshots) once the panels are mounted on a page.
- `pnpm lint` over the whole repo (I linted only my files).

## Delivery completion and readiness
- Delivery against SESSION-05 acceptance: **domain, service and component layers complete and tested (about 80% of the scope)**. Not delivered: HTTP endpoints and page integration (blocked on CONTRACT-1/2, Master), agent-loop wiring (cross-session), E2E and screenshots (heavy slot). Nothing is claimed beyond what the table above shows.
- Readiness: ready to merge as inert code (flag off, no route registered, no provider that can run a build). Not production-ready; model quality, real builds and real execution are NOT VERIFIED / BLOCKED by design.

## Next available tasks (if the session continues)
1. HTTP-level tests for the parked controllers once registered. 2. Page integration: mount `ChangePreviewPanel`, `RollbackControls`, `PlanPanel`, `ReviewPanel`, `MemoryPanel` in the project pages (`apps/web/app/[locale]/(console)/builder/projects/[id]/**`) behind the flag, with a small client in `apps/web/lib` (Master-owned directory: needs a request). 3. Agent-loop adapter (after Session 02/04 merge). 4. More product-profile depth (field-level entities per domain) driven by owner feedback.

## Escalations
None blocking. Decisions recorded: (a) pure SHA-256 instead of `node:crypto` because the agent-tools lint rule forbids Node modules; (b) project memory as a root file `nuzm.memory.json` instead of a new table (no migration, versioned and rollback-able, no new write path); (c) controllers parked as `.pending` files to keep `spec:drift` green until the Master applies the OpenAPI patch; (d) 14 planners are deterministic keyword-driven profiles, not model output.
