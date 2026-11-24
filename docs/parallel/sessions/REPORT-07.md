# REPORT-07 — Session 07 (QA, Security, Compliance)

| Field | Value |
|---|---|
| Session | 07, independent QA / security / compliance |
| Branch | `feature/ai-qa-security` |
| Worktree | `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-qa-security` |
| Baseline commit | `f81872d5` (branch cut from `9d16e7f3`, the parallel-plan commit) |
| Postgres | own cluster, port 54347 (data in `.dev-data/pg`, gitignored; stopped at the end of checkpoint 2: restart with `NUZM_PGPORT=54347 pnpm services:start`, the Redis step failing with "not installed" is harmless) |
| Migrations used | none (reserve 2000-2019 untouched) |
| Contract-change requests | none |
| Current commit | see `git log -1` (checkpoint 2, 2026-11-24) |
| Delivery completion | **~70 % of the READY/MOCKABLE scope** (basis in "Completion") |

## Assigned scope (SESSION-07.md)
Static/security review of the existing AI, gateway, sandbox and deploy code; threat model of the new ports (`ExecutionPort`, `BuildPort`, `DeploymentPort`, `ArtifactRef`); targeted tests in my own paths only (`apps/api/src/qa/qa-*.int.spec.ts`, `e2e/tests/**`, `e2e/tests/fixtures/qa-*.ts`); finish the skipped `08-compute-customer` mock-catalog E2E; re-verify the 10b viewer-forbidden scenario; verify Session 06's deployment coverage; DEFECT reports to owning sessions; `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`; audit other sessions after the Master merges.

## Rules I am working under
No live provider call, no real credential, no customer data, no real execution; 4 CPU / 8 GB shared: targeted tests only, no full integration/E2E, no console rebuild. Heavy runs are requests to the Master (see "Heavy-run requests"). Evidence labels: PASS only for what I ran and saw; offline policy/mocks are never "verified" for the real thing.

## Modified / new files (all in my own paths)
`apps/api/src/qa/` (`qa-exec-gateway`, `qa-ssrf-egress`, `qa-deploy-approval`, `qa-run-approval`, `qa-mobile-signing`, `qa-migration-roundtrip`, `qa-local-dev-sandbox`, `qa-route-inventory`, `qa-authz-matrix` `.int.spec.ts`; `qa-route-scan.ts` helper) · `e2e/tests/08-compute-customer.spec.ts` (third test self-seeds) · `e2e/tests/fixtures/qa-compute-catalog.ts` · `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`, `docs/security/AI-ENGINE-THREAT-MODEL.md` · `docs/parallel/sessions/DEFECT-1..6-*.md`, this report. No implementation file of another session was touched. New migrations: none. Contract-change requests: none.

## Test commands run and ACTUAL results (own Postgres :54347, `NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54347/postgres`)
Packages were built once for the worktree: `npx turbo run build --filter='@nuzm/api^...' --concurrency=2` (turbo cache hit; `packages/*/dist` are gitignored).
| Command (cwd `apps/api`) | Result seen |
|---|---|
| `npx vitest run --config vitest.integration.config.mts src/qa` (all nine QA files, checkpoint 2, baseline code) | Test Files 9 passed; Tests 300 passed, 19 expected fail (319); 95.8 s |
| Checkpoint 3 (merged integration 4af0920c, one file at a time; DB files with the temporary manifest tweak): exec-gateway 79 · ssrf-egress 179 + 8 expected fail · local-dev-sandbox 6 · deploy-approval 7 · run-approval 5 · mobile-signing 6 · migration-roundtrip 9 (now includes 1900, 1920, 1921, 1980: identical schema after down+up) · route-inventory 8 · authz-matrix 10 | **309 passed, 8 expected fail (DEFECT-2 only), 0 failed** |
| per file: `qa-exec-gateway` 74 + 5 expected fail · `qa-ssrf-egress` 177 + 10 · `qa-deploy-approval` 7 + 1 · `qa-run-approval` 5 + 1 · `qa-mobile-signing` 6 · `qa-migration-roundtrip` 9 · `qa-local-dev-sandbox` 4 + 2 · `qa-route-inventory` 8 · `qa-authz-matrix` 10 | passed (earlier individual runs; sums equal the final run) |
| Gate sensitivity check: a temporary controller with a public route, a non-idempotent POST and no access declaration | route-inventory failed 5 tests as intended; the temporary file was deleted |
| `pnpm --filter @nuzm/db exec tsx src/cli.ts migrate | check | classification | ropa-coverage | residency-hooks` (`DATABASE_ADMIN_URL=…54347/nuzm_dev`) | migrate applied all; `db check OK`; `classification coverage OK: 3368 columns in 268 tables`; `ropa coverage OK`; `residency hooks OK` |
| `pnpm spec:lint` · `spec:drift` · `scan:secrets` · `compliance:claims-guard` · `zatca:guard` | all OK (drift: 502 routes declared; secrets: 2,647 files 0 hits). Two of them first FAILED on my own files (a key-shaped literal; the literal controller marker in my route scanner): fixed, re-run OK |
| `npx eslint apps/api/src/qa e2e/tests/fixtures/qa-compute-catalog.ts e2e/tests/08-compute-customer.spec.ts` / `npx prettier --check` | clean (after fixing one restricted-import with a documented disable and one unused import) |
| `cd e2e && npx tsc --noEmit -p tsconfig.json` | no output (clean) |
| `cd apps/api && npx tsc --noEmit` | 1 error in a file I do not own (`modules/cloud/internal/adapter-registry.ts(69,33)`), none in `src/qa`; see finding O-7 |
NOT run (by rule): any full integration/E2E/`pnpm test`/`verify`, console rebuild, browser, Playwright.

