# Runtime qualification: from a simulated execution port to an attested staging runtime

Author: Session 04 (Sandbox and Execution Gateway) · Phase 2 · 2026-11-24 · Status: **preparation; nothing in this document has been run on a real runtime.**

Evidence labels used throughout (CLAUDE.md §5/§6): `SIMULATED` (a stand-in produced it; no isolation was exercised) · `NOT VERIFIED` (implemented, live validation missing) · `LIVE-VERIFIED` (only after a real attested node ran it, with an evidence file). Today **everything about isolation is `NOT VERIFIED`** and every result from this repository is `SIMULATED`.

Related: [RUNTIME-EVALUATION](../security/sandbox/RUNTIME-EVALUATION.md) (technology comparison) · [RECOMMENDED-ARCHITECTURE](../security/sandbox/RECOMMENDED-ARCHITECTURE.md) · [VERIFICATION-PLAN](../security/sandbox/VERIFICATION-PLAN.md) · [ESCAPE-SUITE-1.1](../security/sandbox/ESCAPE-SUITE-1.1.md) · [RUNBOOK-EXECUTION](../security/sandbox/RUNBOOK-EXECUTION.md) · [DURABLE-STORES-DESIGN](../security/sandbox/DURABLE-STORES-DESIGN.md) · [approval inputs](sessions/PHASE2-04-approval-inputs.md).

> **An ordinary container is not evidence of hostile multi-tenant isolation.** A `runc` container (Docker, rootless Docker, Podman, a Kubernetes pod without a sandbox `RuntimeClass`) shares the host kernel's full syscall surface with the code it runs; one kernel bug reachable through any allowed syscall defeats it. Hardening flags (seccomp, dropped capabilities, read-only root, user namespaces) reduce the surface and are required, but they do not turn a container into an isolation boundary for code an attacker controls. This repository therefore treats `runc`-class runtimes as **not acceptable** for customer-supplied or model-generated code (`validateRuntimeSpec` refuses them: `runtime_class_not_isolating`; the attestation verifier refuses them too). A container is fine for the developer-convenience `local-dev` runner, which the execution port refuses unconditionally.

## 1. The infrastructure that actually exists today

Read-only facts gathered on the machine this work runs on (2026-11-24; nothing was installed or started):

| Fact | Value | Consequence |
|---|---|---|
| OS | macOS 13.7.8 (Darwin 22.6.0), Intel x86_64 | gVisor, Firecracker and Kata are **Linux-only** technologies: none can run here natively |
| CPU / RAM / disk | Intel i5-7267U, 4 logical CPUs, 8 GiB RAM, 67 GiB free | shared by seven sessions and the owner's dev stack: cannot be a dedicated node, cannot host a representative load |
| Hypervisor.framework | `kern.hv_support = 1` | a Linux VM (QEMU/Lima/Colima) could run here, but KVM-in-guest (nested virtualization) is not something macOS offers to its guests (V: verify before relying on it) |
| Docker / Podman / QEMU / Firecracker / runsc / Kata / Lima / Colima / Multipass / kubectl | **none installed** | no container or VM runtime of any kind is available |
| KVM | none (macOS) | no microVM class is possible on this host |
| Compute provider for a Linux node | **none selected** (HG-05-04 open) | no node exists to qualify |

Conclusions, stated plainly:
1. **This Mac cannot be a qualification node, now or after installing tooling.** It is not Linux, not dedicated, not isolatable from the owner's secrets and dev stack, and not representative. Anything run in a Linux VM on it would be developer convenience, `NOT VERIFIED`, and must never be recorded as evidence for D-21/HG-10-02.
2. **No untrusted code is ever run on this host**, by this work or by any test in the repository: the only implementations behind `ExecutionPort` are `MockExecutionPort` and `SimulatedWorkspaceRuntime`, which start nothing; the `local-dev` runner is refused by the execution port; the live qualification modes of the runner refuse without an approval reference, a staging node and a node client (none exists).
3. The next real step is **a Linux, non-production, dedicated node** (section 3). Choosing its provider and paying for it is an owner action (HG-05-04, D-21), not something an agent does.

