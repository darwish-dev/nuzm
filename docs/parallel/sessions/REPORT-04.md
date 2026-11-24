# REPORT-04: Session 04, Sandbox and Execution Gateway (S-AG6 offline)

- **Session ID:** 04 · **Branch** `feature/ai-sandbox` · **Worktree** `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-sandbox` · **Baseline** `f81872d5` (docs commit `9d16e7f3` on top) · **Current commit:** see `git log` (last: workspace registry, then this report).
- **Post-merge update (2026-11-24):** `integration/ai-engine` (head 4af0920c) was merged into this branch (non-destructive merge commit); S04-F3..F6 fixed; test results re-run, see "Test commands" (post-merge table).
- **Status:** all READY/MOCKABLE tasks of SESSION-04.md implemented, committed and covered by targeted tests (below). **The gate is closed. Nothing executes anything. No runtime exists.** S-AG6 is still **0 % as a capability**; the offline machinery, the escape-suite extension and the architecture documents are done.
- **Delivery completion (offline scope):** about 95 %. Remaining offline items are in "Remaining" (durable stores and wiring are deliberately deferred: they depend on D-21).

## Scope (SESSION-04.md)
Code: `packages/domain/src/ai/execution-gateway/` (domain, `executionGateway.*` from `@nuzm/domain`), `apps/api/src/modules/execution/` (audit adapter, NOT registered anywhere), `apps/api/src/modules/appbuilder/internal/sandbox/` (execution port, escape suite 1.1.0), `docs/security/sandbox/`, ADR-067 addendum, S-AG6 requirements page.

## Completed tasks (class VERIFIED = implemented with test evidence I ran and saw; offline only)
| # | Task | Where | Tests |
|---|---|---|---|
| 1 | `ExecutionPort`, `MockExecutionPort` (first commit; Session 05 notified) | `port.ts`, `mock-port.ts` | `port.spec.ts` (9) |
| 2 | Limits, timeouts, usage evaluation, cost in integer minor units | `limits.ts` | `limits.spec.ts` |
| 3 | Quota ledger (concurrency, runs/window, CPU-seconds/window, budget cap; default admits nothing) | `quota.ts` | `limits.spec.ts` |
| 4 | Job (12 states) and workspace (6 states) state machines | `lifecycle.ts` | `lifecycle.spec.ts` |
| 5 | Job queue (idempotent, bounded, fair, leases, expiry, cancel, terminate) | `queue.ts` | `queue.spec.ts` (11) |
| 6 | Human approval workflow (digest-bound, single use, expiry, revoke) | `approval.ts` | `approval.spec.ts` |
| 7 | Audit (content-free, allow-listed, secret-scanned) + platform sink adapter | `audit.ts`, `apps/api/.../execution/audit-adapter.ts` | `audit.spec.ts`, `execution-port.spec.ts` |
| 8 | Emergency termination, kill switch | `termination.ts` | `termination.spec.ts` |
| 9 | Resource monitoring and runtime health | `monitor.ts`, `health.ts` | `monitor.spec.ts` |
| 10 | Secret/env protection, output screening, untrusted framing | `env-guard.ts` | `env-guard.spec.ts` |
| 11 | Artifact handling (candidates only) | `artifacts.ts` | `artifacts.spec.ts` |
| 12 | Workspace cleanup planner and registry | `cleanup.ts`, `workspace.ts` | `cleanup.spec.ts`, `workspace.spec.ts` |
| 13 | Container/microVM runtime interface, hardening spec builder and validator, `RefusingRuntime` | `runtime-spec.ts` | `runtime-spec.spec.ts` |
| 14 | Orchestrator (flag, kill switch, gate, policy, quota, approval, queue, mock run, screen, settle, audit) | `orchestrator.ts` | `orchestrator.spec.ts` (31) |
| 15 | `ExecutionPort` over the M10 `SandboxRuntime` (refuses `local-dev`; REAL only if `isolation: verified`) | `appbuilder/internal/sandbox/execution-port.ts` | `execution-port.spec.ts` (11) |
| 16 | Escape suite 1.1.0: 131 EX control-plane attempts BLOCKED, 21 XR isolating attempts NOT_VERIFIED (suite total 273) | `escape-suite-exec.ts`, `escape-suite.ts` | `escape-suite.spec.ts` (4), `confine.spec.ts` |
| 17 | Runtime evaluation + recommended architecture + verification plan + escape catalogue + runbook | `docs/security/sandbox/` | n/a (documents) |
| 18 | ADR-067 offline addendum (still PROPOSED), S-AG6 requirements updated | `docs/adr`, `docs/ai-intelligence` | n/a |

