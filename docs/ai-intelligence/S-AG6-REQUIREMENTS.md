# S-AG6 — security and architecture requirements (OFFLINE PREPARATION)

Status: **BLOCKED (D-21).** This page maps ADR-067 (proposed) to testable requirements and says what exists. Nothing executes.

| Area | Requirement | Exists now | Needs |
|---|---|---|---|
| Execution Gateway | Closed catalogue of profiles; fixed argv/env; refusals by name | `execution-gateway/index.ts` (`decideExec`), 30 cases in `exec-policy.spec.ts` | wiring behind the gate, only after D-21 |
| Isolated runtime | `isolation: verified` runtime, per-run sandbox, no shared state | M10 sandbox service, mock runtime and local dev runner (isolation NOT verified) | D-21 decision, dedicated nodes, a real runtime |
| Filesystem | read-only root, scratch dir with quota, no secrets/`.env`/VCS mounted | path and secret checks in the control plane (paths.ts, escape suite control-plane attempts) | runtime-level mount policy |
| Network | `none` default; `registry-only` via egress proxy; no metadata service, no lateral movement, no DNS exfiltration | egress policy and its tests (`egress.spec.ts`) | runtime network segmentation (isolating attempts) |
| Command permissions | model never supplies argv; script names validated; lifecycle scripts denied | `decideExec` | none for policy; runtime enforcement |
| Resource limits | per-profile CPU/wall/memory/pids/output/disk | declared in the profiles; sandbox quotas exist | runtime cgroup enforcement (isolating attempts) |
| Tenant isolation | request carries the run's own org/run id; one sandbox per run | checked in `decideExec`; sandbox service is org-scoped with RLS | cross-tenant escape tests on a real runtime |
| Human approval | human approval for network or install profiles; approval per run | `requiresApproval` in the decision; the generic run-approval workflow exists | UI copy and the approval kind for execution |
| Audit | request, decision, approval, start, finish, exit status, byte counts, no content | audit sink and event naming conventions exist | execution events (after wiring) |
| Escape suite | catalogue extended for execution; isolating attempts run on a verified runtime | suite 1.0.0 (794 lines): control-plane attempts real, isolating attempts NOT_VERIFIED on mocks | the real runtime and a reviewer |
| Gate | open only when D-21, verified runtime, escape suite, ADR accepted, owner approval (and D-42 in production) | `executionGate`, closed by default, tested | the decisions |
Acceptance for S-AG6 (AC-AG-12): the gate open for a named environment by decision, the escape suite passing on the real runtime, ADR-067 accepted, tests including escape and cost, runbook, owner sign-off. None of these exists; S-AG6 is **0 % complete as a capability**, with the offline requirements and policy core done.