## 2. What was built offline (all SIMULATED)

| Piece | Where | What it proves today |
|---|---|---|
| Gateway policy, orchestrator, quota, queue, approvals, audit, kill switch, monitor, artifacts, cleanup (Phase 1) | `packages/domain/src/ai/execution-gateway/**` | control-plane behaviour, on the mock |
| **Isolation attestation** (schema, canonical signing bytes, fail-closed verifier, draft builder, simulated kit) | `real-runtime/attestation*.ts`, `simulated-attestation.ts` | a node without a verifying, signed, unexpired, node-bound attestation cannot start the service; reasons are content-free |
| **Real-runtime service and port** (`RealRuntimeService.start` → `portFor`) | `real-runtime/real-runtime.ts` | fail-closed start; per-run workspace; spec built by `buildRuntimeSpec` and re-validated; seed screening; dependency policy; wall/limit/abort/terminate kill paths; unresponsive-node and cleanup-failure quarantine; artifact extraction with hash verification; accounting and content-free events; orphan reaping; re-verification of the attestation before every run |
| **Node contract** `WorkspaceRuntime` + `SimulatedWorkspaceRuntime` | `real-runtime/workspace-runtime.ts` | the wire-level operations a node agent must implement; a stand-in that starts nothing and independently refuses weakened specs |
| Dependency-install policy | `real-runtime/dependency-policy.ts` | git/URL/path/alias dependencies, foreign registries, missing integrity, oversize lockfiles refused before any network call |
| **Conformance suite** + 22 synthetic fixtures | `real-runtime/conformance.ts`, `fixtures.ts` | the same 28 assertions run against `MockExecutionPort` (policy/runtime layers; the rest SKIPPED, never PASS) and against the real-runtime port over the simulated node (all layers) |
| **Escape-suite qualification runner + CLI**, node adapter | `apps/api/.../sandbox/escape-runner.ts`, `escape-runner.cli.ts`, `endpoint-runtime.ts` | suite 1.1.0 (277 cases; actual simulated run: 206 PASS, 0 FAIL, 71 NOT_VERIFIED = 65 isolating + 6 database-backed ticket cases) with per-case PASS/FAIL/NOT_VERIFIED, report digest, draft attestation for the reviewer |

Reachability: none of this is imported by a NestJS module, route, controller, job or tool declaration. The flag `ai.agent.exec_tools` stays default off and `executionGate` stays closed. A `REAL` origin exists only for a `live`-mode service that started under a LIVE-VERIFIED attestation; the simulated mode (the only one runnable here) reports `MOCK`.

## 3. What a real Linux non-production node must provide

Everything marked (V) must be verified on the node by the reviewer; none of it is asserted as fact about a particular node here. Versions are placeholders for the reviewer's pinned choices.

### 3.1 Host
| Area | Requirement | How it is checked / recorded |
|---|---|---|
| Machine | **Dedicated** to sandbox runs: no control-plane service, database, queue, admin console, CI runner, monitoring agent with secrets, or other tenant workload. Tainted/segregated node pool or a standalone machine. | attestation `host.dedicatedNode`; inventory listing |
| OS and kernel | Linux x86_64 (or aarch64), a vendor-supported LTS distribution with automatic security updates and a pinned, recent LTS kernel (V: choose 6.1+ so cgroup v2, seccomp, user namespaces and the KVM/gVisor features below are current). Kernel version recorded in the attestation; a kernel change re-triggers qualification. | `uname -r` in the evidence file |
| cgroups | **cgroup v2** unified hierarchy with `cpu`, `memory`, `pids`, `io` controllers delegated to the runtime. Per sandbox: `cpu.max`, `memory.max`, `memory.swap.max=0`, `memory.oom.group=1`, `pids.max`, `io.max`. | attestation `host.cgroupsV2`; probe output |
| Swap | Disabled (the spec requires `swapMb: 0`) | attestation `host.swapDisabled` |
| Disk quota | Per-workspace quota that the guest cannot exceed or evade: XFS project quotas on a dedicated filesystem, or a sparse per-workspace volume (ext4/xfs on a loop or device-mapper device) sized to `diskMb`, plus an inode cap; scratch on `tmpfs` with `size=`. | attestation `host.diskQuota`; `FX-DISK-FILLER` |
| Container-runtime sockets | No Docker/containerd/CRI-O socket reachable from any sandbox; the node agent is the only local control surface and listens only for the control plane | attestation `host.containerRuntimeSocketNotExposed`; `MP-*`/`RS-*` attempts |
| Metadata and cloud identity | No instance role or cloud credential on the node that matters; the instance-metadata address (`169.254.169.254`, `fd00:ec2::254` and provider equivalents) unreachable from sandboxes | attestation `host.metadataServiceBlocked`; `MS-*`, `FX-NETWORK-PROBE` |
| Host hardening | Minimal packages, no compilers or shells for non-operators, SSH by keys only from a bastion, auditd or an eBPF sensor forwarding to the platform log (D-34), time sync, host firewall default-deny both ways | inventory + config hash |
| Recycling | Node rebuilt from the image on a schedule and after any incident or canary alert; **a node that ran hostile code is never trusted again** | runbook; attestation expiry ≤ 30 days |
| SMT / co-residency | Decision recorded by the reviewer for microVM classes (cross-tenant CPU side channels) (V) | attestation notes |

