# S49 — Build workers and signing (M10B)

Status words per CLAUDE.md §6. Branch `claude/m10b-flutter-97131d`.

## Implemented
- **Schema `mobile`** (migrations 1500–1502): `builds`, `artifacts` (immutable), `signing_credential_refs` (references only), `releases`; RLS forced, `data_region`, guards (no deletes, finished build cannot change), ownership/classification/residency entries (`vault_ref` = credentials/`vault_ref` protection).
- **Build API** `POST/GET /v1/mobile/builds`, `GET …/{id}`, `GET …/{id}/artifacts` (idempotent POST, 202): iOS → **503 `no_macos_capacity`**; `release` → **422 `signing_not_authorized`** (no owner/admin-authorized reference) or **503 `signing_unavailable`** (no signing stage); no worker → 503 `build_runner_unavailable`. Execution: atomic claim (3 parallel executions = 1 run), static gate re-run, residency evaluated before artifact storage, runner call, **lockfile verified before compiling**, artifacts stored with sha256 + `retention_until` (30 days debug / 12 months release: D-34 PROPOSAL), line-redacted log tail, `mobile.build_minutes` metered once (deterministic event id, dimension `platform`), audit `mobile.build.requested|finished`.
- **Runners**: `LocalAndroidRunner` (dev, `MOBILE_BUILD_RUNNER=local-android`, refused in production): **UNSIGNED, NOT ISOLATED** — every build record says `isolation: none`, `signed: false` and returns `notices`; a closed list of commands, minimal environment (no DB URL/token ever reaches the process), 20-minute timeout, pinned Flutter only; runs `flutter create --platforms=android`, applies the DECLARED permissions to the manifest, `pub get`, lock gate, `analyze`, `test`, `build apk --debug`. `UnavailableBuildRunner` (production default), `MockBuildRunner` (tests; labelled mock, never a build).
- **`POST/GET /v1/mobile/signing-credentials`**: body closed to `{platform,label,vaultRef,authorizedBy}`; key-like values, PEM blocks, tokens, unknown members → 422 `raw_secret_rejected` and are never echoed; `authorizedBy` must be the caller; owner/admin only; duplicate active label 409; DB: references immutable and never deleted; audit without the reference.
- **Signing stage port** (`SigningStagePort`): only `UnavailableSigningStage` exists in the module. Nothing signs.

## Real local evidence (Android debug, **unsigned, non-isolated, local machine; not CI**)
- Manual: `flutter build apk --debug` of the rendered template (after `flutter create --platforms=android`): **OK**, `app-debug.apk` **151,721,417 bytes**, sha256 `a0f7f5972377288e1ece9b7be8925e7aba7f49c1ce8aa6cb573d1dc4d570d1fe` (cold Gradle cache: 567 s), package `sa.nuzm.field_tasks`, `sdkVersion 24`, permission `INTERNET` only (aapt).
- Through `LocalAndroidRunner` (`flutter-local.int.spec.ts`, `MOBILE_FLUTTER_LOCAL=1`, 2 PASS): pinned Flutter check, lockfile passes the pub policy (≥20, ≤200 packages), APK is a zip containing `AndroidManifest.xml`, `signed: false`, toolchain recorded `runner: local-android, isolation: none`.
- The Android licences were not accepted by this session (a human step); the build succeeded with the SDK components already installed.

## Tests (`mobile.int.spec.ts`, 20 PASS; `runner.spec.ts`)
Build lifecycle with the mock runner (labelled), idempotency, checksum equals sha256 of the stored bytes, metering event equals minutes billed, iOS 503 with no row created, release 422/503 matrix, viewer 403, org B 404 on project/build/artifacts/list, payload validation, failed build recorded and still metered, supply-chain gate stops a git-sourced lockfile, **AC-M10-13 scan** (planted canaries, key-block lines, vault reference: log lines removed, `buildEnv` allow-list, audit events and stored artifact bytes clean), signing credential rules and DB guards.

## BLOCKED / NOT VERIFIED
- Android release signing (AC-M10-11): **BLOCKED (HG-10-01)**. iOS (AC-M10-12): **BLOCKED (D-22, HG-10-01)**. Signing happening in a worker unreachable by project code: **NOT VERIFIED** (no stage exists; the contract is the port + the tests above).
- Android workers in sandbox-class isolation: **BLOCKED (D-21)**. AC-M10-10 in CI: **NOT VERIFIED** (local evidence only).
- "Mobile signing use" approval (M10 §9) and `signing.credential.used`: not implemented (depends on the signing stage; PA-M10-02).
- Artifact storage with retention: bytes go to a dev directory (production: none, M08 bucket not connected); retention sweeper not built; no download route (SCR-M10B-04). Credential revocation route: SCR-M10B-01.