## Remaining tasks
- DEPENDENT: durable stores (execution jobs/approvals/quota tables with RLS and data classes, BullMQ + `platform.operations`), module wiring, controller/routes, UI approval screen, i18n copy, metering emission: all need D-21 and the Master (spec/ownership/i18n/app.module). Design is in `RECOMMENDED-ARCHITECTURE.md`; no migration was created (none of ids 1940–1959 used).
- Heavy-run request below (integration spec of the suite).

## Blocked tasks (class)
- Any real runtime (gVisor/Firecracker/Kata adapter) and any isolating-runtime escape attempt: **SECURITY-BLOCKED** (D-21, HG-10-02, ADR-067). XR-* and base isolating attempts stay NOT_VERIFIED.
- Customer-code execution, opening the gate, flag `ai.agent.exec_tools`: **OWNER-BLOCKED** (D-21, LEGAL-EXEC, ADR-067 acceptance, D-42).
- Node pool, KVM capability probe: **EXTERNAL-BLOCKED** (HG-05-04, owner-provided infrastructure).

## Modified / new files
- Domain `packages/domain/src/ai/execution-gateway/`: `index.ts` (now a re-export surface; the original policy core moved byte-for-byte to `policy.ts` by `git mv`, plus one fix, see findings), new `port.ts mock-port.ts limits.ts quota.ts lifecycle.ts queue.ts approval.ts audit.ts env-guard.ts termination.ts monitor.ts health.ts artifacts.ts cleanup.ts runtime-spec.ts workspace.ts orchestrator.ts` and 13 new specs (+ 4 cases in `exec-policy.spec.ts`).
- API `apps/api/src/modules/execution/{index.ts,audit-adapter.ts}`; `apps/api/src/modules/appbuilder/internal/sandbox/{execution-port.ts,execution-mapping.ts,execution-port.spec.ts,escape-suite-exec.ts,escape-suite.spec.ts}`, edited `escape-suite.ts` (version 1.1.0, categories, ticket-attempt fix, import of the extension).
- Docs: `docs/security/sandbox/*` (6 files), `docs/adr/ADR-067-execution-gateway.md` (addendum), `docs/ai-intelligence/S-AG6-REQUIREMENTS.md`, `docs/parallel/sessions/CONTRACT-04-1-execution-port.md`, `CONTRACT-04-2-approval-kind-i18n-audit.md`, this report.

## New migrations
None (ids 1940–1959 unused).

## Contract-change requests
- `CONTRACT-04-1-execution-port.md`: re-export the port from `packages/domain/src/ai/contracts/`; additive `sha256?` on outcome artifacts and `origin` on the port.
- `CONTRACT-04-2-approval-kind-i18n-audit.md`: `ApprovalKind 'execution'`, `exec.*` i18n keys, `ai.execution.*` audit names; module registration: none now.
- Module registration line for the Master: **none** (nothing registered; no module file).

## Test commands and the ACTUAL results I saw
| Command (from the worktree) | Result |
|---|---|
| `cd packages/domain && npx vitest run src/ai/execution-gateway` | 15 files, all passed (222 tests after the workspace spec) |
| `cd packages/domain && npx vitest run` (whole domain package) | 49 files, 1116 tests passed |
| `cd packages/domain && npx tsc -p tsconfig.json --noEmit` | no errors |
| `cd packages/domain && npx tsc -p tsconfig.build.json` (to refresh `dist` for the API tests; `dist` is gitignored) | no errors |
| `cd apps/api && npx vitest run src/modules/appbuilder/internal/sandbox src/modules/execution` | 3 files, 83 tests passed (egress 68, execution port 11, escape suite 4) |
| `cd apps/api && npx vitest run src/modules/appbuilder src/modules/execution` | 13 files / 160 tests passed; 1 file (`internal/preview/live-preview.spec.ts`) failed to LOAD: `@nuzm/adapter-model` has no built `dist` in this worktree (environment, not a test failure; not touched by me) |
| `npx eslint packages/domain/src/ai/execution-gateway apps/api/src/modules/appbuilder/internal/sandbox apps/api/src/modules/execution` | clean |
| `pnpm scan:secrets` / `pnpm zatca:guard` / `pnpm compliance:claims-guard` | OK (2674 files 0 hits) / OK / OK (1194 files) |
| API `tsc` of the whole project | NOT run to completion: it needs the built `dist` of platform/telemetry packages that this worktree does not have; filtering the output for my files showed no errors (`modules/execution`, `sandbox/runtime`, `mock-runtime`) before the later files were added, and ESLint with type-aware rules was clean afterwards. Treat the API typecheck as NOT FULLY VERIFIED until the Master's heavy run. |
Not run (by rule): any integration suite, E2E, `pnpm verify`, console builds.

