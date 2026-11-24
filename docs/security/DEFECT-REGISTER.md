# AI Agent Engine: defect register (Session 07, QA / security)

Date: 2026-11-24 · Baseline of the review `f81872d5` · Register covers DEFECT-1 … DEFECT-17 and the concerns O-11 … O-16. Full write-ups: `docs/parallel/sessions/DEFECT-<n>-*.md`; observations O-1 … O-16 and the control list: `docs/security/AI-ENGINE-SECURITY-FINDINGS.md`.

State vocabulary: **FIXED+RETESTED** = the owner's fix is in the tree I ran, and the test that states the secure expectation (first an `it.fails`, flipped to an ordinary test after the fix) passes; I saw the output. **FIXED-unverified** = a fix is reported but I have not run it. **OPEN** = not fixed. Every test was run alone on its own PostgreSQL with the real RLS roles; evidence class SIMULATED (mock model, mock execution port, in-memory publisher). "Seen" means the run output was in my terminal; the final column of section 3 repeats the counts of the last full pass over the merged head.

## 1. Defects
| ID | Severity | Component | Owner (fixer) | Fix commit | Proving test (file::name) | State |
|---|---|---|---|---|---|---|
| DEFECT-1 | Low-Medium | Execution Gateway policy: profile lookup walked the prototype chain (`constructor`, `__proto__` threw instead of refusing) | S04 | `35047320` | `qa-exec-gateway.int.spec.ts::DEFECT-1 (fixed by Session 04): the profile lookup does not walk the prototype chain` | FIXED+RETESTED |
| DEFECT-2 | Low-Medium | Customer URL fetcher (`packages/domain/src/ai/ssrf.ts`): IPv6 spellings of private IPv4 not blocked | S04 | `cc318642` | `qa-ssrf-egress.int.spec.ts::DEFECT-2 (fixed): customer URL fetcher blocks %s (%s)` | FIXED+RETESTED |
| DEFECT-3 | Low | Sandbox egress policy: SIIT `::ffff:0:a.b.c.d` and `100::/64` missed | S04 | `2f5277b4` | `qa-ssrf-egress.int.spec.ts::DEFECT-3 (fixed): sandbox policy blocks %s (%s)` | FIXED+RETESTED |
| DEFECT-4 | Medium | Deploy: an API key could confirm a production publish approval | S06 | `8d787bfa` | `qa-deploy-approval.int.spec.ts::DEFECT-4: an API key (not a human) cannot confirm a publish approval` | FIXED+RETESTED |
| DEFECT-5 | Low today (High if the runtime were shared) | Local dev sandbox control plane followed symlinks left by sandboxed code | S04 | `2f5277b4` | `qa-local-dev-sandbox.int.spec.ts::DEFECT-5 (fixed): reading a NAMED path never follows a symlink out of the sandbox` and `::… writing through a symlinked directory never lands outside the sandbox` | FIXED+RETESTED |
| DEFECT-6 | Medium | AI run approval could be decided by an API key holding only `ai:write` | S02 | `5781c6f0` | `qa-run-approval.int.spec.ts::DEFECT-6: an API key (not a human) cannot decide a run approval` | FIXED+RETESTED |
| DEFECT-7 | **High** | AI gateway: reserve/settle lock-order deadlock; the settle that lost left the customer charged with no usage record, no metering, run cap under-counted | S02 | `f02209cd` | `qa-ai-integrity.int.spec.ts::DEFECT-7 (fixed by Session 02): calls of ONE run in parallel never leave a wallet charge without a usage record …` | FIXED+RETESTED |
| DEFECT-8 | Low-Medium | AI gateway: one call id sent concurrently reached the provider 9–11 times (customer charged once) | S02 | `f02209cd` | `qa-ai-integrity.int.spec.ts::DEFECT-8 (fixed by Session 02): the same call id sent 12 times AT ONCE reaches the provider once …` | FIXED+RETESTED |
| DEFECT-9 | Medium | Outbound secret scanner missed 13 realistic shapes (prefixed `.env` names, JSON config, YAML next line, `sk-ant-`, `sk-proj-`, `AIza`, `sk_live_`) | Master | `ebfde17b` (+ `40295a49` dataset fixture) | `qa-secret-scan.int.spec.ts::DEFECT-9 (fixed): <shape> is detected` (13 cases) and the false-positive controls | FIXED+RETESTED |
| DEFECT-10 | Medium | Execution orchestrator: idempotency key registered after awaits, concurrent submits ran the request several times | S04 | `c9c7c557` | `qa-exec-orchestrator.int.spec.ts::ten concurrent submits with ONE idempotency key create ONE job and ONE execution (DEFECT-10, fixed by Session 04)` | FIXED+RETESTED |
| DEFECT-11 | Low | Deploy policy: concurrent first-ever edit answered 500 instead of 409 | S06 | `03380df9` | `qa-deploy-policy-matrix.int.spec.ts::eight simultaneous FIRST-EVER edits … (DEFECT-11, fixed by Session 06)` | FIXED+RETESTED |
| DEFECT-12 | Low (latent) | Deploy targets: `decideTarget` read inherited object names as a rule and threw | S06 | `03380df9` | `qa-deploy-targets.int.spec.ts::DEFECT-12 (fixed by Session 06): inherited object names read as an UNKNOWN product type (null), never as a rule` | FIXED+RETESTED |
| DEFECT-13 | Low | M10 approvals: the loser of a race against a different decision got 200 with the winner's record | S05 | `8733daad` | `qa-agent-loop-http.int.spec.ts::DEFECT-13 (fixed): a decision that LOST the race to a different decision is told so (409) …` | FIXED+RETESTED |
| DEFECT-14 | Low-Medium | Cancelling a parked lifecycle run left its production-deploy approval pending and decidable | S05 | `8733daad` | `qa-agent-loop-http.int.spec.ts::DEFECT-14 (fixed): cancelling a run closes the deployment approval it is waiting on …` | FIXED+RETESTED |
| DEFECT-15 | Low | Run engine: the organization's concurrent-run ceiling is a count then an insert (two unlocked statements); a burst overshoots it (found in the final re-verification; intermittent under load) | S02 | `abd34766` | `qa-run-concurrency.int.spec.ts::DEFECT-15 (fixed by Session 02): the organization ceiling holds under bursts …` | FIXED+RETESTED |
| DEFECT-16 | Medium | O-9 switch scope (builder side): the switch covers 5 of 23 content routes; project files, file content and search, version diffs, instructions, forms, submissions, CMS, previews, test runs, template workspace stay readable to `billing_admin` under `deny` | S05 (+ S06 for deployment routes) | `b3887609` (+ `14a1ba00`), `da94e933` | `qa-o9-content-access.int.spec.ts::O-9 (Sessions 05 and 06 scope, fixed): under deny, the builder and deployment routes … answer 403 …, and allow restores them` | FIXED+RETESTED |
| DEFECT-17 | Medium | O-9 switch scope (AI side): AI sessions, messages, runs, run events and run artifacts (generated files) stay readable to `billing_admin` under `deny` | S02 | `1ab896b9` | `qa-o9-content-access.int.spec.ts::O-9 (Session 02 scope, fixed): under deny, the AI conversation routes … answer 403 …, and allow restores them` | FIXED+RETESTED |

