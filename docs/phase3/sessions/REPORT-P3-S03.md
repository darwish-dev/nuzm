# REPORT-P3-S03: Real agent loop and automatic code repair (PARTIAL: usage limit reached)

Branch `claude/p3-s03-agent-loop-1c2f7a` from `ce16599d`. Nothing pushed or merged. No live provider, no untrusted code executed. All results below are **SIMULATED** unless stated: the model is a scripted stand-in; the build is the in-memory TypeScript compiler (real compiler, origin MOCK, executes nothing) or a static predicate.

## Done
- Error-class diagnostics (20 classes) for tsc, vitest, esbuild/webpack/Next, dart analyze, Kotlin/javac/Gradle (`builder/diagnose.ts`, `autorepair/classes.ts`).
- Strategy corpus per class, deterministic fixers (missing import, wrong relative path, declared-not-exported, unused import, sibling dependency version), integrity and scope guards (no deleting/skipping tests, no `@ts-ignore`, no lowered strictness, no CI/env/lockfile edits), repair engine with one corrected re-ask, per-class metrics (basis points), offline evaluation runner (`autorepair/*`).
- REAL tool output recorded (tsc 5.9.3, vitest, esbuild 0.28.2, dart analyze 3.9.2) into `autorepair/recorded.ts` by `apps/api/scripts/record-repair-logs.ts`. LIVE-VERIFIED applies only to the parsing of these tools' output.
- Lifecycle wiring: repair records/history/outcomes per round, memory "issue" entries (class names only), generation context (produced-file contracts, token budget, relevant files), product generator registry for S04-S06, evidence record with computed claim (never LIVE-VERIFIED), wallet reconciliation (state vs `ai.model_usage` vs `ai.runs` vs reservations), flags `builder_lifecycle.repair_engine` and `builder_lifecycle.real_path` (refusal codes per missing piece, MOCK port refused), `lifecycle_repair`/`lifecycle_evidence` events, i18n block (ar/en).
- Evidence: `docs/phase3/EVIDENCE/repair-offline/2026-11-24-offline-eval.json` (SIMULATED).

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
