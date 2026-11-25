# infra/runtime — the real runtime node: recipes and configuration (P3-S02)

Status: **reviewed artifacts, never executed.** Nothing in this directory has been run on any machine. The development Mac (macOS 13, no Linux, no KVM) can neither run nor test any of it; the unit tests in `packages/runtime-agent` cover the agent's code with a recording command runner and a simulated launcher only. Every claim about isolation, enforcement or egress is `NOT VERIFIED` until the escape suite runs on an attested node and the HG-10-02 reviewer signs (docs/parallel/RUNTIME-QUALIFICATION.md).

| Path                | What it is                                                                                                                                                       | Used by                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `rootfs/`           | recipe and script that build the read-only sandbox rootfs and the `/toolchain` mount from PINNED inputs, and compute the image digest the attestation lists      | build host (Linux), reviewer  |
| `mirror/`           | read-only npm registry mirror configuration (Verdaccio) the egress proxy fronts                                                                                  | node pool network             |
| `proxy/`            | egress proxy configuration (`nuzm-egress-proxy`)                                                                                                                 | `registry-only` network class |
| `agent/`            | `agent.example.json`: the node agent's configuration skeleton (paths and PUBLIC keys only)                                                                       | operator                      |
| `nftables/`         | the STATIC default-deny firewall for the node (no per-sandbox rules)                                                                                             | bootstrap                     |
| `systemd/`          | units: node agent, egress proxy, proxy address                                                                                                                   | bootstrap                     |
| `alerts/`           | Prometheus alert rules for the real runner (kill switch, stuck jobs, quota breach, cleanup, attestation expiry) + `docs/security/sandbox/RUNBOOK-REAL-RUNNER.md` | operations                    |
| `profiles/android/` | the Android build environment definition for P3-S06 (SDK, Gradle, offline mirror)                                                                                | P3-S06                        |
| `install-agent.sh`  | plan-first installer of the agent, proxy and units on the node (after the reviewed bootstrap)                                                                    | operator                      |

Rules (unchanged from the Phase 2 bootstrap): only a dedicated, disposable, non-production Linux node the owner provides; `--plan` first; the reviewer signs off the exact commit; every `(V)` line is verified against the pinned release; a checksum mismatch is a supply-chain incident.
