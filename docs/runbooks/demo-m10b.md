# Demo script — mobile debug build (M10B), local development only

Status: NOT EXECUTED end to end as a script in the M10B session (its pieces are covered by the integration tests and the local Flutter evidence); treat it as a guide. Everything below runs on a developer machine. The result is an **unsigned, non-isolated debug APK**: it is not isolation evidence, not CI evidence and not a release.

Prerequisites: Flutter 3.35.7 / Dart 3.9.2, JDK 17, Android SDK with licences accepted by a human (`flutter doctor --android-licenses`), network access to pub.dev, the local services (`pnpm services:start`, `pnpm db:migrate`).

1. Start the stack with the mobile builder on and the local runner: `MOBILE_BUILD_RUNNER=local-android AI_LOCAL_REFERENCE=true pnpm --filter @nuzm/api dev:stack`; turn the flags `ai.enabled` and `mobile_builder.enabled` on for the demo organization (`platform.feature_flags`).
2. Create a project: `POST /v1/builder/projects {"type":"mobile","name":"Field Tasks"}`.
3. Generate: `POST /v1/ai/runs {"kind":"mobile","projectId":…,"sessionId":…,"input":{"description":"…"}}`. With the dev reference model the answer is a scripted fixture (model quality is NOT VERIFIED). The run stops at a `plan` approval: read the screens and permissions, approve.
4. Read the files: `GET /v1/builder/projects/{id}/files` (Flutter source, `tool/nuzm-mobile.json` with the declared permissions).
5. Build: `POST /v1/mobile/builds {"projectId":…,"platform":"android","profile":"debug"}` → 202; poll `GET /v1/mobile/builds/{id}` until `succeeded`; `GET …/artifacts` shows the APK sha256. Read the `notices` (unsigned, not isolated).
6. Try the blocked paths to see the honest answers: `platform: ios` → 503 `no_macos_capacity`; `profile: release` → 422 `signing_not_authorized`, or 503 `signing_unavailable` after registering a credential reference.
7. Prepare a release record (`POST /v1/mobile/releases`, status `draft`): `missing` lists what a prepared record still needs. Nobody can submit anything to a store from Nuzm.

Without the dev runner (the production default) steps 5–6 answer 503 `build_runner_unavailable`.
