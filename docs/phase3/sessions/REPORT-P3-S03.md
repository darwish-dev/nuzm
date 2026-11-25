# REPORT-P3-S03: Real agent loop and automatic code repair (batch 1 of 2, mergeable as inert code)

Branch `claude/p3-s03-agent-loop-1c2f7a` from `ce16599d`. Nothing pushed or merged. No live provider, no untrusted code executed. All results below are **SIMULATED** unless stated: the model is a scripted stand-in; the build is the in-memory TypeScript compiler (real compiler, origin MOCK, executes nothing) or a static predicate.

## Done
- Error-class diagnostics (20 classes) for tsc, vitest, esbuild/webpack/Next, dart analyze, Kotlin/javac/Gradle (`builder/diagnose.ts`, `autorepair/classes.ts`).
- Strategy corpus per class, deterministic fixers (missing import, wrong relative path, declared-not-exported, unused import, sibling dependency version), integrity and scope guards (no deleting/skipping tests, no `@ts-ignore`, no lowered strictness, no CI/env/lockfile edits), repair engine with one corrected re-ask, per-class metrics (basis points), offline evaluation runner (`autorepair/*`).
- REAL tool output recorded (tsc 5.9.3, vitest, esbuild 0.28.2, dart analyze 3.9.2) into `autorepair/recorded.ts` by `apps/api/scripts/record-repair-logs.ts`. LIVE-VERIFIED applies only to the parsing of these tools' output.
- Lifecycle wiring: repair records/history/outcomes per round, memory "issue" entries (class names only), generation context (produced-file contracts, token budget, relevant files), product generator registry for S04-S06, evidence record with computed claim (never LIVE-VERIFIED), wallet reconciliation (state vs `ai.model_usage` vs `ai.runs` vs reservations), flags `builder_lifecycle.repair_engine` and `builder_lifecycle.real_path` (refusal codes per missing piece, MOCK port refused), `lifecycle_repair`/`lifecycle_evidence` events, i18n block (ar/en).
- Evidence: `docs/phase3/reports/repair-offline/2026-11-24-offline-eval.json` (SIMULATED).

## Tests actually seen
- domain `vitest run src/ai/agent-tools/builder`: 18 files / 222 passed; `tsc` clean. i18n: 9 passed. API `tsc --noEmit`: exit 0 (before the last edits).
- API lifecycle + changes unit (before new specs): 8 files / 63 passed.
- New API specs: `lifecycle-repair.spec.ts` (7, three error classes repaired in three rounds on the real compiler twin), `lifecycle.flags.spec.ts`, 15 of 16 passed with `generator-registry.spec.ts`.
- `repair-eval.spec.ts`: 24 of 25 passed on the first run; one timeout under load; not re-run after the engine change.

## Not done / NOT VERIFIED
- `generator-registry.spec.ts`: 1 test failing ("the loop uses the registered generator..."): not diagnosed.
- Integration tests on DB (port 54353): reconciliation, real-path refusal through the run engine, 29-checkpoint QA suite, DEFECT-14 suite: NOT RUN after changes.
- Agent UI (repair table, evidence panel): i18n keys added, component and `viewFromEvents` changes NOT written.
- No contract request files written: `apps/api` module wiring and `packages/i18n` block need Master review; no OpenAPI change made.
- L1, L3, L4 against real model/runtime: BLOCKED on P3-S01/S02; model quality NOT VERIFIED.

## Update after the usage-limit reset (light checks only: quiet window, no DB, no tsc over a package)
- `generator-registry.spec.ts` fixed (the test generator wrote invalid `package.json`): 4 passed.
- Agent UI done: `viewFromEvents` reads `lifecycle_repair` and `lifecycle_evidence`; the panel shows a repair table (class names translated, method, result as text) and an evidence block with the claim banner and reconciliation line. Unknown values collapse to safe ones (a hostile event cannot make the UI say LIVE-VERIFIED). `BuilderLifecycle.spec.tsx`: 27 passed (ar and en, i18n key parity included).
- `reconcile.spec.ts`: 5 passed. Lifecycle runner + coverage specs: 36 passed. eslint clean on the lifecycle folder, the recorder script and the two web files.
- (superseded by the next section: these checks have now been run.)
- Contract requests for the Master: register flags `builder_lifecycle.repair_engine` and `builder_lifecycle.real_path` (default off; the real-path value is `{enabled, approvals:[{id,ref,recordedAt}]}`); review the delimited i18n block `Builder agent repair and evidence (P3-S03)`; `ProductGeneratorRegistry` is exported from `appbuilder/index.ts` for S04-S06 (`register(owner, productTypes, generator)`).

## Heavy verification after the quiet window (all through `heavy-slot.sh`; SIMULATED unless stated)
Database: own cluster on port 54363 (54353 was taken by the Phase 2 benchmarks worker through a Master mix-up; the Master confirmed 54363). Every db command carried explicit `DATABASE_ADMIN_URL`/`NUZM_TEST_ADMIN_URL` on 54363; no other database was touched. `pnpm db:migrate` applied all migrations (exit 0).
- `pnpm --filter @nuzm/domain build` exit 0; `tsc --noEmit` over `@nuzm/api` exit 0 (re-run after the last edits: the first re-run caught a null-type error in my new spec, fixed with overloads in `use()`, a type-only change; the next run exited 0 with no errors; that last edit was not followed by another run of the spec itself); over `@nuzm/web` exit 0.
- DB integration, first run: `builder-lifecycle`, `agent-loop`, `run-engine`, `qa-agent-loop` (the 29-checkpoint QA suite) and DEFECT-14 inside `builder-lifecycle`: 79 of 81 passed. Two failures in the Phase 2 `builder-lifecycle-engine.int.spec.ts` were REGRESSIONS caused by this session, now fixed:
  1. I had changed `LifecycleService.env(ctx)` to `env(ctx, port)`; the spec wraps `env` with a one-argument function, the port was dropped and the build was `build_unavailable`. `port` is now an optional parameter that resolves exactly as before. Source fix in `lifecycle.service.ts`.
  2. The spec checked that `lifecycle_finished` is among the last 3 run events; the run now also emits `lifecycle_evidence` and the evidence artifact event after it. The check now reads the last 8 events (one number in `builder-lifecycle-engine.int.spec.ts`, a Phase 2 file: flagged to the Master for review).
  Re-run of `builder-lifecycle-engine.int.spec.ts`: 10 of 10 passed.
- New `builder-lifecycle-real-path.int.spec.ts` (8 tests, 8 passed): real-path flag off by default and without effect; refusal codes `real_path_approval_missing` (none recorded, and one missing named in the audit), `model_generation_off`, `real_runtime_simulated`, `real_runtime_unavailable`, each with no step run, no build requested, one audit event; a refusal leaves the project head and the wallet unchanged; a settled model-backed run stores an `evaluation_report` artifact with claim SIMULATED/MIXED (never LIVE-VERIFIED), all reconciliation checks true, a `builder.lifecycle.reconciled` audit event, one `lifecycle_evidence` event, and the wallet drawdown equals the credits in `ai.model_usage`.
- Lifecycle unit + twin evaluation (`src/modules/appbuilder/internal/lifecycle`): 10 files, 92 tests passed (the offline repair evaluation on the real TypeScript compiler included).
- Not run: the whole API integration suite and the browser E2E (not needed for this change; the owner's/Master's regression covers them). L1/L3/L4 live evidence stays BLOCKED on P3-S01/S02; model quality NOT VERIFIED.
