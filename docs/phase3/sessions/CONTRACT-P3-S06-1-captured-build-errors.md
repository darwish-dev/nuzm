# CONTRACT request P3-S06-1 — captured real build errors for S03's repair corpus

From P3-S06 to the Master (for P3-S03, who owns the repair strategy corpus). No shared file of the Master is touched; this is a hand-over so S03 can copy or reference the fixtures.

**What exists (REAL-LOCAL: real Flutter 3.35.7 tool output on the owner's Mac, from deliberately broken copies of OUR template; no model-generated project; host paths scrubbed):**
`apps/api/src/modules/mobile/internal/builds/errors/fixtures/`
- `captured-dart-analyze.log`: type error (`return_of_invalid_type`), undefined name, missing package URI, bad relative import, plus an `info` line the parser drops.
- `captured-flutter-test-fail.log`: a failing `expect` with the stack (`test/broken_test.dart 2:39`).
- `captured-pub-missing.log`: `pub get` for a package that does not exist.
All three are classified correctly by `parseBuildOutput` (`dart_type_error`, `dart_undefined_name`, `pub_missing_package`/`dart_missing_import`, `test_failure`) in `flutter-capture.int.spec.ts` (3 passed).

**What does NOT exist:** a real Gradle/Xcode failure log. `android.minSdk=21` and `android.compileSdk=34` both built fine on this template, so the Gradle fixtures (`synthetic-gradle-*`) are SIMULATED. S03 must label Gradle/Xcode corpus entries SIMULATED until a real failure is captured (the capture test is ready: `MOBILE_CAPTURE_FIXTURES=1`).

**API for S03:** `parseBuildOutput`, `failureFromStage`, `repairAction` and the error types are exported from `apps/api/src/modules/mobile/index.ts`. `fix` kinds: `edit_source | edit_pubspec | edit_android_config | edit_ios_config | regenerate_platform | environment | retry | none`. `environment` is final (never "repaired"); `targetFiles` never include Gradle/Podfile/generated files; `lib/generated/**` is changed through the spec.

**Request:** S03 references or copies the three `captured-*` fixtures into its corpus with the label REAL-LOCAL; no change to any Master-owned file is needed.
