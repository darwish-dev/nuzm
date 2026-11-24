# P3-S02 — Real Sandbox and Execution Runtime

Branch `feature/p3-s02-runtime` · worktree `.claude/worktrees/p3-s02` · Postgres 54352 · migrations 2310–2319. Read first: `CLAUDE.md`, `docs/phase3/PHASE-3-PLAN.md`, `docs/parallel/RUNTIME-QUALIFICATION.md`, `docs/security/sandbox/**` (incl. `bootstrap/`), `docs/parallel/sessions/PHASE2-04-approval-inputs.md`, ADR-067 (Execution Gateway; ADR-069 after the join), D-21, HG-10-02.

## Implementation prompt
You turn the attested-runtime **scaffold** into a **real isolated runtime**. Never execute untrusted or generated code on this machine; the machine is macOS 13 with no Linux/KVM. Real execution happens only on a dedicated Linux node the owner provides after D-21/budget approval; you prepare everything so that the day the node exists, qualification is a procedure, not a project. Do not claim isolation from mock or container tests; only the reviewed escape-suite run on the real node, signed by the HG-10-02 reviewer, counts.
Deliver: (1) the **node agent** (`packages/runtime-agent`): receives signed run requests from the platform (mutual auth, short-lived tokens, vault reference for its credential), creates a workspace, starts the workload in gVisor (`runsc`, systrap) with fixed argv/env, network profile enforcement (default deny, registry allowlist through a mirror/egress proxy), CPU/memory/disk/pid quotas, timeouts, cancel, kill, artifact extraction with kind checks, cleanup/reaper, resource accounting, audit events; (2) the **real `ExecutionPort`/`WorkspaceRuntime` implementation** over the agent, behind the attestation gate (refuses without a verified attestation), conformance-tested against the same suites as the mock; (3) node image/rootfs build recipe, dependency-install policy (lockfile only, no lifecycle scripts by default, integrity hashes), registry mirror and egress proxy configs; (4) **durable stores** for jobs/workspaces (design in Phase 2; implement now behind the flag, migrations in your block); (5) the qualification run procedure `sandbox:escape-suite --mode qualify` against a live endpoint and the evidence/attestation pipeline; (6) a **build-environment definition** for Android builds (SDK, Gradle caches, offline mirror) delivered to P3-S06; (7) alerts/runbook for the real runner (kill switch, stuck jobs, quota breach).
## Scope boundaries
In: execution gateway, sandbox, execution module, runtime agent, infra/runtime, security docs. Out: agent loop (P3-S03), mobile build orchestration (P3-S06), deploy (P3-S07).
## Acceptance criteria
- R1 With a node + approvals: bootstrap (`--apply` only with sign-off), agent up, attestation verified, escape suite run twice on a rebuilt node: **0 ESCAPED** of 65 isolating attempts and 212 control-plane attempts; canary never read; evidence + reviewer-signed attestation stored.
- R2 Real `ExecutionPort` passes the full conformance suite and the lifecycle handoff conformance (H-1..H-9) against the real node.
- R3 Synthetic builds run for real: `typecheck`, `unit-tests`, `build` of a synthetic Node project, network `none` and registry-only profiles, quotas enforced (a fork bomb / memory hog / disk fill test is contained and accounted).
- R4 Emergency termination and kill switch verified live; cleanup leaves no workspace/process/mount.
- R5 Without a node the service refuses to start (fail-closed) and every test that proves this stays green; no code path executes anything on the developer machine.
- R6 `RUNTIME-QUALIFICATION.md` updated with the real results (LIVE-VERIFIED vs NOT VERIFIED per item).
## Dependencies
Needs: D-21, HG-10-02 (named reviewer), ADR acceptance, LEGAL-EXEC (only for customer use), a Linux node and its budget. Provides: qualified runtime to S03, S05, S06, S08.
## Human gates
Renting/provisioning the node, signing the attestation, bootstrap `--apply`, any customer-visible use.
## First tasks
Merge `integration/phase3`; implement the node agent protocol with a loopback simulated node; write the rootfs/mirror/proxy recipes; implement durable stores; run the Phase 2 runtime suites single-file; `REPORT-P3-S02.md`.
