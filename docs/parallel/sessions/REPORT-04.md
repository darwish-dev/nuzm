# REPORT-04: Session 04, Sandbox and Execution Gateway (S-AG6 offline)

- **Session ID:** 04 · **Branch** `feature/ai-sandbox` · **Worktree** `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-sandbox` · **Baseline** `f81872d5` (docs commit `9d16e7f3` on top) · **Current commit:** see `git log` (last: workspace registry, then this report).
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
| 16 | Escape suite 1.1.0: 127 EX control-plane attempts BLOCKED, 21 XR isolating attempts NOT_VERIFIED (suite total 273) | `escape-suite-exec.ts`, `escape-suite.ts` | `escape-suite.spec.ts` (4) |
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

## Security findings (all offline, all fixed, each with a test)
1. **S04-F1 (low, availability):** `decideExec` threw a TypeError for a model-chosen profile named `__proto__`, `constructor`, `toString`, `hasOwnProperty` or `valueOf` (the lookup returned an inherited object, then `profile.params.script` was dereferenced). Found by the new escape attempts EX-PROFILE-2..5. Fixed in `policy.ts` (own properties only; reads as `unknown_profile`); `exec-policy.spec.ts` covers it. No bypass: such a profile was never enabled.
2. **S04-F2 (test robustness):** base escape attempts WS-2/3/4/6 reported ESCAPED instead of NOT_VERIFIED when the suite runs without a database (`!!c.tickets && …`). Now they throw "needs the database" like WS-1/5. With a database behaviour is unchanged.
3. Design observations (not defects): `AiFlags.execTools` is hard-wired false (good, untouched); the base suite's isolating attempts would pass on a *mock that lies about `isolation: verified`* (the mock answers 127 to unknown commands), so a mock must never be allowed to claim `verified`; the orchestrator and `executionGate` refuse a verified-looking runtime while the gate is closed (EX-GATE-8). Documented in `ESCAPE-SUITE-1.1.md`.

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
1. `NUZM_TEST_ADMIN_URL=… pnpm --filter @nuzm/api exec vitest run -c vitest.integration.config.mts src/modules/appbuilder/sandbox.int.spec.ts` on the integration branch after merge: the whole 273-attempt suite with database-backed ticket attempts. Expected: 0 ESCAPED, every control-plane attempt BLOCKED, every isolating attempt NOT_VERIFIED, `isolationEvidence` false (the unit spec shows these properties without a database; the int spec also asserts `notVerified > 40`, which now holds with the 21 XR attempts added).
2. `pnpm --filter @nuzm/api typecheck` (needs the built package `dist`s) to close the API typecheck gap noted above.

## Escalations
None blocking. Owner decisions this work feeds (already in OWNER-DECISIONS): D-21, ADR-067, LEGAL-EXEC, D-42, plus, newly named: the node-pool budget (`N_peak`, price, currency), the execution approval permission model, the kill-switch time target for the review.
