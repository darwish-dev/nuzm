# Verification plan: what a reviewer must verify on a real runner

Status: PREPARED. Nothing below has been run against a real runtime; there is none. Rows say what the **offline work already proves** (control plane, with the test that proves it) and what **only a real runner can prove** (status `NOT_VERIFIED` until then). A mock cannot prove isolation.

| # | Control (ADR-067 item) | Proven offline (test) | Must be verified on a real runner (evidence the reviewer records) |
|---|---|---|---|
| 1 | Profiles, not commands (1) | `exec-policy.spec.ts`, escape EX-ARGV/PROFILE/SCRIPT/DIR | the runner executes exactly the spec's argv: trace of the process tree for each profile |
| 2 | Fixed environment (2) | `env-guard.spec.ts`, EX-ENV, `execution-port.spec.ts` | `/proc/1/environ` and `printenv` inside the sandbox show only the constant; no inherited variable (XR-ENV-1, CA-R1/R2) |
| 3 | Network classes (3) | `egress.spec.ts` (68), PB/MD/LM/DNS families | from inside: no route to the control plane, other sandboxes, metadata (XR-NET-1..4, MS-1, LM-N1..3); `none` has no resolver; `registry-only` reaches only the mirror |
| 3b | Human approval (3) | `approval.spec.ts`, orchestrator spec, EX-APPROVAL | the approval UI shows the structured summary; the permission model is the owner's |
| 4 | Filesystem (4) | workspace/artifact guards, EX-WS, EX-ART | read-only root, nosuid/nodev scratch, symlink/hardlink/bind-mount/TOCTOU attempts all fail (XR-SYM-*, MP-*) |
| 5 | Resource limits (5) | `limits.spec.ts`, `monitor.spec.ts`, `quota` | cgroup/VMM enforcement of memory, pids, disk, inodes, CPU; fork, memory, disk, output bombs end as designed (RX-*, XR-RES-*) |
| 6 | Tenant isolation (6) | policy refuses another org/run; queue fairness; quota per org | one sandbox per run; nothing readable from another run's workspace or memory; two concurrent runs of two organizations cannot see each other (XR-SYM-6, CA-R3) |
| 7 | Audit (7) | `audit.spec.ts`, orchestrator spec, platform sink adapter | events reach `audit.audit_logs` hash-chained; no content; a sample reconciles with the runner's own log |
| 8 | Kill switch and flags (8) | `termination.spec.ts`, orchestrator spec | end-to-end: engage the switch with a real running sandbox and measure time to SIGKILL, workspace teardown and node state (target to be set by the owner, e.g. against the AI kill-switch's 5 s) |
| 9 | The gate (9) | `exec-policy.spec.ts`, EX-GATE | the gate state is set by recorded decisions, not by configuration alone |
| 10 | Escape suite (10) | EX-* (131 attempts) BLOCKED on the mock | XR-* and every base isolating attempt BLOCKED on the real runner, 0 ESCAPED, by a named reviewer |
| 11 | Runtime hardening spec | `runtime-spec.spec.ts`, EX-SPEC-* | the runner's actual configuration (inspect the live sandbox) equals the spec: privileged off, caps dropped, seccomp profile loaded, user, mounts |
| 12 | Health and cleanup | `monitor.spec.ts`, `cleanup.spec.ts` | after a run, a kill and a node failure nothing remains (processes, mounts, namespaces, files, VMs) |
| 13 | Compatibility | none | all five profiles on representative projects; the chosen runtime's syscall/`/proc` differences recorded |
| 14 | Supply chain of the runner | none | image provenance, guest kernel and VMM patch level, node image hardening, update cadence |

## Entry criteria for the HG-10-02 review
A runnable non-production runner supplied by the owner (HG-05-04 for KVM where needed); the escape suite in this repository (`escape-suite.ts` 1.1.0, `escape-suite-exec.ts`); the threat model; this plan; the runbook; a named reviewer and the acceptance bar. The assistant records nothing as reviewed or granted.

## Exit criteria (AC-AG-12, restated)
Gate open for a named environment **by decision**; escape suite passing on the real runtime with `isolationEvidence: true`; ADR-067 accepted; cost and abuse tests; runbook exercised once; owner sign-off. None exists today: S-AG6 is **0 % complete as a capability**; the offline machinery is complete.
