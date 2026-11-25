/**
 * Structured build errors for the repair loop (P3-S03, target T5). A parser turns raw tool output (Dart analyzer / compiler, `flutter test`, `pub`, Gradle/Kotlin/Java, Xcode/Swift/CocoaPods)
 * into `ParsedBuildError[]`; the repair loop classifies by `errorClass`, picks a strategy from `fix`, and edits only `targetFiles`.
 *
 * `fix` says WHAT KIND of change can repair the error inside the Nuzm project model:
 *  - `edit_source`     a Dart (or other project) source edit: the model patches the file at `file:line`.
 *  - `edit_pubspec`    a dependency edit (restricted to the pub allow-list by `internal/policy/pub-policy.ts`).
 *  - `edit_android_config`  the declarative Android settings in `tool/nuzm-mobile.json` (`android.minSdk`, `android.compileSdk`): AI-written Gradle is never accepted, so a Gradle
 *                      version mismatch is repaired by changing these bounded numbers, not the Gradle files.
 *  - `edit_ios_config` the declarative iOS settings in `tool/nuzm-mobile.json` (`ios.deploymentTarget`).
 *  - `regenerate_platform` the `android/` or `ios/` folder (always produced by the pinned `flutter create`, never AI-written) is out of step with the toolchain: the orchestrator
 *                      deletes it and recreates it deterministically; no model call is needed.
 *  - `environment`     the build ENVIRONMENT is wrong (SDK missing, licence, JDK, disk, Xcode): no project patch can help; the loop must stop and report, never "repair" the project.
 *  - `retry`           transient (network, daemon crash, out of memory): a bounded retry, reconcile before retrying.
 *  - `none`            unknown: show the raw excerpt to the model once, then stop.
 */
export type BuildTool =
  | 'dart'
  | 'flutter-test'
  | 'pub'
  | 'gradle'
  | 'kotlin'
  | 'java'
  | 'xcode'
  | 'swift'
  | 'cocoapods'
  | 'flutter'
  | 'unknown';
export type FixKind =
  | 'edit_source'
  | 'edit_pubspec'
  | 'edit_android_config'
  | 'edit_ios_config'
  | 'regenerate_platform'
  | 'environment'
  | 'retry'
  | 'none';
export type BuildErrorClass =
  // Dart (analyzer / front-end compiler)
  | 'dart_type_error'
  | 'dart_undefined_name'
  | 'dart_missing_import'
  | 'dart_syntax_error'
  | 'dart_missing_argument'
  | 'dart_null_safety'
  | 'dart_other_error'
  // tests
  | 'test_failure'
  | 'test_compile_error'
  // pub
  | 'pub_missing_package'
  | 'pub_version_conflict'
  | 'pub_sdk_constraint'
  | 'pub_network'
  // Gradle / Android
  | 'gradle_version_mismatch'
  | 'gradle_compile_sdk_mismatch'
  | 'gradle_min_sdk_mismatch'
  | 'gradle_dependency_resolution'
  | 'gradle_java_version'
  | 'gradle_sdk_missing'
  | 'gradle_licence_not_accepted'
  | 'gradle_out_of_memory'
  | 'gradle_native_compile_error'
  | 'gradle_other'
  // Xcode / iOS
  | 'xcode_not_installed'
  | 'xcode_licence_not_accepted'
  | 'xcode_signing_required'
  | 'xcode_deployment_target'
  | 'xcode_swift_error'
  | 'xcode_missing_module'
  | 'cocoapods_missing'
  | 'cocoapods_resolution'
  | 'xcode_no_destination'
  | 'xcode_other'
  | 'unknown';
export interface ParsedBuildError {
  tool: BuildTool;
  errorClass: BuildErrorClass;
  severity: 'error' | 'warning';
  /** one-line message, control characters removed, at most 500 chars */
  message: string;
  /** project-relative path when the tool reported one that is inside the project; absolute paths are reduced or dropped */
  file?: string;
  line?: number;
  column?: number;
  /** the tool's own rule/error code when it prints one (Dart `argument_type_not_assignable`, Gradle task path, ...) */
  code?: string;
  fix: FixKind;
  /** project files a repair may edit (never platform folders, never Gradle/Podfile) */
  targetFiles: string[];
  /** short, tool-neutral instruction the repair prompt can include */
  hint: string;
  /** the verbatim lines the error was parsed from (redacted, capped) */
  excerpt: string;
}
export interface ParseResult {
  errors: ParsedBuildError[];
  /** true when the output contains no recognisable failure (a successful build, or an empty log) */
  clean: boolean;
  /** truncated and redacted tail of the raw input, for the "unknown" fallback */
  tail: string;
}
export const MAX_ERRORS = 50;