## Security findings (summary; full text in `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`)
DEFECT-4 (MEDIUM, S06 deploy: an API key can request and confirm a production publish approval), DEFECT-6 (MEDIUM, S02: an API key with `ai:write` can decide a run approval), DEFECT-2 (LOW-MEDIUM, SSRF fetcher IPv6-embedded IPv4, needs an owner: Master), DEFECT-1 (LOW-MEDIUM, S04: policy throws on prototype names), DEFECT-5 (LOW today/HIGH as rule, S04: control plane follows sandbox symlinks), DEFECT-3 (LOW, S04: egress SIIT/100::/64). Messages sent to sessions 02, 04 and 06 (queued/delivered; no reply expected). Observations O-1..O-8 in the findings file.

## Integration requirements (for the Master)
- Merge my branch with the others, then run `src/qa` again: the route-inventory, authz-matrix and migration round-trip are generic gates that cover the new sessions' routes and migrations (1900-1999) automatically.
- `qa-migration-roundtrip` loads `packages/db/dist` by path (`@nuzm/db` is not a dependency of `@nuzm/api`; `package.json` is Master-owned). Needs `pnpm --filter @nuzm/db build` (done by `pnpm build`). If you prefer, add `@nuzm/db` as a devDependency of `@nuzm/api` and I will switch to a normal import.
- The QA specs import two private modules (`egress`, `local-dev-runtime`) with a documented eslint disable, because they have no public export. If Session 04 moves/renames them the tests need a one-line path update (tell me).
- When an owner fixes a defect, its `it.fails` test turns red by design: remove `.fails` and the `CONFIRMED TODAY` control in the same commit (I will do it on request).

