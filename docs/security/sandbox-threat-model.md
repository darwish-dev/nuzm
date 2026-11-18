# Sandbox threat model (M10A S45) — DRAFT for HG-10-02

Asset: platform secrets, other tenants' code and data, the control-plane network. Adversary: the generated (or user-edited) application code, and a prompt-injected model. Trust boundary: the control plane never executes generated code; only a `SandboxRuntime` does.
| Threat | Control | Where | Evidence today |
|---|---|---|---|
| Kernel/namespace/capability escape | isolating runtime (D-21), non-root, default-deny seccomp, no capabilities, read-only root | runtime | NOT VERIFIED (no runtime) |
| Reaching control plane / other tenants / metadata | separate network segment; egress default-deny, exact-host allow-list, private/metadata ranges blocked, DNS pinned, redirects re-checked | `egress.ts` + runtime | control-plane part tested (68 unit cases + escape suite) |
| DNS / covert exfiltration | filtered DNS answers exact allow-listed names only | `egress.ts` | tested |
| Secret theft | no platform secrets in env; canary tokens in host env/paths; output scanned + redacted | `canary.ts`, `sandbox.service.ts` | tested (mock); real read detection NOT VERIFIED |
| Path traversal / symlink via the changes API or archive | `checkPath`, plumbing-only Git (no work tree), tar reader rejects links | `paths.ts`, `git.store.ts`, `archive.ts` | tested |
| Resource exhaustion | quotas 2 vCPU/4 GB/10 GB/512 PIDs, 5 concurrent per org, idle 30 min, max 4 h, build 20 min | `sandbox.service.ts` + runtime | service limits tested; runtime limits NOT VERIFIED |
| Supply chain | ecosystem allow-list, mandatory lockfile, scripts off, advisory scan, typosquat, licence, growth cap, SBOM | `dependencies.ts` | tested (advisory feed NOT connected) |
| Terminal hijack | single-use 60 s ticket bound to user+sandbox, stored hashed | `sandbox.service.ts` | tested; WS transport not built |
| Cross-tenant access | RLS forced on every M10 table; project/sandbox/deployment lookups by org | all | cross-tenant matrix over every endpoint |
Residual: everything in the `isolating-runtime` rows. The local dev runner is NOT isolated and never counts.
