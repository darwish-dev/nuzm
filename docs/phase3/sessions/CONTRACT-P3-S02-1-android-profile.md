# CONTRACT-P3-S02-1 — Android build profile for the execution gateway (request to the Master, from P3-S02; for P3-S06)

Status: REQUEST. P3-S02 has delivered the Android build-environment DEFINITION and validator (`packages/domain/src/ai/execution-gateway/build-env/android.ts`, `infra/runtime/profiles/android/`). Running an Android build through the gateway needs changes P3-S02 owns (`policy.ts`, `runtime-spec.ts`, the node agent) but that depend on decisions only P3-S06 and the owner can make. Nothing is requested of shared files by this contract; it records what S02 will implement and what it needs first.

## Needs from P3-S06 (before S02 changes code)
1. The exact command list per profile (argv) and which directories hold outputs (`build/app/outputs/flutter-apk`).
2. Whether S06 wants one gateway profile per command (`android-analyze`, `android-test`, `android-build-debug`, `android-build-release`) or one `android-build` profile with a typed `mode` parameter. S02 recommends one profile per command (the gateway's catalogue is closed and every profile has fixed argv).
3. Which hosts the mirror will serve (the egress allow-list for the new network class).

## What S02 will implement after that (owned files only)
- `ExecProfile` entries with the Android limits (4 CPU-equivalents, 6 GiB, 12 GiB disk, 25 min wall) — `policy.ts`.
- A third network class `mirror-only` next to `none` and `registry-only` — `policy.ts`, `runtime-spec.ts` (`validateRuntimeSpec`), the agent (`oci.ts`, `network.ts`: same proxy path, different allow-list), `conformance`/fixtures.
- Agent ceilings and a second toolchain mount for the SDK/Gradle/pub caches (read-only) — `config.ts`, `oci.ts`.
- Artifact policy for `.apk` outputs (extension allow-list, hashing) — `artifacts.ts`.

## Shared-file changes this will eventually need from the Master
None for spec or SDK (the gateway is not an HTTP API). The `ExecutionOutcome`/`ExecRequest` contract is unchanged.
