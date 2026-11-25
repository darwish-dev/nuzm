# @nuzm/runtime-agent (P3-S02)

The node agent: runs on ONE dedicated, attested Linux node, speaks the node protocol (`packages/domain/src/ai/execution-gateway/node-protocol`) over mutual TLS plus a short-lived signed request token, and runs each workload in a gVisor (`runsc`, systrap) sandbox with a fixed argv and the constant environment.

**Nothing in this package executes anything on a developer machine.** The only code that can start a process is `NodeCommandRunner`, which refuses unless the platform is Linux, the node identity file matches the configured node, and the pinned `runsc` checksum matches (see `command-runner.ts`). Every test uses `RecordingCommandRunner` (records argv, runs nothing) and `SimulatedLauncher` (scripted output). Results from those are `SIMULATED` and prove the agent's protocol, validation, bookkeeping, confinement logic and command construction only. Isolation is `NOT VERIFIED` until the escape suite runs on the real node and the HG-10-02 reviewer signs.

Layout: `config` · `command-runner` · `fs-safe`/`workspace-store` · `oci` (bundle builder) · `network` (netns + nftables plan) · `launcher`/`runsc-launcher` · `node-runtime` (the `WorkspaceRuntime` implementation) · `http-handler`/`server` · `egress-proxy` · `main`.
