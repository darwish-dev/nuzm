# Runbook: mobile builds, signing credentials and release preparation (M10B) — DRAFT

Status: written for M10B; **no step in the signing, iOS or store sections can be performed today**: they wait for HG-10-01 (Apple Developer / Google Play accounts, owner-authorized signing material, macOS capacity), D-21 (sandbox technology), D-22 (macOS capacity). The runbook says what an operator will do once they are granted and what the platform refuses to do meanwhile.

## 1. What exists
- `mobile_builder.enabled` (default OFF) gates all `/v1/mobile/*` routes and mobile project creation.
- Local development runner (`MOBILE_BUILD_RUNNER=local-android`, never in production): builds an **unsigned debug APK** on the API host. The build record states `isolation: none`; it is never isolation evidence. Requires the pinned Flutter (3.35.7 / Dart 3.9.2), a JDK 17 and the Android SDK with accepted licences (accepting licences is a human step: `flutter doctor --android-licenses`).
- Production default: no runner (503 `build_runner_unavailable`), no macOS capacity (503 `no_macos_capacity`), no signing stage (503 `signing_unavailable`).

## 2. Signing credentials (when HG-10-01 is granted)
1. An owner or admin registers a **vault reference** (`POST /v1/mobile/signing-credentials`): never the keystore, never a password. The API rejects key-like values with 422 `raw_secret_rejected` and does not echo them.
2. Material lives only in the vault (non-production vault for tests). The signing stage is a separate worker that project code cannot reach: it receives short-lived material at signing time, signs, discards it, and writes nothing to logs or artifacts. Build logs are line-redacted; `AC-M10-13` scans logs, artifacts and audit events for material (0 hits required).
3. Revocation: not available over HTTP until SCR-M10B-01 is approved; rotate or delete the material in the vault.
4. Every use of a credential must emit `signing.credential.used` (to be wired with the signing stage) and needs the "mobile signing use" approval of M10 §9 (NOT IMPLEMENTED: depends on the signing stage and the approvals inbox PA-M10-02).

## 3. iOS
macOS workers only (D-22). Until then iOS requests answer 503 `no_macos_capacity`. Nothing simulates an iOS build.

## 4. Release preparation
A release record prepares a store release. **Nuzm does not submit to any store, and no text in the product or in these documents may promise store approval or a way around review** (copy lint: `apps/api/src/modules/mobile/internal/releases/copy-lint.ts`, test `copy-lint.spec.ts`, AC-M10-14).
1. Draft: enter the listing text, privacy-policy URL (https), permission declarations that match the app's declared permissions, screenshots (references + sha256, 2+ per locale), compliance items (data safety, age rating, content rights, export compliance, in-app-purchase policy: `not_applicable` or an assessment reference). `missing` lists what is outstanding.
2. Prepared: needs every item and a **signed** build. 422 `release_checklist_incomplete` names the gaps.
3. Owner approval: the account owner approves the exact content (`scopeHash`); any change = a new record. No route yet (SCR-M10B-02).
4. Submission: a human step in the store console by the account owner. The platform has no submission action. The in-app-purchase / external-checkout policy assessment (AC-M10-17) must be approved by legal before any checkout flow is shipped in a generated app.

## 5. Retention (D-34 proposal)
Debug artifacts 30 days, release artifacts 12 months (`mobile.artifacts.retention_until`). A sweeper is not built yet (NOT VERIFIED): records show the date only.
