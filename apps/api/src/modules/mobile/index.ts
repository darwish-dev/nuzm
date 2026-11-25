// Public surface of the mobile module (M10B: Flutter generation, builds, signing references, release preparation).
export { MobileModule, makeBuildRunner, makeArtifactBytes } from './mobile.module';
export { MOBILE_BUILDER_FLAG } from './internal/flag.guard';
export { BuildService } from './internal/builds/build.service';
export { SigningService, SigningStagePort } from './internal/signing/signing.service';
export { ReleaseService } from './internal/releases/release.service';
export { copyLint } from './internal/releases/copy-lint';
export { generateFlutterProject } from './internal/flutter/templates';
export { validateMobileSpec } from './internal/flutter/spec';
export type { MobileSpec } from './internal/flutter/spec';
export { PINNED_TOOLCHAIN } from './internal/flutter/toolchain';
export { PUB_ALLOWLIST } from './internal/policy/pub-policy';
export { parseBuildOutput, failureFromStage, repairAction } from './internal/builds/errors';
export type {
  ParsedBuildError,
  ParseResult,
  BuildErrorClass,
  FixKind,
  RepairAction,
  BuildStage,
} from './internal/builds/errors';
export {
  assessBuildEnvironment,
  requireDisposableEnvironment,
} from './internal/builds/build-env-guard';
export { inspectApk } from './internal/builds/apk-evidence';
export { MacosIosRunner } from './internal/builds/ios-runner';
