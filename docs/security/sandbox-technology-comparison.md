# D-21 sandbox technology comparison — preparation only (decision: owner)

General engineering knowledge, NOT live-verified against any vendor documentation or benchmark. The code is behind `SandboxRuntime`, so the choice changes one implementation.
| Option | Isolation | Cost / ops | Notes |
|---|---|---|---|
| Rootless containers (runc) + seccomp/AppArmor | shared kernel | lowest | weakest boundary for hostile code; acceptable only as defence in depth |
| gVisor (user-space kernel) | strong syscall mediation | moderate CPU overhead | needs compatibility testing with Node/tsc/npm |
| Firecracker microVM | hardware virtualisation per sandbox | needs KVM-capable nodes (bare metal or nested virt: provider capability to verify, HG-05-04) | best boundary; fast boot |
| Kata Containers | microVM behind container tooling | moderate | similar to Firecracker with OCI ergonomics |
Recommendation (non-binding): microVM class if the node pool supports KVM, otherwise gVisor; plus the egress proxy and network segmentation in all cases. Required either way: the escape suite green on the real runner, a security review (HG-10-02), node-pool quota (HG-05-04).