### 3.2 Runtime classes (acceptable: `gvisor-runsc`, `kata-qemu`, `kata-firecracker`, `firecracker-microvm`)
| Class | Extra prerequisites |
|---|---|
| **gVisor (`runsc`)** | the `runsc` and `containerd-shim-runsc-v1` release **pinned by digest** and built/verified from the vendor's signed release (V: no download is made here); platform `systrap` (default) needs no KVM, the `kvm` platform needs `/dev/kvm`; rootless mode not required; network stack `netstack` (not `host`); seccomp on the Sentry; the Gofer filesystem proxy; compatibility run for every profile (`tsc`, `npm test`, `npm run build`, `npm ci --ignore-scripts`) because gVisor does not implement every syscall (V) |
| **Firecracker microVM** | **bare metal, or nested virtualization verified by a probe against the provider (HG-05-04)**: `/dev/kvm` present and usable, CPU `vmx`/`svm`; `firecracker` + `jailer` pinned by digest; a guest kernel and a read-only guest rootfs built in CI, signed, digest-pinned; per-VM tap device or vsock channel; the jailer's chroot, seccomp, cgroup and unprivileged uid per VM; a snapshot/boot-time budget (V) |
| **Kata Containers** | the same KVM requirement; a VMM (QEMU, Cloud Hypervisor or Firecracker) and guest kernel/image pinned by digest; `virtio-fs` or block devices for the workspace; containerd/CRI `RuntimeClass` ergonomics if Kubernetes is used; shim version pinned |
| Not acceptable | `runc`, `crun`, `runc` under Kubernetes without a sandbox `RuntimeClass`, `--privileged`, host namespaces, shared PID/IPC/network, mounted docker socket: refused by `validateRuntimeSpec` and by the attestation verifier |

### 3.3 Network policy (default deny)
- Each sandbox has **its own network namespace (or tap device)**; no host networking; no shared bridge between sandboxes (no east-west traffic between tenants).
- Class `none`: no interface other than loopback.
- Class `registry-only` (`install-deps` only, after human approval): the only exit is the **egress proxy** (`egressProxyOnly`), which allows only the registry mirror hosts of the allow-list and applies the SSRF rules of `egress.ts` (private, link-local, loopback, CGNAT, documentation, multicast, IPv6 embedded-IPv4 forms, redirects re-checked).
- Block, in the host firewall independent of the proxy: RFC1918, CGNAT, link-local and metadata, the node's own addresses (except the proxy), the control-plane and database CIDRs, other sandboxes. IPv6 either disabled or covered by the same rules (the suite has IPv6 cases).
- DNS only through the proxy/resolver allow-list; direct outbound UDP/TCP 53 blocked (`dns_exfiltration` attempts).
- Node-agent channel: **mTLS from the control plane only**, short-lived client certificates, the agent's listener bound to the management interface, never to the sandbox network.

