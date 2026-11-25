# REPORT-P3-S08: Product qualification, security and QA (batch 1)

Branch `claude/p3-s08-qualification-2cddc5` (base `ce16599d`, `integration/ai-engine`), 2026-11-24. Author: P3-S08 (independent verifier; no product feature written; one product-file edit was made and reverted during a mutation check, `git diff` shows none). **Everything in this report is OFFLINE or SIMULATED. No row is LIVE-VERIFIED: no approval is recorded, nothing real was run, nothing paid was called.**

## A. Repository findings and assumptions
- Phase 3 sessions already emit their own evidence shapes (S01 `nuzm.p3-provider-evidence` into `docs/phase3/EVIDENCE/provider/`; S02, S03, S04, S06 have others). The verifier supports S01's envelope natively and requires the canonical envelope elsewhere; see CONTRACT-P3-S08-1.
- A LIVE S01 envelope honestly carries SIMULATED and NOT VERIFIED claims (retry, fallback, model quality). The canonical "no mixed labels" rule is therefore applied to the records the adapter derives (live claims only), not to the native file as a whole. Assumption recorded; the Master should confirm this reading of the mixed-label requirement.
- The owner decision log (`OWNER-APPROVAL-PACK.md` section 6) records nothing; an approval counts only with a non-empty Reference there (the pack's own rule). Self-claimed approvals inside an evidence file do not count.
- The owner's Mac has no working Java (the checklist table says it has: `/usr/bin/java` is the macOS stub), which blocks the two Flutter local tests (A7 FAIL).
- Sessions' routes: none exists yet in any session branch (no controller diff), so route-level negatives wait for the merge.

## B. Plan and changed files (all in my ownership; 7 commits)
`apps/api/src/qa/evidence/**` (schema validator, verifier, native S01 adapter, approvals reader, matrix, CLI, fixtures, 92 tests) · `docs/phase3/EVIDENCE/{README.md,schemas/*.json (13),ACCEPTANCE-MATRIX.{md,json}}` · `apps/api/src/qa/harness/**` (19 scenarios, drivers, runner, CLI, 14 tests) · `apps/api/src/qa/gates/o9-static.ts`, `qa-o9-static-gate.spec.ts`, `qa-route-inventory.spec.ts` (renamed from `.int.spec.ts`), `docs/security/O9-ROUTE-CLASSIFICATION.json` · `docs/phase3/validate/**` (A–E, G, H, run-all, lib, README, `approvals-check.ts`) + `qa/validate-scripts.spec.ts` (27 tests) · `qa/qa-p3-egress-proxy.spec.ts` · `docs/security/{DEFECT-REGISTER.md (section 4), defects/DEFECT-18-*.md, PHASE3-SECURITY-QUALIFICATION.md, P3-FLUTTER-LOCAL-QUIET-WINDOW.md}` · `docs/phase3/sessions/{CONTRACT-P3-S08-1-*.md, REPORT-P3-S08.md}`. No migration (2370-2379 unused).

## C. Implemented
- **Q1 evidence verifier.** Envelope `nuzm.p3-evidence/1` + 12 track schemas. Rejects: schema violations, a wrong `contentHash`, a wrong output-file hash or a path leaving the directory, **any record mixing SIMULATED and LIVE-VERIFIED markers** (top label, components, checks, nested `simulated`/`mode`/`origin`/`verdict` keys, in either direction), a LIVE record without approvals, real identity, passing LIVE-labelled checks, outputs, positive duration, cost within maximum, with a stand-in-looking identity or component, secrets (repository scanner), non-example e-mail addresses, misplaced or duplicate files. The track schemas are enforced for LIVE records; SIMULATED/NOT VERIFIED records carry free-form details. Native S01 envelope verifier (independent rules; approvals cross-checked against the decision log).
- **Acceptance matrix** T1..T6 + cross-cutting gates X (17 rows): columns for LIVE and SIMULATED kept apart, exact blocker per row (unrecorded approval ids + external facts such as B-iOS Xcode, no Linux node, HOST-TRANSPORT unscheduled). Generated into `docs/phase3/EVIDENCE/ACCEPTANCE-MATRIX.md`: all seven targets **BLOCKED, 0 rows PASS**.
- **Harness.** `tsx src/qa/harness/cli.ts`: SIMULATED run of all 19 scenarios (provider twin A/B/C, escape suite on a simulated node, staging rehearsal, the five Phase 2 synthetic projects through the lifecycle runner, and planned-only NOT VERIFIED entries for repair, website, full-stack, APK, iOS, benchmark, security until those entry points land); `--mode live` stops at the first scenario with a missing approval, external blocker, predecessor or live driver and prints it (exit 3); resumable (`state.json`, hash-checked); a record the verifier rejects is never written; `--plan` lists every scenario's blockers. `LIVE_DRIVERS` is empty on purpose.
- **O-9 / route CI gates.** Route inventory became a unit test (it never needed a database). New static O-9 gate: 65 GET routes in the content areas classified (29 `content` with the guard, 36 `metadata` each with a reason), cross-checked against the dynamic audit table; mutation-checked (removing `@ContentRead` from `files/content` failed the gate; reverted).
- **Owner checklist validators** (`docs/phase3/validate/`): read-only PASS/FAIL/MANUAL/SKIP per section A–E, G, H; no secret value printed (tested); mutating-command lint (tested, non-vacuous).
- **Defect register continuation:** DEFECT-18 (Low, P3-S02 egress proxy address policy) with write-up, guarded proving test and a message to P3-S02; O-17 noted, not registered.
- **Flutter quiet-window plan** and **Phase 3 security qualification plan** (docs/security).

## D. Migrations and rollback
None. Rollback: revert the commits; the rename of `qa-route-inventory` is `git mv` back.

## E. Tests run (actual output seen)
| Command | Result |
|---|---|
| `vitest run src/qa` in `apps/api` (all my unit specs together) | **6 files passed, 1 skipped; 153 passed, 5 skipped, 0 failed** (evidence 92: verifier 80 + native S01 12; harness 14; route inventory 8; O-9 static gate 12; validate scripts 27; egress proxy 5 skipped: package not in tree) |
| DEFECT-18 proving run, `P3_S08_EGRESS_PROXY_MODULE=<S02 worktree>/…/egress-proxy.ts vitest run src/qa/qa-p3-egress-proxy.spec.ts` | 4 passed, **1 expected fail** (defect open) |
| `qa-o9-content-access.int.spec.ts` (dynamic audit), `NUZM_TEST_ADMIN_URL` -> own PostgreSQL :54358 | **11 passed** (189 s) |
| harness SIMULATED, all 19 scenarios (`tsx src/qa/harness/cli.ts --reset`, re-run after D00 was added) | 10 ran SIMULATED PASS (P01, P02, P03, R01, D01, S01..S05); 9 recorded NOT VERIFIED because no entry point exists yet (B01, W01, F01, M01, M02, D00, H01, Q01, Q02); 0 failed; the second run resumed. (D00 was added after my first run: the final 19-scenario run is covered by the unit test `harness.spec.ts`.) `--mode live`: STOPPED at P01 naming D2, D5, D6, D4, D3, D9, exit 3 |
| `eslint apps/api/src/qa`; `prettier --check apps/api/src/qa docs/phase3 docs/security` | clean |
| `tsc -p apps/api/tsconfig.json --noEmit` (whole API package incl. my files) | exit 0 |
| validators (read-only, this Mac): E, C, D, G (T3), B, A, H | work as designed; A: 4 PASS / 8 FAIL (no build user, no full Xcode, no simulator runtime, no CocoaPods, flutter doctor red for Xcode and Android toolchain, **no Java**, Android licences not accepted, no emulator image); a first version of A6/A9 gave false PASSes (an empty doctor report; a licence file that exists while doctor says not accepted): both fixed and now FAIL; G(T3): 8 FAIL (none recorded); H: 1 PASS, 6 FAIL (all targets BLOCKED) |
Not run (not claimed): full `pnpm verify`, `pnpm test:integration` beyond the one file, browser E2E, `sdk:check` (Master's heavy runs; the Phase 2 regression holds the lock).

## F. Security, tenant isolation, billing, residency verification
Offline only. New: O-9 static gate (no new content route unreviewed), route inventory in CI, secrets/personal data barred from evidence, approvals never self-declared, DEFECT-18. Tenant isolation, ledger reconciliation, credential leak scan on real runs: BLOCKED (see G).

## G. Human gates and live checks still needed
Every row of `ACCEPTANCE-MATRIX.md` (exact approvals per row), plus: JDK 17 and accepted Android licences before the Flutter quiet window; B-iOS Xcode; HG-10-02 reviewer for the independent escape re-run; BUD/REV/AC-AG-10/SEC-AG for Track H. Owner validation commands: `docs/phase3/validate/run-all.sh`.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| Q1 verifier exists, offline schema + fixtures in `pnpm verify`, rejects mislabelled evidence | **PASS** (offline) | `evidence/verify.spec.ts` (mixed-label tests), runs under `pnpm test` |
| Q2 LIVE-VERIFIED evidence for T1..T6 or the exact blocker | **BLOCKED** (all six: D2..D9, D-21/HG-10-02, HG-05/06, HOST-TRANSPORT, B-iOS, B-Android, B-DB…) | `ACCEPTANCE-MATRIX.md` |
| Q3 independent re-verification of all defects on the final revision | **NOT VERIFIED** (final revision does not exist; Phase 2 count 17/17 FIXED+RETESTED at `c0043cbd`; DEFECT-18 OPEN) | `DEFECT-REGISTER.md` |
| Q4 security negatives per new route/screen; live leak scan; ledger to the cent | **NOT VERIFIED / BLOCKED** (no new routes yet; live checks need approvals) | `PHASE3-SECURITY-QUALIFICATION.md` |
| Q5 full final regression with counts and commit | **NOT VERIFIED** (final revision) | |
| Q6 final report separating offline from live + one owner checklist | **PARTLY** (this report is batch 1; the checklist exists as `OWNER-SETUP-CHECKLIST.md` + validators) | |

## I. Next-batch handoff and open decisions
1. Master: apply CONTRACT-P3-S08-1 (scripts; run `vitest run src/qa` after every merge; native evidence formats; correct the Java row). 2. Sessions S02-S06: emit the canonical envelope or send me the frozen format. 3. When S01's executor is merged and D2..D9 are recorded: wire `LIVE_DRIVERS` for P01..P03 and run live (within the printed cap). 4. When S02 is merged: DEFECT-18 gate goes active; O-17 test; escape-suite independent brief. 5. Quiet window: waits for the Master and for JDK 17.
