# Sandbox escape-attempt suite (versioned 1.0.0)

Catalogue and runner: `apps/api/src/modules/appbuilder/internal/sandbox/escape-suite.ts` (≥ 60 attempts, 13 categories, each with its expected control); executed by `sandbox.int.spec.ts`. 
- `control-plane` attempts (egress/proxy bypass, metadata, lateral reach, DNS exfiltration, path traversal via the changes API, secret/canary smuggling, WS-ticket reuse) run for real on any runtime: real evidence for those controls.
- `isolating-runtime` attempts (namespaces, capabilities, mounts, runtime sockets, /proc, /sys, kernel interfaces, resource exhaustion, canary reads) run ONLY against a runtime with `isolation = verified`. On the mock and the local dev runner they report **NOT VERIFIED**: a mock cannot be attacked, so it cannot pass. No real runner exists (D-21 OPEN): AC-M10-02 and AC-M10-03 stay BLOCKED. Re-run in CI against the real runner and in M12.