### 3.4 Image supply chain
Pinned **digests** everywhere (`sha256:…`, never tags): runtime binaries, guest kernels, rootfs/images, the toolchain mount (`/toolchain`, read-only: Node, npm, tsc). Built in CI from reviewed definitions; SBOM and vulnerability scan per build; images signed (e.g. cosign) and verified at node boot; a private registry and an npm registry **mirror** that the proxy allows; no `latest`; a rebuild cadence and an emergency-rebuild path. The attestation lists the digests (`runtime.imageDigests`); the service refuses an image that is not attested, and a node whose identity reports an unattested digest.

### 3.5 Secrets
None on the node except the agent's short-lived mTLS client credential. No platform secret, provider key, database URL, vault token or cloud credential ever reaches a sandbox (the environment is the 5-variable constant `EXEC_ENV`; `checkRunEnv`, `checkWorkspaceFiles`, `screenOutput`, canaries). The **attestation signing key belongs to the named human reviewer** and is never on the node, in the repository or in CI.

### 3.6 The node agent contract (to be implemented after D-21; the control plane already speaks it)
`WorkspaceRuntime` in `workspace-runtime.ts`: `identity`, `health`, `createWorkspace`, `putFiles`, `start(spec)`, `wait`, `stats`, `kill(soft|hard)`, `destroy`, `listProduced`, `readProduced(bounded)`, `destroyWorkspace`, `listWorkspaces`. Transport (proposal, not built): JSON over HTTPS with mutual TLS, idempotent calls keyed by workspace id, every call carrying the org and run id and rejected if they do not match the workspace, a request size cap, no redirects. **The agent re-validates every spec** (`validateRuntimeSpec`) and refuses anything weaker; the control plane never relies on the agent for policy, and the agent never trusts the control plane's spec without checking.

## 4. Recommended runtime and why

Decision owner: the owner, with a security review (D-21, HG-10-02). This is a recommendation.

