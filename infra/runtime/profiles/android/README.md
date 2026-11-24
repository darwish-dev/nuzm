# Android build environment (P3-S02 → P3-S06 hand-off)

**Status: definition and plan. Nothing was built or run; the file `android-build-env.json` deliberately fails `validateAndroidBuildEnv` until the reviewer fills the pinned digests and a named human accepts the Android SDK licence.** No untrusted or generated code ran on the machine that wrote this.

## What P3-S06 gets

| Item                             | Where                                                                                                                                  | Notes                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The definition and its validator | `android-build-env.json`, `executionGateway.validateAndroidBuildEnv` (`packages/domain/src/ai/execution-gateway/build-env/android.ts`) | S06's orchestrator must refuse to build with an environment that does not validate; the validator is the contract    |
| The only commands                | `executionGateway.ANDROID_ALLOWED_COMMANDS`                                                                                            | fixed argv, no shell: `flutter pub get --offline`, `analyze`, `test`, `build apk --debug/--release` (all `--no-pub`) |
| The isolation model              | the same gVisor sandbox as the Node profiles (`docs/security/sandbox/RECOMMENDED-ARCHITECTURE.md`)                                     | larger limits (4 CPU, 6 GiB, 12 GiB disk, 25 min), `mirror-only` network, read-only rootfs and caches                |
| The build recipe                 | `build-android-env.sh` (plan-first, never executed)                                                                                    | pinned JDK, SDK cmdline-tools, Flutter, Gradle; licence acceptance is a named human's act                            |
| Signing                          | debug/test keystore generated **inside** each run (`keystoreOrigin: generated-in-environment`)                                         | a production key, a store credential or an Apple/Google account is never reachable (`productionKeysAllowed: false`)  |
| Outputs                          | `outputs.roots` + `.apk` only, regular files, sha256, size cap                                                                         | a keystore or key file as an output is refused by the validator and by the artifact policy                           |

## What S06 must still do (not done here)

1. **A gateway profile.** The execution gateway's catalogue is closed (`EXEC_PROFILES`: typecheck, unit-tests, build, run-script, install-deps). Android runs need new profile ids with the Android limits and the `mirror-only` class; that touches `policy.ts`, `runtime-spec.ts` (a third network class) and the node agent's ceilings. Request: `docs/phase3/sessions/CONTRACT-P3-S02-1-android-profile.md` (to the Master); S02 implements the policy and agent side once S06 states the exact commands.
2. **The offline mirror.** Gradle/Maven/pub content for the pinned template dependencies, populated on a build host with network, then served read-only (see `../../mirror/`). Which hosts remain reachable at run time is decided with the mirror.
3. **The compatibility run.** Gradle, the JVM and the Android build tools in gVisor are untested (V): the first node run measures them (T12 of the qualification plan). If gVisor cannot run them, the fallback is a Firecracker-class microVM profile (D-21), not a weaker sandbox.
4. **Install/launch evidence.** Emulator launch needs KVM; plan it on a separate bare-metal host (B-Android) or settle for `apkanalyzer` structural evidence and say so (`NOT VERIFIED` for the launch).

## Limits that are facts about this machine, not about the design

The Mac this was written on has Flutter 3.35.7, a JDK and an Android SDK installed, but those are the _owner's_ host toolchain: they are not this environment and must never be used for generated code (CLAUDE.md §5, P3-S06 scope). An Android build executed on the Mac is outside this design.