### Post-merge re-run (after merging integration/ai-engine 4af0920c; load average 24, i.e. not idle, results as seen)
| Command | Result |
|---|---|
| `cd packages/domain && npx tsc -p tsconfig.json --noEmit` | no errors |
| `cd packages/domain && npx vitest run src/ai` (before the final re-run) | 35 files, 704 tests passed |
| `cd packages/domain && npx vitest run src/ai/execution-gateway src/ai/ssrf.spec.ts` | 16 files, 256 tests passed |
| `cd apps/api && npx vitest run src/modules/appbuilder/internal/sandbox src/modules/execution` | 4 files, 95 tests passed |
| `npx eslint` on `ssrf.ts`, `ssrf.spec.ts`, `execution-gateway`, `appbuilder/internal/sandbox`, `modules/execution` | clean |
| `pnpm scan:secrets` | OK, 2825 files, 0 hits |
Not re-run: integration specs, the whole domain package after the merge, API typecheck (heavy-run requests above still stand).

## Security findings (all offline, all fixed, each with a test)
1. **S04-F1 (low, availability):** `decideExec` threw a TypeError for a model-chosen profile named `__proto__`, `constructor`, `toString`, `hasOwnProperty` or `valueOf` (the lookup returned an inherited object, then `profile.params.script` was dereferenced). Found by the new escape attempts EX-PROFILE-2..5. Fixed in `policy.ts` (own properties only; reads as `unknown_profile`); `exec-policy.spec.ts` covers it. No bypass: such a profile was never enabled.
2. **S04-F2 (test robustness):** base escape attempts WS-2/3/4/6 reported ESCAPED instead of NOT_VERIFIED when the suite runs without a database (`!!c.tickets && …`). Now they throw "needs the database" like WS-1/5. With a database behaviour is unchanged.
3. **S04-F3 (low, from Session 07 DEFECT-1):** same as F1; already fixed here before the report arrived.
4. **S04-F4 (low, from Session 07 DEFECT-3):** `egress.ts` `blockedV6` missed the SIIT form `::ffff:0:a.b.c.d` and the discard-only prefix `100::/64`. Fixed; cases added to `egress.spec.ts` (a SIIT form of a public IPv4 stays public, like the other embedded forms).
5. **S04-F5 (low today, high as a design rule; Session 07 DEFECT-5):** `LocalDevSandboxRuntime.readFiles(named)`, `writeFiles` and `exec` cwd followed symlinks planted by sandboxed code (confused deputy). New `confine.ts` (`lstat` on every existing component, `realpath` of the deepest ancestor under the real root, regular single-link file for reads, no hard-link write target); used by the runtime; escape attempts EX-SYM-1..4 (SYM-READ, SYM-WRITE, SYM-HARDLINK, SYM-CWD) added; `confine.spec.ts` covers it incl. the runtime. Residual: a check-then-open race while sandboxed code runs concurrently (documented in `confine.ts`; the dev runner is dev-only and a real runtime reads through its own agent, not the host path).
6. **S04-F6 (low-medium, Session 07 DEFECT-2; authorized by the Master, file extended to this session for this fix):** `packages/domain/src/ai/ssrf.ts` `isBlockedAddress` did not treat IPv6 spellings of a private IPv4 as the embedded address (IPv4-compatible `::/96`, 6to4 `2002::/16`, SIIT, Teredo, `100::/64`; leading-zero spellings of the NAT64/documentation/site-local prefixes). Now the literal is expanded to 8 groups and judged by the embedded address; an unreadable literal fails closed. `ssrf.spec.ts` (new, 26 blocked + 7 public + fail-closed cases, no secret-looking fixtures). The sandbox `egress.ts` and this function now agree on the corpus in that spec.
7. Design observations (not defects): `AiFlags.execTools` is hard-wired false (good, untouched); the base suite's isolating attempts would pass on a *mock that lies about `isolation: verified`* (the mock answers 127 to unknown commands), so a mock must never be allowed to claim `verified`; the orchestrator and `executionGate` refuse a verified-looking runtime while the gate is closed (EX-GATE-8). Documented in `ESCAPE-SUITE-1.1.md`.

## Ordinary engineering decisions recorded (no owner input needed)
1. Policy core moved to `policy.ts` and `index.ts` became the re-export surface (API unchanged, `executionGateway.*`).
2. A quota reservation is taken at claim time, not at enqueue, so queued jobs hold no concurrency slot; an early non-reserving `check` refuses at submit.
3. A canary in output engages the organization's kill switch (fail closed).
4. An approval is consumed at claim time; one that expired while queued stops the run.
5. The `ExecutionPort` implementation over the sandbox runtime lives in `appbuilder/internal/sandbox/` because the module-boundary lint forbids importing another module's internals; `apps/api/src/modules/execution` keeps only the audit adapter.
6. Quota settles on wall-time seconds as a conservative CPU bound, because the 0.1 outcome shape carries no CPU measurement (a real adapter should report it: noted for CONTRACT-04-1 follow-up).
7. No migration yet: the durable store shape depends on the runtime decision and needs `spec/db/ownership.yaml` (Master).