1. **First qualification: gVisor (`runsc`, `systrap` platform) on one dedicated Linux staging node.**
   - It needs **no KVM and no nested virtualization**, so it is independent of the unresolved provider capability question (HG-05-04) and can start on any ordinary dedicated Linux VM or machine. That removes the largest unknown from the first real test.
   - Its boundary (a user-space kernel answering the guest's syscalls, a filtered set reaching the host) is materially stronger than a `runc` container and its escape surface is smaller and in a memory-safe language, at the cost of CPU/I-O overhead and syscall compatibility gaps (V) that the compatibility run measures.
   - The `ExecutionRuntime`/`WorkspaceRuntime` boundary means a later switch to a microVM changes the node agent, not the gateway, the policy, the attestation or the conformance suite.
2. **Production-target decision (D-21) after the first results:** a **Firecracker-class microVM per run** (or Kata with the Firecracker VMM if Kubernetes ergonomics are needed) on a **KVM-capable (bare-metal, or verified nested) dedicated pool**, if the reviewer judges hardware-virtualization isolation necessary for hostile multi-tenant code and the provider capability is confirmed. gVisor alone is accepted only if the reviewer records why its residual risk (shared host kernel behind the Sentry) is acceptable for the planned profiles.
   **Practical shortcut when the owner has no Linux infrastructure:** rent **one bare-metal dedicated server** (not a virtual machine). Bare metal has `/dev/kvm`, so the same box can be qualified for gVisor first and, after a rebuild from the image, for Firecracker, without any nested-virtualization question. Costs, sources and the exact node checklist: [approval inputs §6](sessions/PHASE2-04-approval-inputs.md).
3. **Never** `runc`-class for customer or model code. **Never** the developer Mac. **Never** a shared node.
4. Rollout order after all gates: only `typecheck` and `unit-tests` with network `none` for one allow-listed organization; then `build`; then the approval-gated network profiles (`install-deps`, `run-script`).

Cost drivers are formulas, not prices (see RUNTIME-EVALUATION): the owner supplies `N_peak`, node price, margin and currency. Qualification itself needs one dedicated node for a few days plus reviewer time.

## 5. Isolation test plan (what runs on the real node, and what must be true)

All tests below run **only on the attested-candidate staging node**, via the qualification runner, after the gates in section 8 have an owner approval reference. Expected result for every row: **all BLOCKED / PASS, zero ESCAPED**.

| # | Group | How | Expected |
|---|---|---|---|
| T1 | Escape suite 1.1.0, isolating attempts (65: namespaces/capabilities, mounted paths, runtime sockets, `/proc` and `/sys` leaks, kernel interfaces, metadata service, lateral movement, DNS exfiltration, proxy bypass, resource exhaustion, symlink/mount, lifecycle scripts, environment) | `escape-runner.cli.ts --mode qualify` sends each payload through `EndpointSandboxRuntime` with the hardened spec | every attempt fails inside the sandbox; no canary read; report sha256 recorded |
| T2 | Escape suite control-plane attempts (212: 206 run in the runner, 6 database-backed WS-* ticket cases via `sandbox.int.spec.ts`) | same run, in the control plane | all BLOCKED (212) |
| T3 | Conformance fixtures (22) with the real files | the conformance runner with a live target (same assertions as today's simulated run) | every fixture meets its expectation; no workspace or process left behind |
| T4 | Resource limits | `FX-CPU-SPIN`, `FX-MEMORY-BALLOON`, `FX-PID-SPAWNER`, `FX-DISK-FILLER`, `FX-OUTPUT-FLOOD` | killed or failed at the limit (wall 180 s, memory 1 GiB, pids 128, disk 512 MiB, output 256 KiB), the node and its neighbours unaffected, accounting recorded |
| T5 | Network | `FX-NETWORK-PROBE` under class `none`; an approved `install-deps` under `registry-only` plus the proxy allow/deny matrix (allowed mirror, every blocked class, redirect to a private address, DNS rebinding, IPv6 forms) | no connection except the allow-listed mirror through the proxy |
| T6 | Tenant isolation / noisy neighbour | two organizations' runs concurrently on one node; each tries to see the other's files, processes, `/proc`, network and timing | nothing visible; fair scheduling; one org's exhaustion does not starve the other beyond the documented quota |
| T7 | Kill paths | soft kill, hard kill, abort during start/run/artifact read, agent killed mid-run, node reboot mid-run | process group and VM gone, workspace destroyed or reaped by `reapOrphans`, status `terminated`, no leaked mount/namespace/device |
| T8 | Cleanup leaks | after T1–T7: processes, mounts, namespaces, tap devices, cgroups, files, disk | nothing remains; `listWorkspaces` empty |
| T9 | Attestation negative tests | service start with: no attestation, expired, wrong node, wrong endpoint, tampered, simulated-label, unattested image, revoked | every start refused with the documented reason |
| T10 | Supply chain | image digests on the node equal the attested ones; unsigned image refused at boot | refused/equal |
| T11 | Performance / SLO | start latency, per-run overhead, throughput at `N_peak` | within the SLOs the owner accepted (D-30 proposals) (V) |
| T12 | Compatibility | real sample projects through all five profiles | each profile works or its incompatibility is recorded with a decision |

Pass bar (restated from AC-AG-12): T1–T10 pass with zero ESCAPED; T11–T12 recorded; two independent runs on a rebuilt node.

## 6. Evidence to record (never secrets; never customer data)

Stored under `docs/security/sandbox/evidence/<node-id>/<yyyy-mm-dd>/` (or the owner's evidence store), referenced from the attestation and the gate review:
1. **Node inventory**: provider and instance type (no account ids), region, kernel, distro, runtime and VMM versions, image digests, cgroup/disk-quota configuration, firewall rules (hash and text), kernel parameters, agent version. Labelled `LIVE-VERIFIED` only if captured from the node by the reviewer.
2. **Qualification report** JSON from the runner and its sha256 (the value `evidence.escapeSuite.reportSha256` points at), plus the plain-text rendering.
3. **Conformance report** JSON and sha256.
4. Raw per-case logs, scrubbed (`screenOutput`), with canary values never printed.
5. Timing and capacity measurements (T11), compatibility matrix (T12).
6. The **signed attestation** (JSON), the reviewer's name and key id, the HG-10-02 review report reference, the D-21 decision reference.
7. Tool and runner versions, the git commit of the control plane and suite, the date/time (UTC), the approval reference that allowed the run.
8. Incident and deviation notes (anything unexpected, even if it passed).
Rules: evidence is append-only; a repeated run adds a new dated directory; an attestation expires (≤ 30 days in the runner's draft, ≤ 90 accepted by the verifier) and is renewed only by a fresh qualification; any kernel/runtime/image/config change invalidates it.

## 7. SIMULATED today versus what would become LIVE-VERIFIED

| Component | Today | Becomes LIVE-VERIFIED when |
|---|---|---|
| Policy, quota, queue, approvals, audit, kill switch | `SIMULATED` on the mock (control-plane logic, verified by unit tests) | exercised end to end through a live node with the gate opened in staging |
| Attestation verifier (fail-closed) | offline-verified with a throw-away key | a real reviewer key signs a real node's attestation and the service starts on it |
| Real-runtime service, workspace, limits, kill, cleanup, artifacts | offline-verified against a stand-in node | T3, T4, T7, T8 on a real node |
| Dependency policy | offline-verified on synthetic lockfiles | T5 with the real proxy and registry mirror |
| Conformance suite | SIMULATED (mock: partial, SKIPPED layers; simulated node: all layers) | the live target runs the same fixtures with real files (T3) |
| Escape suite isolating attempts (65) | `NOT_VERIFIED` everywhere | T1 on the node, reviewed by a named human (HG-10-02) |
| Network segmentation, egress proxy from inside a sandbox | `NOT_VERIFIED` (control-plane egress policy verified offline) | T5 |
| Resource enforcement by cgroups/VMM | `NOT_VERIFIED` (monitor logic verified offline) | T4 |
| Image supply chain | not started | T10 |
| Performance, cost per run | not measured | T11 |

## 8. Gates and their order

| Gate | What it is | Unlocks | Blocks |
|---|---|---|---|
| **D-21** | the isolation technology (and the node pool and its budget) | provisioning a staging node; implementing the node agent | any real execution |
| **HG-05-04 / compute provider** | a Linux provider/account, quota, spend cap; KVM capability probe for microVM classes | a node to exist | everything live |
| **HG-10-02** | the named security reviewer's review of the node, the suite results and the attestation | a LIVE-VERIFIED attestation; `runtimeVerified` and `escapeSuitePassed` in the gate | opening the gate |
| **Execution Gateway ADR acceptance** (numbered ADR-067 on this line; the hosting line also uses that number: the Master will renumber ours, ADR-068, when the lines are joined; nothing here was renamed) | the owner accepts the design | `adrAccepted` in the gate | opening the gate |
| **LEGAL-EXEC** | terms and liability for executing customer code | customer-facing use | production; arguably also any customer-visible staging |
| **D-AG-ROLLOUT (production rollout)** | the production go decision (formerly mislabelled D-42, an id `docs/07` gives to the platform object store; resolved by the Master 2026-11-24) | `rolloutDecided` in `ExecGateState` | production only |
| Owner approval to run staging qualification | a recorded reference the runner checks (`HG-10-02-…` or `D-21-…`, and `NUZM_QUALIFICATION_APPROVED` set to it) | the live runner modes | live tests |

Sequence: D-21 + compute provider → node provisioned and hardened (owner/ops) → node agent built and installed → **qualify** (runner, T1–T12) → reviewer signs the attestation (HG-10-02) → ADR acceptance and `executionGate` inputs recorded → staging service starts (`live` mode, fail-closed) → owner approval for execution in staging (flag `ai.agent.exec_tools`, one org, `typecheck`/`unit-tests`/`none` network) → soak → LEGAL-EXEC and the production decision before any customer.

## 9. Operational runbook outline (full text to be written with the real node)

1. **Provision**: build the node from the pinned image; apply the host baseline (section 3.1); install runtime and agent by digest; run the inventory script; store the evidence.
2. **Qualify**: obtain the approval reference; set `NUZM_QUALIFICATION_APPROVED`; run the runner (`--mode qualify`); on all-PASS hand the report and the draft attestation to the reviewer.
3. **Attest**: the reviewer completes the draft (review reference, reviewer, decision date, D-21 reference), changes the label, signs with their own key; the public key id is added to the control plane's trusted set (a configuration change under change control).
4. **Start**: deploy the service in `live` mode; it refuses to start if anything above is missing or stale; `status()` shows attestation expiry per node.
5. **Operate**: alerts on node quarantine, cleanup failure, unresponsive node, canary alert, attestation expiring in < 7 days, capacity, kill-switch state; `reapOrphans` on every control-plane start and on a timer; per-run accounting into metering (`ai.sandbox_cpu_seconds`); content-free events into the audit log.
6. **Renew / re-qualify**: before expiry, and on any kernel/runtime/image/config change, incident, or suite version change (`--mode requalify` verifies the existing attestation first).
7. **Incident** (canary read, escape suspected, unresponsive node): engage the organization kill switch (the orchestrator already does this on a canary), `emergencyStop` (`terminate()` plan: revoke approvals, drain the queue, soft then hard kill, destroy workspaces), `quarantine(node)`, revoke the attestation (`revoke(id)` and the control plane's revocation list), preserve the node's disk and logs for the reviewer, **rebuild the node from the image; never reuse it**, review before re-admission.
8. **Retire**: drain, wipe, deprovision, keep the evidence.

## 10. Rollback and emergency stop

| Need | Action | Available today |
|---|---|---|
| Stop all agent execution immediately | global kill switch / flag `ai.agent.exec_tools` off; the gate closes; the orchestrator refuses at submit and before each run | yes (SIMULATED) |
| Stop one organization | per-organization kill switch (`ExecutionKillSwitch`) | yes (SIMULATED) |
| Terminate running work | `terminate({kind:'all'|'org'|'run'}, ports)` with `RealRuntimeService.terminationPorts()` | yes (SIMULATED) |
| Take a node out | `quarantine(nodeId)`; attestation revoke; the service drops a node whose attestation expires or is revoked at the next use | yes (SIMULATED) |
| Remove leftovers | `reapOrphans()` | yes (SIMULATED) |
| Roll back the capability | flag off, remove the node from the pool, revert the trusted-keys configuration; no data migration is involved because the durable stores are not created before D-21 | yes |
| Roll back a bad runtime/image | re-qualify the previous pinned digests on a rebuilt node; attestations are per digest set | process only |

## 11. What remains (and who must act)

| Item | Class | Notes |
|---|---|---|
| Choose D-21 technology, provider and budget; HG-05-04 | OWNER-BLOCKED / EXTERNAL-BLOCKED | section 8 |
| Provision and harden the Linux node | EXTERNAL-BLOCKED | section 3 |
| Node agent (implements `WorkspaceRuntime`, validates specs) and the HTTPS/mTLS node client | DEPENDENT on D-21 | contract and conformance suite are ready |
| Durable stores for jobs, workspaces, approvals, node registry, usage | DEPENDENT on D-21 | design only: [DURABLE-STORES-DESIGN](../security/sandbox/DURABLE-STORES-DESIGN.md); no migration created (ids 2140–2159 unused) |
| Run T1–T12, sign the attestation | SECURITY-BLOCKED (HG-10-02) | runner and plan ready |
| Package script for the runner (`sandbox:escape-suite`) | needs a `package.json` change | [CONTRACT-04-3](sessions/CONTRACT-04-3-qualification-runner-script.md) |
| Real alert/metric wiring, runbook exercise on a real runner | DEPENDENT on the node | |
| LEGAL-EXEC; production decision (needs its own id) | OWNER-BLOCKED | |

## 12. Limitations (honest)
- Nothing here has touched a real runtime, a real node or a real provider. Every green result is a statement about control-plane logic against a stand-in.
- The attestation proves a *review happened*, not that the node is secure; a reviewer who signs without running the plan defeats it. Independent rerun and key custody are the controls.
- The runner's live modes cannot run until a node client exists; this is deliberate.
- Time-of-check/time-of-use races inside the workspace (`confine.ts`) are bounded by the runtime's own isolation, not solved in the control plane.
- gVisor compatibility, microVM boot time and overhead figures are unknown until measured (V).