## Heavy-run requests (for the Master)
1. E2E `08-compute-customer` ar + en on the isolated stack (`scripts/e2e-stack.sh run …` or `pnpm test:e2e:isolated`). Test 3 now seeds the synthetic catalog itself (`fixtures/qa-compute-catalog.ts`: dev seed + withdrawing the vendor-slot regions so the first offer is the simulator's). Unverified: the wizard selectors after "keys", the instance reaching "running" within 90 s on the dev stack, `Ubuntu 22.04 LTS` image radio. If it fails send me the trace; it must not be marked PASS until seen.
2. E2E `10b-mobile` ar + en (viewer-forbidden screen): the API half is re-verified here (`qa-mobile-signing`); the screen half is the browser run.
3. After the merge batches: full `pnpm test:integration` (with the QA specs included), `pnpm verify:full:isolated`, `pnpm sdk:check`, `pnpm typecheck` on the integration branch (also answers O-7).
4. Accessibility/RTL: covered by the existing axe-in-every-spec E2E; new UI screens of sessions 02-06 need their own ar/en E2E + screenshots (their rule); I audit them after the merge.

## Defect status updates (checkpoint 3: merged `integration/ai-engine` 4af0920c, re-tested)
| Defect | Result seen |
|---|---|
| DEFECT-1 | fixed and re-tested: `qa-exec-gateway` 79 passed (the 5 `it.fails` are ordinary tests; "never allowed" control made strict) |
| DEFECT-3 | fixed and re-tested: `qa-ssrf-egress` 179 passed, 8 expected fail (all DEFECT-2) |
| DEFECT-4 | API-key part fixed (S06 `8d787bfa`) and re-tested: `qa-deploy-approval` 7 passed (control deleted). Developer self-confirm and rollback approval: open owner decisions (O-1, O-2) |
| DEFECT-5 | fixed and re-tested: `qa-local-dev-sandbox` 6 passed. The named read now refuses (`symlink_in_path`); I changed the test to accept a refusal (the property is "canary never disclosed") — not a weakening: it still fails if the canary is returned |
| DEFECT-6 | fixed and re-tested: `qa-run-approval` 5 passed (control deleted) |
| DEFECT-2 | still open: 8 `it.fails` still fail as expected |
Fixed-but-failing: none.

## Checkpoint 4 (merged integration with the manifest patch, `1fff67a4`): clean, no local tweak
All nine QA files run one at a time on my Postgres: exec-gateway 79, ssrf-egress 179 + 8 expected fail (DEFECT-2), local-dev-sandbox 6, deploy-approval 7, run-approval 5, mobile-signing 6, migration-roundtrip 9, route-inventory 8, authz-matrix 10: **309 passed, 8 expected fail, 0 failed**. Gates on a freshly migrated database: `db check OK`, `classification coverage OK: 3396 columns in 271 tables`, `ropa coverage OK`, `residency hooks OK`; migrate applied 1900/1920/1921/1980. The harness failure below is RESOLVED.

## Checkpoint 5 (merged integration 0570b4a2: DEFECT-2 fix, builder tools)
- DEFECT-2 fixed by Session 04 (`cc318642`): the 8 `it.fails` removed, `qa-ssrf-egress` **187 passed, 0 expected fail**. **All six defects are now fixed and re-tested** (DEFECT-4's developer self-confirm and rollback approval remain owner decisions, O-1/O-2).
- Route inventory: pinned `POST /v1/builder/plan-previews` and `POST /v1/builder/projects/:projectId/change-previews` as the two non-idempotent exceptions (Master decision), after PROVING they write nothing (see next line). 8 passed.
- NEW `qa-builder-tools.int.spec.ts`: **19 passed** (flag off/on, 401/403/404 matrix, viewer cannot rollback/revert/write memory, cross-tenant session and API key both directions, no-side-effect proof of the dry-run routes, idempotent memory write, secrets refused, rollback creates a restore version). First run had one wrong assumption of mine (billing admin does hold `builder:read`): test corrected, observation O-9 recorded.
- Targeted run of every QA file, one at a time: ssrf-egress 187 · exec-gateway 79 · local-dev-sandbox 6 · deploy-approval 7 · run-approval 5 · mobile-signing 6 · migration-roundtrip 9 · route-inventory 8 · authz-matrix 10 (covers the new routes) · builder-tools 19 = **336 passed, 0 failed, 0 expected fail**. `scan:secrets` OK; no heavy run was made.

## Checkpoint 6: `08-compute-customer` mock-catalog test, first real run (own isolated stack, only that spec)
Merged integration `9f2c8a66` first. Stack: `E2E_PG_PORT=54347 scripts/e2e-stack.sh start` (after repairing my worktree install: `pnpm install --frozen-lockfile --offline --force`, because the adapter packages had no workspace links, which made `apps/api` `tsc` fail and `dev:stack` exit 2; this also explains observation O-7: not a repository defect). Load was < 6 and no other Playwright process was running at each run.
Findings, in the order the real run exposed them (all in MY paths; nothing weakened):
1. **Quote step (the Master's report): stale expectation.** The "Provisional estimate" badge is shown only when the quote's `taxEstimate.status === 'provisional'`; the invoicing tax engine now answers `computed`, so the badge is correctly absent. The spec now reads the API's own quote answer (`POST /v1/quotes`) and asserts the cost table, tax row and total are visible, the badge is visible iff `provisional`, and the tax-review banner iff `reviewRequired`. Run: passed.
2. **Fixture gap: the dev seed's simulator ids are not the simulator's catalog.** The instance finished "failed" (`validation: the provider rejected the request`): `packages/adapters/mock-compute` accepts only region `mock-sa-1`, plans `mock.small`/`mock.medium`, images `mock-ubuntu`/`mock-debian`, while `dev-cloud.ts` seeds `dev-sa-1`, `spark-*`, `dev-ubuntu-*` (so its header claim "only the simulator account can actually provision" is not true for the seeded rows: **observation O-10 for the Master**, `packages/db/src/dev-cloud.ts`). `fixtures/qa-compute-catalog.ts` now publishes the simulator's own catalog for the `demo-mock` account (verified SA region with `mock` evidence, two plans, two images) and withdraws every other region; the spec selects the image `Mock Ubuntu`.
3. **Ambiguous locator:** the snapshots step used `.or()` of two elements that are both on the page (strict-mode violation). Now two separate assertions: the level-1 title and the "unsupported" empty state (the simulator account has no snapshot capability).
**Result (actual output):** `scripts/e2e-stack.sh run --project=ar tests/08-compute-customer.spec.ts` → `3 passed (53.4s)`; `--project=en` → `3 passed (41.8s)`. This includes axe in each `audit()` call and the full offer → quote → create → running → stop → metrics/snapshots → delete flow on the simulator. Stack stopped, my stack databases dropped. Screenshots the run wrote were deleted, not committed. SIMULATED evidence only: nothing about any real provider.

## (Resolved) finding on the merged branch (for the Master)
`spec/db/ownership.yaml` on integration 4af0920c has the `PROV` range (1900-1919) but not the benchmarks (1920-1939) or deployment (1980-1999) ranges. Result: every DB-backed test fails at harness start with `Invalid migrations: ai/1920…, ai/1921…, deploy/1980…: ordinal outside ranges allowed`. After adding the ranges (I used an UNCOMMITTED temporary tweak of `extended_by`/`migration_ranges`, reverted; not in my commits), `pnpm db check` still FAILS (`ai.benchmark_records`, `ai.benchmark_runs` not in the ownership manifest / not in `tenant_less`) and `compliance classification` FAILS (20 unclassified columns in those two tables). `ropa-coverage` and `residency-hooks` OK. Patches are in `CONTRACT-S03-2-benchmarks-db-ownership.md` and `CONTRACT-2-deployment-cancel.md`.

## Escalations
None blocking. Material for the owner/Master: DEFECT-4 and DEFECT-6 both say "human approval" is satisfied by API keys; the product decision "may a developer self-confirm a production publish, and does rollback need its own approval" (O-1, O-2) is the owner's.

## Task status
| Task (SESSION-07.md) | Class / state |
|---|---|
| Static security review of existing AI/gateway/sandbox/deploy/access code | VERIFIED (read + tests above); covered: gateway budget/secret/residency path, provider credential custody, approvals, deploy, sandbox policy/runtime, mobile signing, global guard |
| Threat model of the new ports | VERIFIED as a document (`AI-ENGINE-THREAT-MODEL.md`); design-time, ports not yet in code |
| Targeted adversarial tests (own paths) | VERIFIED (300 passed, 19 expected-fail documented defects) |
| Re-verify 10b viewer-forbidden | API level VERIFIED; browser level **MOCKABLE, needs heavy slot** |
| Complete skipped 08-compute mock-catalog E2E | **PASS (simulated)**: ar 3/3, en 3/3 on my isolated stack (checkpoint 6) |
| Verify Session 06 deployment coverage | partially: tenant isolation, roles, approval binding verified; DEFECT-4 found; the deploy leg of `10-app-builder.spec.ts` is S06's; re-audit after merge |
| Audit other sessions' work after merge | **DEPENDENT** (nothing merged yet; plan in findings section 5) |
| Migration up/down/up | VERIFIED for 1800-1870; generic for new ranges |
| API contract / SDK compatibility | partial: `spec:lint`, `spec:drift` PASS; `sdk:check` and SDK client tests not run (heavy slot) |
| Concurrency/cancellation, budget race | existing suites reviewed (1,000-call budget property test, cancel race fix at R6); no new test written; NOT re-run |
| Audit integrity (append-only, hash chain) | static: approvals/logs immutable by trigger; audit-chain dynamic test **not written** (next task) |
| Billing correctness (ledger) | static review of settlement only; ledger posting tests not re-run |

## Completion and readiness
~70 % of the READY/MOCKABLE scope: done = review, threat model, 9 test files, 6 defects, findings, one E2E completion (unrun); missing = browser/SDK/regression runs (heavy slot), audit-chain and ledger dynamic tests, post-merge audits. Readiness: the QA gates are ready to run on the integration branch; **the engine is not production-ready** (unchanged from the status report), and two medium approval-control defects should be fixed before any capability that needs a human approval is enabled.

## Next available tasks (when resumed)
1. Audit-integrity dynamic test (append-only `audit`/ledger tables, tamper attempts as the runtime role, chain verification) — READY.
2. Budget/credits concurrency probe with N parallel reservations on a tiny wallet (independent of the existing property test) — READY.
3. Post-merge audits of sessions 02-06 (new routes, migrations, tools, egress code) — DEPENDENT on the Master's merge.
4. Switch `it.fails` markers to normal tests as owners fix DEFECT-1..6 — DEPENDENT.


## Phase 2 (started 2026-11-24, branch merged with `integration/ai-engine` `39658725`, fast-forward)
Machine note: load average reached 117-403 during this batch (other sessions); only targeted single-file runs on my own Postgres :54347, no browser, no full suite. The two skipped API tests are `flutter-local.int.spec.ts` (2 tests, `MOBILE_FLUTTER_LOCAL=1`): Flutter 3.35.7 and the Android SDK are installed here, but the run needs minutes of CPU and `pub get` network access, so it is **a request for a heavy slot** (see below), not run yet. (The two `it.skipIf(!chrome)` PDF tests in `invoices.int.spec.ts` DO run on this machine: Chrome is installed.)

### Batch 1 (this commit)
| Item (Master's list) | State | Evidence |
|---|---|---|
| 3. Dynamic suites: duplicate-charge, concurrency, reconciliation, audit chain, tamper | **VERIFIED, SIMULATED model**: `qa-ai-integrity.int.spec.ts` = 17 passed + 2 expected-fail (DEFECT-7, DEFECT-8) on the REAL hash-chained audit sink (new optional `realAudit` flag in `ai-harness.ts`, default unchanged) | replayed id = one charge; 12 simultaneous duplicates = one usage row / one ledger tx / one debit; failed call closed, never charged later; double release never double-refunds; 10 reservations on a 100-credit wallet = exactly 3 succeed; per-call usage = ledger = wallet for a concurrent workload with provider failures, key creation and top-ups (calls of a run in sequence); every ledger transaction balances; 25 simultaneous mutations = contiguous audit sequence, time never goes backwards, chain verifies; no canary / key shape / prompt body in any audit row; edited, deleted-middle, deleted-tail and replaced-actor rows are each detected by `verify_chain` and the damage stays in its own chain; the app and worker roles cannot update, delete, truncate, read or rewrite the chain heads, disable triggers or skip them (`session_replication_role`) |
| 5. Credential protection (prompt/file scan) | **VERIFIED + defect**: `qa-secret-scan.int.spec.ts` = 15 passed + 13 expected-fail (DEFECT-9) | catches 13 shapes; misses 13 (env prefixes, JSON, provider keys) |
| 6. The two skipped integration tests | analysed; `flutter-local` needs a heavy slot | see above |
| New defects | DEFECT-7 (HIGH), DEFECT-8, DEFECT-9 filed (`docs/parallel/sessions/DEFECT-7..9-*.md`) | |

Heavy-slot requests: (a) `MOBILE_FLUTTER_LOCAL=1 pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/mobile/flutter-local.int.spec.ts` (Flutter pub get/analyze/test + an unsigned debug APK, 15-25 min, network to pub.dev), only under `mkdir /private/tmp/nuzm-heavy.lock`; (b) E2E specs for builder tools / provider admin / benchmark admin once their owners land them.

### Not yet done in Phase 2 (next batches)
E2E ar+en for builder tools, provider admin, benchmark admin (review + negative cases); agent-loop integration scaffolds (waiting for S05's wiring); authz matrix extension and both-setting tests for O-1/O-2/O-9 (waiting for the switches); prompt injection against tool results and project files; runtime-isolation conformance against the mock; accessibility ar/en; independent review notes on S02/S04/S06 Phase 2 changes (nothing merged yet).