Count: 17 found, 17 fixed and re-tested, 0 open (O-9 switch now covers all 25 exercised content routes; the default `allow` is unchanged; the approvals free text is redacted under deny for non-financial types since S05 `4f53dd65`, verified for all 10 approval types: see `O9-CONTENT-ACCESS-AUDIT.md`). Full table: `O9-CONTENT-ACCESS-AUDIT.md`. Severity counts: 1 High, 4 Medium (DEFECT-4, 6, 9, 10), 9 Low or Low-Medium. How each was found: static review (1–6), dynamic concurrency and reconciliation tests on the real ledger and audit chain (7, 8, 10, 11, 13, 14), a corpus of realistic secrets (9), a property check of a table lookup (12).

## 2. Concerns and observations raised against Session 04 and 06 work (O-11 … O-16)
| ID | Concern | Disposition | Evidence |
|---|---|---|---|
| O-11 | Orchestrator idempotency: the same key with a different request or run returned the first job (no conflict; keys not scoped to the run) | **FIXED** (`c9c7c557`): `idempotency_key_conflict`, also while the first is in flight, without leaking the first job id | `qa-exec-orchestrator.int.spec.ts::the same key with a DIFFERENT request …`, `::a conflicting duplicate that arrives WHILE the first is still being decided …` |
| O-12 | `ExecDecision` is an unsigned plain object: a hand-made decision ran on the mock | **FIXED** (`c9c7c557`): ports run only decisions the gateway issued (`decision_not_issued_by_gateway`); altered argv/env/network/limits/approval flag and foreign org/run decisions refused | `qa-exec-orchestrator.int.spec.ts::QA orchestrator: a forged or altered decision (O-12 …)` (3 tests) |
| O-13 | `ExecutionOutcome.artifacts` had no file kind, so link/device refusals could never fire | **FIXED** (`c9c7c557`): optional `kind` carried to the artifact policy; symlink, hard link, device, directory refused | `qa-exec-orchestrator.int.spec.ts::a runtime that reports a symlink, hard link, device or directory as an artifact is refused …` |
| O-14 | The canary screen matches the exact string only (base64, hex, reversed or split canaries pass) | **ACCEPTED by design, documented**: safe only while the runtime holds no platform secret; becomes a qualification criterion (section 5 of `PHASE2-SECURITY-QUALIFICATION.md`) | `qa-exec-orchestrator.int.spec.ts::OBSERVATION: the canary screen is an exact match …` (documents the limit) |
| O-15 | Staging target `approvalRef` was presence-only; a real panel could carry the SIMULATED label | **PARTLY FIXED** (`03380df9`): the reference must match `HG-05/06:<id>` and a real panel can never be labelled SIMULATED. **Residual:** nothing in code proves that the referenced owner-signed approval exists | `qa-deploy-targets.int.spec.ts::O-15 (fixed by Session 06) …` and `::CONCERN (remains) …` |
| O-16 | Preview host tag was 32 bits (a guessable unpublished preview) | **FIXED** (`03380df9`): 64-bit tag, HMAC with a vault-held key for real runs | `qa-deploy-targets.int.spec.ts::O-16 (fixed by Session 06) …` |
Observations O-1 (developer self-confirms a production publish), O-2 (rollback reuses the earlier approval) and O-9 (billing admin can read project content) are implemented as policy switches whose defaults equal today's behaviour; both settings are tested for every role (`qa-deploy-policy-matrix.int.spec.ts`, 26 tests; `builder-policy-route.int.spec.ts` by Session 05). Changing a default needs a recorded owner decision. O-3 … O-10 are listed with their dispositions in the findings document.

