# Sandbox and Execution Gateway: runtime evaluation and recommended architecture (S-AG6, offline)

Status: **PREPARATION. Nothing here is implemented as a capability, decided, reviewed or verified live.** Written by Session 04 on 2026-11-24 for the owner's decision on D-21 and the HG-10-02 review. It extends, and does not replace, `../sandbox-threat-model.md`, `../sandbox-technology-comparison.md` and `../sandbox-review-pack.md`.

| Document | What it answers |
|---|---|
| [RUNTIME-EVALUATION.md](RUNTIME-EVALUATION.md) | gVisor, Firecracker, Kata, hardened containers: isolation model, escape surface, compatibility, operations, cost drivers, and what must be verified for each |
| [RECOMMENDED-ARCHITECTURE.md](RECOMMENDED-ARCHITECTURE.md) | the control plane / execution plane split, dedicated node pool, network and egress design, per-run lifecycle, failure handling, rollout phases |
| [VERIFICATION-PLAN.md](VERIFICATION-PLAN.md) | exactly what a reviewer must verify on a real runner, by control, with the evidence each needs; what the offline work already proves and does not |
| [ESCAPE-SUITE-1.1.md](ESCAPE-SUITE-1.1.md) | the extended escape-attempt catalogue: what runs today (control plane), what stays NOT_VERIFIED (isolating runtime), what each result means |
| [../../parallel/RUNTIME-QUALIFICATION.md](../../parallel/RUNTIME-QUALIFICATION.md) | **Phase 2:** the infrastructure that exists (macOS 13, no Docker/KVM: cannot qualify anything), what a real Linux node must provide, the recommended runtime and why, the isolation test plan T1-T12, evidence to record, SIMULATED vs LIVE-VERIFIED, gates, runbook outline, rollback |
| [DURABLE-STORES-DESIGN.md](DURABLE-STORES-DESIGN.md) | **Phase 2:** design (not enabled, no migration) of the durable jobs/workspaces/approvals/nodes/usage stores for after D-21 |
| [RUNBOOK-EXECUTION.md](RUNBOOK-EXECUTION.md) | operating the (future) execution path: kill switch, emergency termination, cleanup, incidents. Offline draft: nothing to operate yet |

## Ground rules that never change in this work
- D-21, HG-10-02, ADR-067 (PROPOSED), D-AG-ROLLOUT and `ai.agent.exec_tools` (default off, `AiFlags.execTools` always false) stay as they are. `executionGate` stays closed.
- No customer code and no model-written code is executed, anywhere, by anything in this repository. The mock (`MockExecutionPort`, `MockSandboxRuntime`) starts no process. The local developer runner (isolation NONE) is refused by the execution port.
- **A mock cannot prove isolation.** Every isolating-runtime attempt is `NOT_VERIFIED` until a runtime with `isolation: verified` is attacked by the suite and reviewed. Offline results are never labelled verified for the real thing.
- Figures, prices and vendor capabilities in these documents are engineering knowledge, not live-verified, and no price is stated: costs are formulas over the owner's own numbers.