## i18n keys needed later (Session 04 supplies the list only; `messages.ts` is Master-owned)
`exec.approval.title`, `exec.approval.network_warning`, `exec.approval.install_warning`, `exec.status.<state>` for: requested, refused, awaiting_approval, rejected, queued, running, succeeded, failed, timed_out, terminated, cancelled, expired; `exec.refusal.<reason>` for the identifier reasons in `policy.ts` (`unknown_profile`, `profile_not_enabled`, `another_tenant_or_run`, `script_name_invalid`, `script_denied`, `script_not_in_project`, `dir_outside_project`, `model_supplied_*`, `unexpected_param_*`, `params_not_an_object`), `quota.ts` (`concurrency_ceiling`, `runs_per_window_ceiling`, `cpu_seconds_ceiling`, `budget_cap`, `run_already_admitted`) and `orchestrator.ts` (`feature_flag_off`, `ai_kill_switch`, `execution_kill_switch`, `gate_closed`, `idempotency_key_invalid`, queue ceilings). Arabic copy needs owner review.

## Integration requirements (for the Master)
- Merge order: this branch is mostly additive; the only moved file is `execution-gateway/index.ts` → `policy.ts` (rename detected by git). Session 05 imports `executionGateway.createMockExecutionPort` / `MockExecutionPort` from `@nuzm/domain`.
- After merging, `packages/domain` must be rebuilt (`dist`) before API specs that import `@nuzm/domain` run.
- Apply CONTRACT-04-1/2 when scheduled; no `spec/**`, SDK, ownership manifest or `app.module.ts` change is needed now.

## Readiness assessment
Offline machinery: ready for review and for Session 05 to consume the mock. As a capability: not ready and not meant to be (gate closed; D-21, HG-10-02, ADR-067, LEGAL-EXEC, D-42 open). A mock cannot prove isolation.

## Next available tasks
Durable stores and wiring once D-21 is decided (DEPENDENT); an `ExecutionRuntime` adapter for the chosen technology (SECURITY-BLOCKED until then); exercising the runbook on a real runner; extending the suite when ADR-067 adds profiles.

## Heavy-run requests (for the Master's heavy slot)
1. `NUZM_TEST_ADMIN_URL=… pnpm --filter @nuzm/api exec vitest run -c vitest.integration.config.mts src/modules/appbuilder/sandbox.int.spec.ts` on the integration branch after merge: the whole 277-attempt suite with database-backed ticket attempts. Expected: 0 ESCAPED, every control-plane attempt BLOCKED, every isolating attempt NOT_VERIFIED, `isolationEvidence` false (the unit spec shows these properties without a database; the int spec also asserts `notVerified > 40`, which now holds with the 21 XR attempts added).
2. `pnpm --filter @nuzm/api typecheck` (needs the built package `dist`s) to close the API typecheck gap noted above.

## Escalations
None blocking. Owner decisions this work feeds (already in OWNER-DECISIONS): D-21, ADR-067, LEGAL-EXEC, D-42, plus, newly named: the node-pool budget (`N_peak`, price, currency), the execution approval permission model, the kill-switch time target for the review.

---

# Phase 2: real isolated runtime preparation (2026-11-24)

- **Branch head at this report:** see `git log -1` (Phase 2 commits: `3d5eb1a3` attested real-runtime scaffold, `c100db75` conformance/fixtures/qualification runner, `320cb88d` fix, `264d339f` orphan reaping, then docs). Baseline: `integration/ai-engine` @ `39658725` merged cleanly into `feature/ai-sandbox` (fast-forward, no conflicts).
- **Status:** the offline half of "a real runtime behind `ExecutionPort`" is done and tested against stand-ins. **Nothing real exists: no node, no runtime, no attestation signed by a human, no execution. `executionGate` is closed; `ai.agent.exec_tools` is default off; D-21, HG-10-02, ADR-067 (PROPOSED), D-42, LEGAL-EXEC untouched.** Evidence label for everything below: `SIMULATED` (offline-verified); isolation: `NOT VERIFIED`.
- **Honesty note:** commit `c100db75` was made with the real-runtime specs failing (the simulated kit still carried 21 isolating attempts after I raised the required count to 65; my earlier edit did not match because prettier had reformatted that line). Fixed in `320cb88d`; the results below are from after the fix.

## Infrastructure evaluation (read-only facts, full text in `docs/parallel/RUNTIME-QUALIFICATION.md` §1)
macOS 13.7.8, Intel x86_64 (i5-7267U, 4 logical CPUs), 8 GiB, `kern.hv_support=1`; Docker, Podman, QEMU, Firecracker, runsc, Kata, Lima, Colima, Multipass, kubectl are all absent. gVisor/Firecracker/Kata are Linux-only; this Mac cannot be a qualification node. Next real step = a dedicated Linux non-production node (owner/provider action, HG-05-04, D-21). No installs, no downloads, no untrusted code on this host.