## 3. Independent re-verification on the final merged tree
Tree: `integration/ai-engine` `c0043cbd` (all worker branches merged: S02 `1ab896b9`, S03 `4cac39c4`, S04, S05 `4f53dd65`, S06 `32897ced`) merged into `feature/ai-qa-security`; dists rebuilt with `turbo run build --filter=@nuzm/api^...`; own PostgreSQL :54347; every file run ALONE with `vitest run --config vitest.integration.config.mts src/qa/<file>.int.spec.ts`; counts are from the run output I saw (2026-11-24, ~18:00). **20 files, 510 tests passed, 0 failed, 0 expected-fail** (no `it.fails` is left in any QA suite).

| Defect(s) | Proving file (file::test group) | Count seen | State |
|---|---|---|---|
| 1 | `qa-exec-gateway.int.spec.ts::DEFECT-1 (fixed by Session 04): the profile lookup does not walk the prototype chain` | 79 passed | FIXED+RETESTED |
| 2, 3 | `qa-ssrf-egress.int.spec.ts::DEFECT-2 (fixed) …` and `::DEFECT-3 (fixed) …` | 187 passed | FIXED+RETESTED |
| 4 | `qa-deploy-approval.int.spec.ts::DEFECT-4: an API key (not a human) cannot confirm a publish approval` | 7 passed | FIXED+RETESTED |
| 5 | `qa-local-dev-sandbox.int.spec.ts::DEFECT-5 (fixed) …` (read and write symlink tests) | 6 passed | FIXED+RETESTED |
| 6 | `qa-run-approval.int.spec.ts::DEFECT-6: an API key (not a human) cannot decide a run approval` | 5 passed | FIXED+RETESTED |
| 7, 8 | `qa-ai-integrity.int.spec.ts::DEFECT-7 (fixed by Session 02) …` and `::DEFECT-8 (fixed by Session 02) …` | 19 passed | FIXED+RETESTED |
| 9 | `qa-secret-scan.int.spec.ts::DEFECT-9 (fixed): <shape> is detected` (13) + false-positive controls | 38 passed | FIXED+RETESTED |
| 10 | `qa-exec-orchestrator.int.spec.ts::ten concurrent submits with ONE idempotency key … (DEFECT-10 …)` | 19 passed | FIXED+RETESTED |
| 11, 12 | `qa-deploy-policy-matrix.int.spec.ts::eight simultaneous FIRST-EVER edits … (DEFECT-11 …)` ; `qa-deploy-targets.int.spec.ts::DEFECT-12 (fixed by Session 06) …` | 27 and 11 passed | FIXED+RETESTED |
| 13, 14 | `qa-agent-loop-http.int.spec.ts::DEFECT-13 (fixed) …` and `::DEFECT-14 (fixed) …` | 17 passed | FIXED+RETESTED |
| 15 | `qa-run-concurrency.int.spec.ts::DEFECT-15 (fixed by Session 02) …` | 11 passed | FIXED+RETESTED |
| 16, 17 | `qa-o9-content-access.int.spec.ts::O-9 (Sessions 05 and 06 scope, fixed) …`, `::O-9 (Session 02 scope, fixed) …`, and the four approvals-redaction tests | 11 passed | FIXED+RETESTED |

