# Recommended architecture for execution (S-AG6)

Status: **design for the owner's decision and the HG-10-02 review. Not built, not enabled.** The offline parts that exist are marked **[built, offline]** with the code that holds them; everything else is **[designed]** and depends on D-21.

## 1. Two planes
```
 Control plane (Nuzm API / worker, normal trust)              Execution plane (hostile-code trust, dedicated nodes)
 ┌─────────────────────────────────────────────┐              ┌──────────────────────────────────────────┐
 │ agent loop / builder ──ExecutionPort──┐      │              │ node pool "sandbox" (tainted, no creds)  │
 │                                       ▼      │              │  ┌────────────┐  one microVM/gVisor      │
 │ ExecutionOrchestrator [built, offline]       │  jobs, spec  │  │ runtime    │  sandbox per RUN         │
 │  flag → kill switch → gate → policy →        │ ───────────► │  │ agent      │  RO root, scratch quota  │
 │  quota → approval → queue → claim            │              │  └────────────┘  constant env, no secrets│
 │ ApprovalWorkflow, QuotaLedger, Queue,        │  outcome     │        │ only exit                       │
 │ Audit, Terminator, Monitor [built, offline]  │ ◄─────────── │        ▼                                 │
 │ ExecutionRuntime interface [built]           │              │  egress proxy (registry-only class)      │
 └─────────────────────────────────────────────┘              └──────────────────────────────────────────┘
        │ audit (content-free), metering                         no route to DB, Redis, admin, metadata,
        ▼ platform.operations, audit.audit_logs                  other sandboxes
```
The control plane never executes a model- or customer-written byte. It decides, queues, meters and audits. The execution plane runs one fixed argv per run and returns bounded, screened output.

## 2. The request path (ADR-067), as built offline in `ExecutionOrchestrator`
1. **Flag and switches:** `ai.agent.exec_tools` (default off; `AiFlags.execTools` is hard-wired false), the platform AI kill switch, the execution kill switch (global and per organization). **[built]**
2. **Gate:** a `REAL` port is refused unless `executionGate` is open (D-21 decided, runtime isolation verified, escape suite passed, ADR accepted, owner approval, and in production D-42). The mock port is labelled `MOCK` in every audit record and job view. **[built]**
3. **Policy (`decideExec`):** the model names a profile and typed parameters; everything else (argv, env, cwd, network, image, mounts, limits, approval…) is refused by name. Fixed argv, constant environment, fixed limits, network class. **[built; inherited profile names such as `constructor` now read as unknown profiles]**
4. **Quota (early check):** per-organization concurrency, runs per window, CPU-seconds per window, budget cap in integer minor units; the restrictive default (budget 0) admits nothing. **[built]**
5. **Approval:** `install-deps` and `run-script` (network or install) wait for a human: a signed-in user of the same organization holding the permission; never a model, API key or system actor; bound by digest to the exact decision; single-use; expires; revocable. **[built]** UI copy and the `ApprovalKind` row in `ai.approvals` are **[designed]** (Session 05 owns the builder kinds; the execution kind is a CONTRACT request).
6. **Queue:** idempotent per (organization, key), bounded depth, FIFO within an organization and fair across organizations, leases with heartbeats so a crashed worker never strands a run (reconcile before retry), expiry of stale waits. **[built in memory]** The durable version is BullMQ plus `platform.operations` **[designed]**.
7. **Claim and run:** re-check switches and gate, verify the environment is exactly the constant, reserve quota, consume the approval, call `ExecutionPort.run`. **[built]**
8. **Screen:** stdout/stderr redacted for secrets and canaries (a canary hit engages the organization's kill switch: fail closed); artifacts validated (output roots only, regular files only, hashed, bounded) and **never applied automatically**; output reaches a model only inside a fenced untrusted-data block. **[built]**
9. **Settle and audit:** quota settled on measured use, job to a terminal state, a content-free audit event for every step (request, decision with reasons, approval steps, start, finish with exit status and byte counts). **[built]**

## 3. Per-run workspace lifecycle
`creating → ready → in_use → ready → destroying → destroyed` (any state → `failed → destroying`); `destroyed` is final and a workspace is never reused. The planner (`planCleanup`) reaps by job end (after a short artifact-collection grace), termination (immediately), lifetime, idle time, orphan and failure. One writable scratch with a disk quota; the project snapshot is copied in after the secret screen (`checkWorkspaceFiles`); `.env`, keys, `.git`, `node_modules` mutations outside the toolchain mount are never mounted. **[built as state machine and planner; the real create/destroy is a runtime concern]**

## 4. Runtime specification and interface
`buildRuntimeSpec` turns an allowed decision into a complete, explicit specification (runtime class, unprivileged user, read-only root, all capabilities dropped, default-deny seccomp, no host namespaces, only `/work`, `/scratch` and a read-only `/toolchain` mounted, own network namespace, cgroup limits, no swap, workspace bound to the run). `validateRuntimeSpec` is the independent check that refuses anything weaker. The `ExecutionRuntime` interface (`start/wait/stats/kill/destroy/health`) is what a gVisor, Firecracker or Kata adapter will implement; `RefusingRuntime` is the only implementation today. **[built]**

## 5. Network
Default `none`: the sandbox has its own network namespace and no interface that routes anywhere. `registry-only` reaches the package mirror only through the egress proxy (exact host, port and purpose; IP literals, private ranges, metadata addresses and re-bound or redirected targets refused, DNS answered for exact names only; `egress.ts`, 68 unit cases). Sandbox network segments have no route to the control plane, to each other or to the metadata service; the proxy is the only exit. **[policy built; the segmentation is a runtime/node-pool property: NOT_VERIFIED]**

## 6. Failure handling
| Failure | Behaviour |
|---|---|
| runtime unhealthy | `RuntimeHealthMonitor`: degraded takes no new runs, unhealthy triggers emergency termination of what runs on it |
| a limit crossed | monitor says kill (CPU, wall, memory, pids, disk) or truncate (output); wall time is measured by the monitor, not trusted from the runtime; a silent run is killed |
| uncertain result / timeout | no blind retry: the lease expires, the job is requeued once (`maxAttempts`) only after reconciliation, then failed |
| ignored SIGTERM | `terminate()` escalates to SIGKILL of the process group, destroys the workspace, marks the job, records a zombie that survives |
| canary in output | redact, audit, engage the organization kill switch |
| approval expired while queued | the run stops at claim time |

## 7. Rollout phases (each needs the owner's decision; none is scheduled)
0. **Now:** offline machinery and mock only; gate closed.
1. **Decide D-21**, name the HG-10-02 reviewer, provision a *non-production* dedicated node pool (owner-provided, HG-05-04), implement one `ExecutionRuntime` adapter behind the existing interface, run the full suite and the compatibility run, review.
2. **Gate opens for one named non-production environment** by decision; `typecheck`/`unit-tests`, network `none`, one organization; cost and abuse monitoring on.
3. `build`, then approval-gated `install-deps`/`run-script`; production only after D-42 and LEGAL-EXEC (terms and liability for executing customer code).

## 8. Decisions this design needs from the owner
D-21 (technology), node pool and its budget (`N_peak`, price, currency), HG-10-02 reviewer, LEGAL-EXEC, ADR-067 acceptance, the approval permission model for execution, log retention (D-34), D-42.