## Delivered (all offline)
| Item | Files | Result seen |
|---|---|---|
| Isolation attestation: schema, canonical signing bytes (ed25519), fail-closed verifier (about 40 reason codes: missing/malformed/node+endpoint mismatch/environment/runtime class not isolating/unpinned image/cgroups/dedicated/swap/sockets/metadata/egress/suite version/escapes/not all blocked/review/D-21 ref/validity/revocation/signature), draft builder for the reviewer (never verifies), simulated kit (throw-away key; label fixed to SIMULATED) | `packages/domain/src/ai/execution-gateway/real-runtime/attestation*.ts`, `simulated-attestation.ts` | 35 tests pass |
| `RealRuntimeService.start` (fail-closed: every node needs a verifying attestation bound to node/endpoint/environment/mode, identity answers must match, live mode needs LIVE-VERIFIED + the node claiming `verified` + healthy; one bad node refuses the whole start), `portFor(ctx, inputs)` per run, origin `MOCK` in simulated mode and `REAL` only in live mode | `real-runtime/real-runtime.ts` | 28 tests pass |
| Per-run flow: spec from `buildRuntimeSpec` re-validated, image must be attested, seed screening (secrets, canaries), dependency policy for installs, wall/limit (monitor) /abort/terminate kill paths, unresponsive node → quarantine, cleanup failure → quarantine, attestation re-verified before every run (expiry, revocation drop the node), least-loaded node choice, bounded output, artifact extraction with hash verification into an `ArtifactSink`, content-free events, per-run accounting (`onUsage`), `terminationPorts()` for `terminate()`, `reapOrphans()` (restart recovery) | same | covered by the 28 tests |
| Node contract `WorkspaceRuntime` (+ `listWorkspaces`) and `SimulatedWorkspaceRuntime` (starts nothing, validates specs independently) | `real-runtime/workspace-runtime.ts` | used by all of the above |
| Dependency-install policy | `real-runtime/dependency-policy.ts` | 17 tests; found and fixed a classification-order slip (`./x` reported as git) |
| Conformance suite (6 contract cases + 22 fixtures = 28) with targets: `MockExecutionPort` (policy/runtime layers only; other layers SKIPPED with a reason, never PASS) and the real-runtime port over the simulated node (all 28 pass); a mutation check (a port that forges approvals fails CP-3; a leaking target and a lying origin fail) | `real-runtime/conformance.ts`, `conformance.spec.ts` | 8 tests pass |
| 22 disposable synthetic project fixtures (typecheck/unit/build/artifact-link tricks/CPU/memory/pids/disk/output/env/network probes/install/policy/workspace/dependency cases), each with the expected outcome for a real node and a stand-in behaviour; safety checks (no hostnames, no secrets, no traversal, bounded size, seed screening refuses exactly the workspace-layer ones) | `real-runtime/fixtures.ts` | included above |
| Escape-suite qualification runner + CLI + node adapter: modes `simulated` (works), `qualify` and `requalify` (refuse without approval reference + `NUZM_QUALIFICATION_APPROVED` + staging declaration + node client; none exists), per-case PASS/FAIL/NOT_VERIFIED, report sha256, draft attestation, `renderReport` says SIMULATED | `apps/api/src/modules/appbuilder/internal/sandbox/escape-runner.ts`, `escape-runner.cli.ts`, `endpoint-runtime.ts`, `escape-runner.spec.ts` | 9 tests pass |
| Documents | `docs/parallel/RUNTIME-QUALIFICATION.md`, `docs/parallel/sessions/PHASE2-04-approval-inputs.md`, `docs/security/sandbox/DURABLE-STORES-DESIGN.md`, README index | n/a |
| Contract request | `CONTRACT-04-3-qualification-runner-script.md` (package script, no module registration, D-42 naming conflict, ADR-068 reminder) | pending the Master |

## Test commands and the ACTUAL results I saw (load average was 270+ during the final runs; targeted only)
| Command (from the package directory) | Result |
|---|---|
| `packages/domain`: `npx tsc --noEmit -p tsconfig.json` and `npx tsc -p tsconfig.build.json` | no errors |
| `packages/domain`: `npx vitest run src/ai/execution-gateway src/ai/ssrf.spec.ts` | 21 files, **344 tests passed** |
| `packages/domain`: `npx vitest run src/ai` | 41 files, **796 tests passed** |
| `apps/api`: `npx vitest run src/modules/appbuilder/internal/sandbox src/modules/execution` | 5 files, **104 tests passed** |
| `npx eslint` on `packages/domain/src/ai/execution-gateway`, the sandbox dir, `apps/api/src/modules/execution` | clean |
| `pnpm scan:secrets` | OK, 2859 files, 0 hits |
| `npx tsx apps/api/src/modules/appbuilder/internal/sandbox/escape-runner.cli.ts --endpoint simulated:node-1` | suite 1.1.0, mode=simulated, evidence=SIMULATED: **277 cases, 206 PASS, 0 FAIL, 71 NOT_VERIFIED** (65 isolating + 6 database-backed ticket cases); exit 0 |
Not run: integration specs, repo-wide suites, the API typecheck (dists of other packages are missing in this worktree: pre-existing), anything live.

