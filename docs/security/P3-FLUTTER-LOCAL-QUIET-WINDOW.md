# Plan: the two Flutter local tests in a quiet window (P3-S08)

Status: PLAN. **Nothing was started.** The Master announces the window; I do not start these tests while a full regression, another heavy run or another session's build holds `/private/tmp/nuzm-heavy.lock`.

## What the tests are
`apps/api/src/modules/mobile/flutter-local.int.spec.ts` (gated by `MOBILE_FLUTTER_LOCAL=1`): (1) the rendered Flutter template passes `flutter pub get`, `flutter analyze`, `flutter test`; (2) the Android runner builds an unsigned debug APK and the resolved `pubspec.lock` passes the pub policy. Reproducible wrapper (P3-S06): `infra/mobile/android/run-flutter-local-tests.sh [evidence-dir]` (takes the heavy lock itself, refuses to start if it is held, exit 4). Cost: about 6 minutes on a quiet machine (M10B measured 345 s), 15-25 minutes under load; needs pub.dev and Maven network and about 3 GB of disk. It executes **first-party template code only** (no AI-generated code) on the owner's Mac: label it exactly that.

## Preflight finding (read-only, 2026-11-24, `docs/phase3/validate/A-build-host.sh`): the tests cannot pass on this Mac today
| Prerequisite the wrapper needs | State on the owner's Mac | Consequence |
|---|---|---|
| a JDK 17 (`JAVA_HOME` or `flutter config --jdk-dir`) | **FAIL: `java -version` answers "Unable to locate a Java Runtime"** (`/usr/bin/java` is only the macOS stub; the Master's checklist table says "Java present": it is not) | the wrapper exits 2 ("no JDK") |
| Android SDK licences accepted | `flutter doctor` says "Some Android licenses not accepted" (confirmed 2026-11-24); the wrapper prints a NOTE and the build fails with `gradle_licence_not_accepted` until the owner accepts (B-Android) | the APK test fails |
| Flutter at the pinned version (`infra/mobile/android/toolchain.env`) | Flutter 3.35.7 on an unnamed `user-branch` channel; the pin is checked by exact version | to be compared with the pin by the wrapper |
| B-Android approval recorded | not recorded | per CLAUDE.md the generated-code build stays refused; this template-only run does not need it, but the owner must know the Mac is the runner |
The owner action is therefore: install a JDK 17 (and accept the Android licences yourself) **before** the window. `docs/phase3/validate/A-build-host.sh` re-checks both read-only (A7, A9); the Master's checklist table should be corrected for Java.

## Window protocol
1. Master announces the window (nothing else heavy: no full regression, no E2E, no benchmark, no other session building). I confirm with `ls /private/tmp/nuzm-heavy.lock` (must not exist) and `pgrep -fl 'vitest|gradle|flutter|xcodebuild'` (nothing but this session's tools).
2. Run `docs/phase3/validate/A-build-host.sh` (read-only). Any FAIL that the wrapper needs (A5 Flutter, A7 Java, A8 SDK, A9 licences) -> do not start; report the missing item.
3. `infra/mobile/android/run-flutter-local-tests.sh docs/phase3/EVIDENCE/mobile` is the ONLY command (it takes and releases the lock). Wall-clock budget 30 minutes; if it exceeds that, stop it with Ctrl-C (the trap releases the lock) and report.
4. Record: exit code, the log hash, toolchain versions, the APK hash (`ANDROID-DEBUG apk=` line), the commit hash and the machine load at start. Convert the wrapper's JSON into a canonical record (`track: mobile`, `platform: android`, component origin `real`, **identity host = the owner's Mac, build environment "local, template project, not isolated"**) and verify it with `evidence/cli.ts verify`. It counts for the rows T3.android only if P3-S06 and the owner accept a local template build as the T3 build environment; otherwise it is recorded as a toolchain check that is NOT a T3 row (the acceptance wording of T3 is "generated app in the isolated Android environment").
5. Never: sign, upload, install a system image, accept a licence, change the Mac's configuration. A failure is recorded as FAIL with the log, not retried until green.

## Label note for P3-S06
The wrapper writes `"label": "LIVE-VERIFIED (template project, owner's Mac, labelled local, NOT isolated)"`. A label that is LIVE-VERIFIED and "NOT isolated" in one string is the kind of mixed wording the evidence verifier exists to prevent: the canonical record must state the real fact (host identity, local runner, first-party template, no generated code) in `identity` and `components`, and the claim must be limited to what ran (template analyze/test/debug APK), not "isolated Android build".
