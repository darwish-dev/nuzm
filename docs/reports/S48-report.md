# S48 — Flutter generation (M10B)

Status words per CLAUDE.md §6. Branch `claude/m10b-flutter-97131d` (cut from main `7d0d7b0`). Owner waiver of the M10A-first ordering: 2026-11-19 (see `M10B-report.md`).

## Pinned toolchain (recorded)
Flutter **3.35.7** (framework revision adc9010625, engine 035316565a), Dart **3.9.2**, DevTools 2.48.0 — the versions installed at `/usr/local/bin` and used for every run below. Template set `nuzm-flutter-core@1.0.0`; the constants live in `apps/api/src/modules/mobile/internal/flutter/toolchain.ts` and every generated `pubspec.yaml` carries `sdk: ">=3.9.0 <4.0.0"`. The Android runner refuses any other Flutter version (`toolchain_mismatch`).

## Implemented
- **Template set** (`apps/api/templates/flutter-core/` static Dart + `templates.ts` renderer): Material 3 theme from seed colours (light/dark), `go_router` navigation (shell with bottom NavigationBar, auth redirect), `flutter_riverpod` state, Arabic/English with RTL following the locale (`GlobalMaterialLocalizations`; the default locale comes from the spec), settings (language, theme), login screen against `POST {API_BASE_URL}/auth/login` (build-time `--dart-define`; without it the app says "not configured"), token in the platform keystore (`flutter_secure_storage`), forms (text, email, phone, number, password, multiline, choice, toggle; required/format validation), loading/empty/error views, generated tests. Platform folders are NOT stored: `flutter create --platforms=android` runs in the build worker with the pinned toolchain (stated in the generated README).
- **Mobile design agent** = run kind `mobile` registered on M09's `RunKindRegistry` (`/v1/ai/runs kind=mobile`, input `{description}` only): the model returns a STRUCTURED spec (`MOBILE_SPEC_SCHEMA`: screens, bilingual labels, tabs, theme, auth flag, permissions) validated by schema + semantic checks; a human approves it (M09 approval kind `plan`, bound to the exact spec); only then the trusted renderer writes the project, the static analysis gate runs, and a NEW immutable project version is committed (resumable; a replay after a crash finds the version by run id). The model never writes Dart: every spec string is escaped by `dartString` (tested with injection payloads). `toolKind: chat` = empty tool allow-list.
- **Mobile projects**: `POST /v1/builder/projects {type:'mobile'}` (migration 1510, `MobileProjectService` in the builder module). Site-model operations and previews refuse mobile projects with 422.
- **Dependency allow-list** (`pub-policy.ts`): 8 packages with exact constraints; git/path/url/hosted-elsewhere, overrides, unknown names and typosquats (one edit from an allow-listed name) are blocked; the resolved `pubspec.lock` must come from the allowed host (pub.dev locally, the scanning mirror in production: NOT CONNECTED) with a 200-package cap and an advisory hook.
- **Static gate** (`analysis.ts`): secrets, signing material, `dart:ffi/mirrors/isolate`, process execution, cleartext http, unsafe paths, required files.
- **Flag** `mobile_builder.enabled` (default OFF).

## Tests / real evidence
- Unit (`flutter-templates.spec.ts`, `pub-policy.spec.ts`, `copy-lint.spec.ts`, `runner.spec.ts`): 38 PASS.
- Integration `mobile.int.spec.ts` (20 PASS): flag off = 404; mobile project; run design → approval → version with files and manifest; deny leaves the project untouched; invalid design fails before any write; input validation; website project refused.
- **Local Flutter evidence on the rendered template** (`flutter-local.int.spec.ts`, `MOBILE_FLUTTER_LOCAL=1`, 2 PASS in 345 s; also run by hand): `flutter pub get` OK, **`flutter analyze`: No issues found**, **`flutter test`: All tests passed** (4 widget tests: default locale/direction, login failure stays signed out, every tab reachable, field validation).

## NOT VERIFIED / BLOCKED / DEFERRED
- Model quality: **NOT VERIFIED** (scripted adapter only; HG-09-01 / D-18).
- Web-rendered preview (S48.4): **not implemented** — 422 `unsupported_capability`; needs a web build worker and a preview store (SCR-M10B-03). "Preview ≠ device" is stated in the UI and README. No Flutter web build was run.
- The template was exercised on Android build tooling only; iOS/macOS compilation is BLOCKED (D-22). Arabic copy is original text; a native-speaker review is not done (NOT VERIFIED).
- No live pub mirror or advisory feed; the scripted fixture `SAMPLE_MOBILE_SPEC` is the only design the tests generate.