## Findings (Phase 2)
- **S04-F7 (conflict, not a defect in code):** "D-42" means the platform object store in `docs/07-open-decisions-and-blockers.md` (decided interim 2026-11-20) but "production rollout" in `docs/parallel/OWNER-DECISIONS.md` and in `ExecGateState.d42Decided`. Per CLAUDE.md §2 the higher source wins; nothing renamed; a distinct id is requested in CONTRACT-04-3 and the approval inputs.
- **S04-F8:** the `EXEC_PROFILES[...]` own-property bug class (S04-F1) reappeared in my new conformance code on the `constructor` fixture and was caught by the suite itself; fixed with `hasOwnProperty`.
- **Design decisions (recorded):** (1) the attestation proves a *review*, never isolation; the verifier requires a human reviewer, an HG-10-02 reference, a D-21 reference, a trusted signer, and rejects SIMULATED evidence in live mode. (2) The qualification runner produces a DRAFT that cannot verify; the reviewer completes and signs it outside the repository. (3) The minimum isolating-attempt count is tied to the suite (65) by a spec so suite growth forces an update. (4) A live qualification adapter reports the node as `verified` to the suite only inside a live qualification (the suite is the verification), never from the node's own claim. (5) Migration ids 2140–2159: **none used**; durable stores are design only.

## Remaining / blocked (class)
| Item | Class |
|---|---|
| Linux node, provider, budget, KVM probe | EXTERNAL-BLOCKED (HG-05-04) / OWNER-BLOCKED (D-21) |
| Node agent (implements `WorkspaceRuntime`) and HTTPS/mTLS node client | DEPENDENT on D-21 (contract + conformance suite ready) |
| T1-T12 qualification run, signed attestation | SECURITY-BLOCKED (HG-10-02) |
| Durable stores (design only), module wiring, trusted-key configuration | DEPENDENT on D-21; needs CONTRACT |
| Customer-facing execution, production | OWNER-BLOCKED (LEGAL-EXEC, ADR acceptance, production-rollout decision) |
| `package.json` script `sandbox:escape-suite` | needs the Master (CONTRACT-04-3) |

## Heavy-run requests (Phase 2)
1. Same as before: `sandbox.int.spec.ts` on the integration branch (database-backed ticket attempts of the 277-case suite); expected 0 ESCAPED.
2. After merge, rebuild `packages/domain` `dist` (API specs import it) and run `pnpm --filter @nuzm/api typecheck` once the other packages' dists exist.

## Next available tasks (offline)
Idle until D-21 except: a wire-protocol conformance test for the node agent contract (schema validation of the JSON messages) once the owner confirms the transport proposal; extending fixtures when profiles change.

## QA findings from S07 (DEFECT-10, O-11..O-14) — fixed after the Phase 2 batch
| Finding | Fix | Test (seen passing) |
|---|---|---|
| **DEFECT-10** (MEDIUM): concurrent submits with one idempotency key created several jobs (key registered only after an await) | `ExecutionOrchestrator.submit` now claims the key synchronously in an `inflight` map before any await; a concurrent duplicate awaits the first and returns the same job (`duplicate: true`); a refused first submit leaves no key | `orchestrator.spec.ts`: 10 concurrent submits → one job, one port run; 5 concurrent approval-gated duplicates → one approval |
| **O-11**: same key + different request/run returned the first job | `fingerprint` (sha256 of run id + canonical request) stored on the job; mismatch → `refused: idempotency_key_conflict` (stored and in-flight) | `orchestrator.spec.ts` |
| **O-12**: `ExecDecision` is an unsigned plain object, a hand-made `{allowed:true, argv:['sh','-c',…]}` was accepted by `MockExecutionPort.run` | new `IssuedDecisions` registry (content digest + `requiresApproval`, bound to org and run): `MockExecutionPort`, `RealRuntimePort` and `SandboxRuntimeExecutionPort` run only decisions their own `request` issued; hand-made, edited or other-port decisions → `decision_not_issued_by_gateway` | `port.spec.ts`, `real-runtime.spec.ts`, `execution-port.spec.ts` |
| **O-13**: `ExecutionOutcome.artifacts` had no `kind`; the orchestrator hard-coded `file` | optional `kind` (additive to contract 0.1) carried to `collectArtifacts`; links/devices/dirs are refused | `port.spec.ts`, `orchestrator.spec.ts` |
| **O-14**: canary screen is exact-match only | not changed; limitation recorded: acceptable while no runtime holds a platform secret (the attestation requires none on the node); encoded/split secrets in output are not detected by canaries | documented here |
Results seen: `packages/domain` `src/ai` 41 files / **803 tests passed**; `execution-gateway` 20 files / 317 passed; `apps/api` sandbox + execution 5 files / 104 passed; ESLint clean; secret scan 0 hits. S07's `it.fails` for DEFECT-10 and CONCERN-1 can be flipped; S07 should re-test (their file `apps/api/src/qa/qa-exec-orchestrator.int.spec.ts` is on their branch, not run by me). `dist` of `packages/domain` was rebuilt for the API specs.

