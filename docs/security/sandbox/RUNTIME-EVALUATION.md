# Runtime evaluation (D-21): gVisor, Firecracker, Kata, hardened containers

Status: **evaluation, not a decision.** General engineering knowledge of these technologies as of the assistant's knowledge; **NOT live-verified** against vendor documentation, benchmarks or any Nuzm node. Every claim marked (V) must be verified on the real runner before the owner relies on it. The control plane already talks only to the `SandboxRuntime` / `ExecutionRuntime` interfaces, so the choice changes one implementation, not the gateway.

## What the runtime must do (from ADR-069 and the threat model)
Run one fixed argv (from a closed profile catalogue) for one run of one organization, with a constant environment, a read-only root file system, one writable scratch with a disk quota, no secrets, no route to the control plane or to other tenants, only the egress proxy as an exit (and only for `registry-only`), hard CPU / wall / memory / pids / output / disk limits, and complete teardown afterwards. Hostile code is the threat model: the generated or user-edited project and a prompt-injected model.

## Candidates
| | Hardened container (runc, rootless, seccomp, AppArmor/SELinux) | gVisor (`runsc`) | Firecracker microVM | Kata Containers |
|---|---|---|---|---|
| Boundary | the host kernel's namespaces and cgroups; the whole Linux syscall surface is reachable | a user-space kernel (the Sentry) answers the guest's syscalls; the host sees a small, filtered syscall set | hardware virtualization (KVM) with a minimal virtual device model; a guest kernel per run | a lightweight VM per pod/container (QEMU, Cloud Hypervisor or Firecracker as the VMM) behind OCI/Kubernetes tooling |
| Main escape surface | kernel bugs reachable through any allowed syscall (large surface) | Sentry bugs, then the host seccomp filter and the Gofer file proxy (small, memory-safe language) | VMM device emulation, KVM and the CPU itself (side channels) | the VMM chosen, KVM, and the Kata agent/shim |
| Needs | nothing special | no KVM required for the default platform; compatibility testing (V) | KVM: bare metal or nested virtualization (provider capability: **HG-05-04**, V) | KVM, plus a guest kernel and image management |
| Compatibility with `tsc`, `npm`, `node`, test runners | full | usually good, but some syscalls and `/proc` behaviours differ; must be run against the real profiles (V) | full guest Linux | full guest Linux |
| Start time and overhead | lowest | low start, higher cost on syscall- and file-heavy work (V) | fast boot, small per-VM memory overhead (V) | higher than Firecracker alone (V) |
| Operational fit | simplest | OCI runtime: drops into container hosts and Kubernetes `RuntimeClass` | needs its own orchestration (jailer, images, a guest agent over vsock) or Kata on top | Kubernetes-native; more moving parts |
| File sharing | bind mounts | Gofer-mediated mounts | block devices (no host directory sharing): the workspace is shipped as an image or over vsock | virtio-fs or 9p with the QEMU/Cloud Hypervisor VMM |
| Fit for hostile code | **not sufficient alone** (shared kernel); defence in depth only, and the local/dev option | acceptable with dedicated nodes, if the compatibility and syscall-filter review pass | strongest boundary of the four if KVM is available | strong; choose when Kubernetes ergonomics matter |

`runc` is deliberately **not** in the acceptable list of `validateRuntimeSpec` (`ACCEPTABLE_RUNTIME_CLASSES`): a shared-kernel container is not accepted for customer-supplied code, whatever else is configured around it.

## Dedicated nodes (all candidates)
Whichever runtime is chosen, run it on a **dedicated, tainted node pool** that hosts nothing else, with: no cloud credentials on the node and the instance-metadata address unreachable from sandboxes; no route from the sandbox network to the control-plane database, queue or admin consoles; nodes recycled on a schedule and after an incident (a node that ran hostile code is never trusted again); host SMT/hyper-threading and co-residency policy decided with the reviewer for the microVM options (cross-tenant CPU side channels, V); one sandbox per run and never reused across runs or organizations. A microVM or a gVisor sandbox sharing a node with the control plane would defeat the point of either.

## Cost drivers (formulas, not prices: no price is stated or invented)
Let `N_peak` be the peak concurrent runs the owner wants, `c` and `m` the per-run CPU and memory reservation (profile limits: 1 CPU-equivalent, 1–2 GB), `C_node`/`M_node` a node's capacity, `P_node` the owner's price per node-hour, `h` hours in the period.
- Nodes ≈ ceil( max( N_peak·c / (C_node·u), N_peak·m / (M_node·u) ) ) + spares, with `u` the target utilisation after the runtime's overhead (gVisor: a CPU and I/O overhead factor, V; microVM: a per-VM memory overhead, V) and spares for recycling and the unhealthy-node case.
- Compute cost ≈ Nodes · P_node · h, plus the egress proxy and mirror, image/snapshot storage, log retention (D-34) and the operating effort of the chosen runtime (a microVM stack carries the highest).
- Cost per run (for the `ai.sandbox_cpu_seconds` metering and the rate card, D6-style): `rate = (Compute cost + fixed costs) / (total billable CPU-seconds · utilisation)`; the gateway already settles quota in CPU-seconds and integer minor units (`QuotaLedger`, `estimateCostMinor`) and refuses to admit while the budget is 0.
The owner decides `N_peak`, `P_node`, margin and currency; the platform supplies the formulas and the admission/ceiling machinery.

## What must be verified (summary; full plan in VERIFICATION-PLAN.md)
Per runtime: compatibility with every profile (`typecheck`, `unit-tests`, `build`, `run-script`, `install-deps`) on real projects; the escape suite's isolating attempts (XR-* and the base IS/NS/MP/RS/PS/KI/MS/LM/RX/CA families) all BLOCKED on the real runner by a named reviewer; resource limits enforced by cgroups or the VMM (memory, pids, disk, CPU, output); network segmentation and the egress proxy from inside the sandbox; teardown leaves nothing (processes, mounts, files, namespaces); startup and overhead figures against the SLOs; the provider's KVM/nested-virtualization capability (HG-05-04) for the microVM options; seccomp/syscall-filter review; patching and image supply chain.

## Recommendation (non-binding; the owner decides D-21)
1. If a KVM-capable node pool (bare metal, or nested virtualization verified by a probe against the provider) is available in the required region: a **Firecracker-class microVM per run** (Kata Containers with the Firecracker VMM if Kubernetes `RuntimeClass` ergonomics are needed) on a dedicated node pool.
2. If KVM is not available: **gVisor (`runsc`) on a dedicated node pool**, with the compatibility run and syscall-filter review as entry criteria and the egress proxy and network segmentation unchanged.
3. Never plain `runc`/Docker for customer-supplied code; rootless containers stay a developer convenience behind the non-production `local-dev` runner, which the execution port refuses.
4. First rollout, after the gates: only `typecheck` and `unit-tests`, network `none`, one organization on an allow-list, then `build`, then the approval-gated network profiles.
