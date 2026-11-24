# Android build environment (disposable) — T3, B-Android, B-SIGN

Status: **DEFINITION + GUARD + SCRIPTS; no disposable environment exists yet (B-Android approval pending).** Nothing here has built an AI-generated project. The pre-approval work uses the first-party template only.

## What "disposable environment" means

A build runs generated project code and native build scripts. It must run **only** inside an environment that (1) was created for builds, (2) holds no host secret or personal file, (3) reaches only the registry mirror, (4) can be destroyed. The engine enforces what it can observe (`internal/builds/build-env-guard.ts`, unit-tested) and **refuses with `build_env_refused` before any file is written** otherwise:

| Check                                                                                                                                                                       | Refuses when                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| declaration                                                                                                                                                                 | `NUZM_BUILD_ENV` ≠ `disposable`, or `NUZM_BUILD_ISOLATION` not `container`/`vm`/`dedicated-user`, or `NUZM_BUILD_USER` ≠ current user                                                    |
| owner account                                                                                                                                                               | current user equals `NUZM_OWNER_USER`                                                                                                                                                    |
| dedicated user                                                                                                                                                              | user not named `nuzm-build*`                                                                                                                                                             |
| secrets                                                                                                                                                                     | any secret-looking variable name is present (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `DATABASE_URL`, `AWS_*`, `GITHUB_*`, `ANTHROPIC_*`, `SSH_AUTH_SOCK`, …); reported by NAME, never value |
| personal home                                                                                                                                                               | `~/.ssh`, `.aws`, `.config/gh`, `.netrc`, `.npmrc`, `.gnupg`, browser profiles, Mail/Messages exist                                                                                      |
| Not verifiable by the process (recorded as warnings in the build's toolchain record): network egress for a dedicated user, wipe between builds.                             |
| Selected with `MOBILE_BUILD_RUNNER=disposable-android` (never honoured in production). `isolation` is recorded `container`/`vm` only for those; a dedicated user is `none`. |

## Two realisations

|                 | A. container/VM (sandbox-class)                                                                                                                                        | B. dedicated macOS/Linux user                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| definition      | `Dockerfile` (RECIPE, NOT BUILT: no container runtime on the owner's Mac; every download needs a digest build-arg, licence acceptance is a build-arg set by the owner) | steps below                                                                               |
| who             | the Linux node of P3-S02 (D-21)                                                                                                                                        | the owner approves (B-Android: "start with the owner's Mac under a dedicated build user") |
| network         | only the mirror, enforced by the container network                                                                                                                     | not enforced (NOT VERIFIED)                                                               |
| isolation label | `container`/`vm`                                                                                                                                                       | `none`                                                                                    |

### B. Dedicated user on the owner's Mac (owner actions: admin password)

1. Create standard user `nuzm-build` (no Apple ID, no iCloud). 2. Install a JDK 17 (Temurin) and Flutter 3.35.7 **for that user** (copy or reinstall; the user must not read the owner's home). 3. Android SDK: either a copy of `~/Library/Android/sdk` into a location readable by `nuzm-build` (platforms 35/36, build-tools 35.0.0, cmdline-tools, platform-tools) or a fresh install per `toolchain.env`. **SDK licences are not all accepted on the owner's Mac (`flutter doctor`, 2026-11-24): accepting them is the owner's action** (`flutter doctor --android-licenses` as `nuzm-build`). 4. `export` in `nuzm-build`'s profile: `NUZM_BUILD_ENV=disposable NUZM_BUILD_ISOLATION=dedicated-user NUZM_BUILD_USER=nuzm-build JAVA_HOME ANDROID_HOME`. 5. Optional mirror: `PUB_HOSTED_URL`, `FLUTTER_STORAGE_BASE_URL`, `NUZM_MAVEN_MIRROR` and `gradle-init-mirror.gradle` copied to `~/.gradle/init.d/`. 6. Wipe between builds: remove `~/.gradle/caches` (unless the offline mirror serves them), `~/.pub-cache`, `~/.android/debug.keystore`.

## Offline mirror plan (NOT VERIFIED: no mirror exists)

Three registries, each redirected by one variable so the build reaches nothing else: **pub** (`PUB_HOSTED_URL` → a caching pub mirror pre-seeded with the allow-listed packages of `pub-policy.ts`, pinned versions only); **Maven/Gradle plugins** (`NUZM_MAVEN_MIRROR` + `gradle-init-mirror.gradle`, which removes every other Maven repository incl. Maven Central, Google and the plugin portal, so a plugin's own `repositories {}` cannot bypass it); **Flutter engine artifacts** (`FLUTTER_STORAGE_BASE_URL`). Gradle distributions come from the mirror through `distributionUrl` in the wrapper the pinned `flutter create` writes. The mirror is populated by a **connected, supervised warm-up run of the template project** (the first run records what it fetched); the lockfile gate (`evaluatePubLock`) already verifies the resolved `pubspec.lock` against the allow-list and host before anything compiles.

## Pipeline (inside the environment; implemented by `DisposableAndroidRunner`)

`flutter --version` (must be 3.35.7) → write sources (path-escape refused) → `flutter create --platforms=android` → declared permissions + bounded `android.minSdk/compileSdk` + platform policy check (cleartext, undeclared permissions) → `flutter pub get` → lockfile gate → `flutter analyze` → `flutter test` → `flutter build apk --debug` → SHA-256 + structural inspection (`apk-evidence.ts`). Every failing stage returns structured errors (`internal/builds/errors/`) to the repair loop (P3-S03). After the build: `verify-apk.sh` (apkanalyzer manifest/permissions, apksigner, optional emulator install+launch+screenshot).

## Signing (B-SIGN)

Debug builds are signed by the Android Gradle plugin's throwaway **debug keystore** in the build user's `~/.android/` (not a release signature; recorded as such). For a "test-signed" artifact: `test-sign.sh in.apk out.apk` generates a 30-day throwaway keystore for that one run, signs, verifies, prints only the certificate SHA-256, and destroys the keystore and password. It has **no** option to pass an existing keystore, alias or password. A production or store key, a Play account or any store upload is out of scope and never touched (the existing signing service stays reference-only).

## Emulator evidence

Needs a system image (`ANDROID_EMULATOR_IMAGE` in `toolchain.env`); **none is installed** on the owner's Mac (`~/Library/Android/sdk` has the emulator binary but no `system-images`). Installing one is a licence-accepting download (owner action). Until then `verify-apk.sh` reports `structural check only: NOT claimed installable`, which is the acceptance fallback (`apkanalyzer` structural check).