**All 17 defects: FIXED+RETESTED. Nothing is open.** The same run covered the other gates:

| Suite | Count seen | Covers |
|---|---|---|
| `qa-route-inventory` | 8 passed | public routes pinned, platform routes need a platform permission, POSTs without `@Idempotent` pinned |
| `qa-authz-matrix` | 11 passed | live matrix over every organization route (401 / 404 non-member / 403 per role, five roles) incl. the Phase 2 routes by name |
| `qa-exec-orchestrator` / `qa-exec-gateway` | 19 / 79 | orchestrator, ports, forged/altered decisions, artifacts; policy |
| `qa-credential-custody` | 5 passed | a console-typed key appears in no response, output or table |
| `qa-builder-tools` | 19 passed | builder tools HTTP: flag, authz, cross-tenant, dry runs write nothing |
| `qa-agent-loop` | 15 passed | cancel/crash at every boundary, limits, budgets, injection (offline) |
| `qa-mobile-signing` | 6 passed | signing viewer-forbidden at API level |
| `qa-migration-roundtrip` | 9 passed | up/down/up of every migration from 1800 with a schema fingerprint |

Not run by me (not claimed): the browser E2E including `qa-negatives.spec.ts` (NOT VERIFIED), `flutter-local` (heavy slot, per the Master), `sdk:check` and the repo-wide suites (Master's regression), and the tests of other sessions.

## 4. Phase 3 continuation (P3-S08, from 2026-11-24)
Defects found in the Phase 3 components keep the same vocabulary and the same proof rule (a test that states the secure expectation: an `it.fails` while open). Findings against a session branch that is not merged yet are marked with the branch and commit that was read; the proving test is skipped until the code is in the tree (never silently green) and is a CI gate from the merge on. Phase 2 DEFECT-1 … DEFECT-17 are unchanged above.

| ID | Severity | Component | Owner (fixer) | Found at | Proving test | State |
|---|---|---|---|---|---|---|
| DEFECT-18 | Low | `packages/runtime-agent` egress proxy: `isPublicAddress` accepts `100::/64`, `::7f00:1`, `fec0::1`, which the Phase 2 classifier refuses (`docs/security/defects/DEFECT-18-p3-egress-proxy-address-policy.md`) | P3-S02 | `claude/p3-s02-runtime-999326` @ `fe83787d` | `qa-p3-egress-proxy.spec.ts::DEFECT-18` (was `it.fails`: 4 passed + 1 expected fail; after the fix 5 passed) | **FIXED+RETESTED against `074ef411` on the S02 branch (not yet merged into the integration line)** |

| DEFECT-19 | Medium-Low | test-environment allocator consumers: the default :54329 database is refused only in a shell that sourced `session-env.sh` (`docs/security/defects/DEFECT-19-testenv-default-database-outside-lease.md`) | Master | `integration/ai-engine` @ `edce169c` | `qa-p3-testenv-allocator.spec.ts::DEFECT-19` (`it.fails`; proving run 13 passed + 1 expected fail) | **OPEN** |

O-17 (tunnel slot held after the client left): fixed by P3-S02 in the same commit with its own test; not re-verified independently by me (needs the package merged and an injected-connector test).

Count (Phase 3, running): 2 found (DEFECT-18, DEFECT-19), 1 fixed and re-tested on the S02 branch, 1 open (DEFECT-19). The final count and the independent re-verification of all registered defects on the final Phase 3 revision are recorded in `docs/phase3/sessions/REPORT-P3-S08.md` (acceptance Q3).