## Batch after the Master's acceptance (CONTRACT-04-3, D-AG-ROLLOUT) — 2026-11-24
- Merged `integration/ai-engine` (b9cc2a56) first. **Renamed** `ExecGateState.d42Decided` → `rolloutDecided` in `policy.ts`; refusal text is now `D-AG-ROLLOUT (production rollout) is not decided`; still fail-closed (`production && !rolloutDecided`). Updated `exec-policy.spec.ts`, `escape-suite-exec.ts` (EX-GATE cases) and the labels in ADR-067, S-AG6-REQUIREMENTS, `docs/security/sandbox/{README,RECOMMENDED-ARCHITECTURE,ESCAPE-SUITE-1.1}.md`, RUNTIME-QUALIFICATION and the approval inputs. The historical S04-F7 entry above keeps the old id on purpose.
- **Outside my ownership, needs the same rename:** `apps/api/src/qa/qa-exec-gateway.int.spec.ts` (S07, lines ~219 and ~231 use `d42Decided`; after the rename their `production: true` case reads `rolloutDecided` as undefined and will fail until they update it) and `docs/security/AI-ENGINE-THREAT-MODEL.md` (E5 row says "production needs D-42").
- New in `PHASE2-04-approval-inputs.md` §6: the exact node checklist (12 items), a sourced rough cost range (bare-metal dedicated about EUR 45-100/month; AWS c5.metal about USD 4.08/h from third-party aggregators; in-Kingdom options listed but not priced), and the recommendation: rent one bare-metal dedicated server, qualify gVisor (systrap) first, then Firecracker on the same box after a rebuild; decide D-21 after both results. Prices are indicative, not quotes, not live-verified.
- Results seen after the merge: `packages/domain` `src/ai` 41 files, 801 passed, **2 failed**, both in `src/ai/benchmarks/dataset.spec.ts` (S03's `sec-03-hardcoded-token-ar` fixture is flagged by S07's tightened scanner, DEFECT-9, commit ebfde17b: not my change); `apps/api` sandbox + execution 104 passed; ESLint clean; `pnpm scan:secrets` **fails on `apps/api/src/modules/deploy/internal/targets.spec.ts:255,318`** (S06's file, same cause), none in my files. Both need their owners (S03, S06) to assemble the credential-looking strings at run time.

## CONTRACT-S05-P2-3 request 2 (explicit sandbox purpose) — done, default behaviour unchanged
- `SandboxService.create(orgId, actor, project, body, purpose = 'user_sandbox')` takes a `SandboxPurpose` (`release_build | user_sandbox | ai_run_build`), chosen **in code by the caller, never from the request body** (a `purpose` member in `body` is ignored; an unknown value is `validation_failed`). New constructor parameter (last, optional): `purposeBudgets: Partial<Record<SandboxPurpose, { port: OrgBudgetPort; gate: 'ai_wallet' | 'build_allowance' }>>`. A purpose with no entry uses the service's own `orgBudget` (the AI wallet): so with nothing configured every purpose behaves exactly as before, and the old 4-argument calls are unchanged. The audit event `sandbox.sandbox.created` now records the `purpose`.
- The `budget_required` message names the gate that refused: wallet → "the organization has no AI credit left for a sandbox" (unchanged text); build allowance → "the build allowance of the plan is used up; new builds are blocked". A budget port may declare `readonly gate = 'build_allowance'` so S05's existing second-instance wiring (`ReleaseBuildBudget` as the only budget of `RELEASE_BUILD_SANDBOX`) reports the right message without any change on my side.
- Files (mine): `appbuilder/internal/sandbox/budget-gate.ts` (pure selection and message), `sandbox.service.ts`, `budget-gate.spec.ts` (6 tests: default unchanged for all purposes, 4-argument call unchanged, per-purpose allowance replaces the wallet only for its purpose and the wallet is not asked, existing wiring, body cannot set the purpose, prototype-name purpose refused, inherited members ignored). Seen: sandbox + execution specs 6 files / **110 tests passed**, ESLint clean, `pnpm scan:secrets` OK (0 hits). Not run: the database-backed `sandbox.int.spec.ts`/`m09-real.int.spec.ts` (heavy-run request: they exercise `create` with the wallet and must stay green, nothing in the create path changed except the budget lookup).
- **For Session 05 (their files; I did not touch them):** (1) in `appbuilder.module.ts` the second instance can be replaced by one `SandboxService` built with `purposeBudgets: { release_build: { port: new ReleaseBuildBudget(g), gate: 'build_allowance' } }` (and later `ai_run_build`); until then nothing needs to change. (2) pass the purpose at the call sites: `deployment.service.ts:498` → `'release_build'`, `test-run.service.ts:179` → `'ai_run_build'`, `sandboxes.controller.ts` (HTTP) keeps the default `'user_sandbox'`. (3) optionally add `readonly gate = 'build_allowance'` to `ReleaseBuildBudget`. (4) when `builder.billing_separation` is ON for `user_sandbox`, add a `user_sandbox` entry the same way.

## Phase 2 completion batch (2026-11-24) — scaffold gaps, qualification plan, Track D, Track E
Merged `integration/ai-engine` (4feb1d84) first. **Evidence label for all of it: SIMULATED / NOT VERIFIED. Mock and simulated tests prove control-plane policy logic and bookkeeping only, not isolation.**

| Item | What was done | Where | Result seen |
|---|---|---|---|
| (1) scaffold gaps | **default-deny egress allowlist** in `RuntimeSpec` (`egressAllow`, port 443, plain DNS names only, built from the dependency policy's registries via `registryHosts`; validated: empty list refused for `registry-only`, any list refused for `none`, IP literals/wildcards/internal suffixes/ports refused); **measured-usage settlement** (`ExecutionOutcome.usage`, the orchestrator settles on measured CPU, capped at the reservation, else wall time); **version-aware seeding** (`ExecutionRunContext.source` → `RunInputs.seedFiles(source)`); **`needsRealNode` label per conformance case + a statement in every report**. Already in place from earlier batches: isolated per-run workspaces, quotas/limits via monitor, cancellation and emergency termination, dependency policy (lockfile only, `--ignore-scripts`, registry allowlist, integrity hashes), artifact extraction with kinds/size caps/link refusal, reaper, accounting events | `runtime-spec.ts`, `port.ts`, `orchestrator.ts`, `real-runtime/{real-runtime,dependency-policy,conformance}.ts` | domain `src/ai` 49 files / **900 tests passed** |
| (2) qualification plan | RUNTIME-QUALIFICATION.md §0: roles, 17-step list (S0-S16) with who/command/expected/evidence/failure, per-case PASS criteria for all 65 isolating attempts by category, failure handling, evidence file list, ready/not-ready. **Reviewed bootstrap artifacts, NEVER executed:** `docs/security/sandbox/bootstrap/node-bootstrap.sh` (gVisor; default `--plan` prints only; `--apply` refuses without reviewer sign-off ref, pinned runsc version + sha512s, a clean dedicated Linux node), `node-inventory.sh` (read-only), README | docs | `bash -n` syntax check only on both scripts (no shellcheck available); nothing run |
| (3) Track D | `run-in-runtime.ts` + `run-in-runtime.cli.ts`: runs a closed-catalogue profile against a `simulated:<node>` endpoint (SIMULATED, origin MOCK, fixed argv); `--mode live` refuses before any node contact unless attestation, D-21, HG-10-02, ADR and approval refs (+ `NUZM_EXECUTION_APPROVED`), node binding and a node client all exist; staging only | `apps/api/.../sandbox/` | `run-in-runtime.spec.ts` 7 tests pass |
| (4) Track E | `handoff-conformance.ts`: the lifecycle's exact `ExecutionPort` calls as data (`LIFECYCLE_PORT_CALLS`) and the shared test `runLifecycleHandoffConformance` (9 cases) with mock and simulated-node rigs; S05's real `ExecutionBuildPort` passes all but H-9; **gap found:** the port is never told which project version a call is for (the repair loop builds a new version each round), so S05's adapter must pass `ctx.source`: CONTRACT-04-4 | `real-runtime/handoff-conformance*.ts`, `docs/parallel/sessions/CONTRACT-04-4-lifecycle-port-handoff.md` | 4 tests pass; H-9 SKIPPED (not a pass) until S05 passes `source`, FAILS under `expectSource: true` for today's adapter |
| (5) DB-backed `sandbox.int.spec.ts`, `m09-real.int.spec.ts` | **NOT RUN**: the heavy lock `/private/tmp/nuzm-heavy.lock` was held and the load average was 150-250 when I tried; waiting for the Master's release, then own PG on 54344 | | not verified |
Fixes made while verifying: `EndpointSandboxRuntime` and the EX-SPEC attempts now pass `egressAllow`. Final results this batch: domain `src/ai` 900 passed; `apps/api` sandbox + execution 7 files / **117 passed**; ESLint clean; `pnpm scan:secrets` OK (0 hits). Not run: integration specs, API typecheck (other packages' dists), anything live.
