# ADR-067: Execution Gateway for agent execution tools (S-AG6)

- Status: **PROPOSED — not accepted, not implemented as a capability.** Depends on D-21 (OPEN) and ADR-015 (Proposed, OPEN). Nothing in this ADR enables execution; the policy core in `packages/domain/src/ai/execution-gateway/` is pure, unused and gated closed.
- Related: ADR-066 (items 6–8), D-21, D-AG-ROLLOUT, HG-10-02 (sandbox isolation security review), the existing M10 sandbox service and escape-attempt suite (`apps/api/src/modules/appbuilder/internal/sandbox/`, suite version 1.0.0).
- Date: 2026-11-24. Owner decision needed: accept, change or reject.

## Context
ADR-066 forbids any build, test, shell or executable tool until D-21's isolation requirements are met. The read-only tools (S-AG2) and the loop (S-AG3) exist. Running tests or builds would let the agent verify its own work, but it means executing code that a model wrote or a customer supplied.

## Decision (proposed)
1. **Profiles, not commands.** The model names a profile from a closed catalogue (`typecheck`, `unit-tests`, `build`, `run-script`, `install-deps`) and gives typed parameters. The gateway maps it to a **fixed argv**. Any other member in the request (argv, command, env, shell, cwd, network, …) is refused by name. `run-script` accepts only a script name that matches `^[a-z][a-z0-9:_-]{0,40}$`, is declared in the project's `package.json`, and is not an npm lifecycle or publish script.
2. **Fixed environment.** The whole environment of a run is a constant (`CI`, `NODE_ENV`, `PATH`, `HOME`, …). No platform secret, no variable from the request, no inherited variable.
3. **Network classes.** `none` (default) or `registry-only` (a package-registry allow-list through the existing egress proxy). Any profile that reaches a network or installs code (`install-deps`, `run-script`) requires a **human approval** per run; `npm ci --ignore-scripts` only.
4. **Filesystem.** The workspace is a copy of the project at a version; the root filesystem is read-only; one writable scratch directory with a disk quota; secrets, `.env`, VCS internals and installed-package mutations outside `node_modules` are not mounted. Results come back as a tool result (bounded, framed as untrusted data); files the run produced are never applied automatically — changes still go through the existing patch proposal and human approval path.
5. **Resource limits per profile** (CPU seconds, wall seconds, memory, pids, output bytes, disk), plus per-run and per-organization ceilings and a budget cap; every execution is metered through the central pipeline.
6. **Tenant isolation.** One sandbox per run, never shared across runs or organizations; the request must carry the run's own org and run id (checked); no cross-sandbox network; the runtime's handle is not exposed to the model.
7. **Audit.** Every request, decision (allowed or refused, with reasons), approval, start, finish, exit status and byte counts is audited without content; refusals count toward abuse signals.
8. **Kill switch and flags.** Feature flag `ai.agent.exec_tools` default off, the existing AI kill switch applies, and a separate execution kill switch stops running sandboxes.
9. **The gate.** `executionGate(state)` is open only when D-21 is decided, a runtime is `isolation: verified`, the escape suite passed on it (every isolating attempt BLOCKED, none ESCAPED), this ADR is accepted, the owner approved, and, in production, D-AG-ROLLOUT is decided. Today every condition is false.
10. **Escape suite.** The existing catalogue (control-plane attempts run today; isolating-runtime attempts are NOT_VERIFIED on the mock) is extended for execution: model-supplied argv and env smuggling, script-name injection, lifecycle-script abuse, output-injection back into the prompt, symlink and mount escapes, fork and memory bombs, metadata-service and lateral-network access, DNS exfiltration, runtime-socket access. The policy-level subset is already covered by `exec-policy.spec.ts`; the runtime-level subset needs a verified runtime.

## Alternatives considered
Free-form shell tool (rejected: the model controls the command line); hosted third-party execution (needs a vendor and a data-transfer decision, D-38-adjacent); executing in the customer's own hosting (rejected: customer infrastructure, cost and trust).

## Consequences
The agent can verify work only through a small, auditable set of profiles; new profiles need an ADR amendment. Runtime cost and the dedicated nodes are budget decisions for the owner. Until D-21 and the review are done, nothing here runs.

## Offline hardening addendum (Session 04, 2026-11-24; the ADR stays PROPOSED)
Recorded as proposed amendments, each already implemented as inert offline code with tests; accepting the ADR would accept them:
1. **Approval binding:** an approval is bound by digest to the exact decision (profile, argv, cwd, environment, limits, network, organization, run), single use, expiring, decidable only by a human user of the same organization holding the permission; never a model, API key or system actor.
2. **Kill switch scope:** global and per-organization execution kill switches, separate from the AI kill switch; a canary appearing in output engages the organization's switch (fail closed).
3. **Two walls for the environment:** `decideExec` produces the constant environment and `checkRunEnv` re-verifies it immediately before a run; loader, proxy, npm-config and credential-looking variable names are refused by name.
4. **Port origin:** an `ExecutionPort` is `MOCK` or `REAL`; a `REAL` port is refused unless `executionGate` is open, at submit and again at claim time. The local developer runner is refused for agent execution unconditionally.
5. **Artifacts are candidates only:** output roots, regular files, hashes, bounds; never applied automatically (the patch proposal and human approval path stays).
6. **Runtime classes:** only isolating classes (gVisor, Kata, Firecracker microVM) pass `validateRuntimeSpec`; a plain `runc` container does not.
7. **Quota defaults closed:** a budget of 0 admits nothing; reservations are worst case and settled on measured use in integer minor units.
8. **Fix:** inherited object names (`constructor`, `__proto__`…) as the profile are now an unknown profile, not a crash.
Technology choice and rollout: `docs/security/sandbox/RUNTIME-EVALUATION.md`, `RECOMMENDED-ARCHITECTURE.md`. Nothing here changes the gate (item 9) or any decision owned by the owner.

## Owner / date
OWNER-PLACEHOLDER / —
