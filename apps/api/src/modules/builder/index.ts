// Public surface of the builder module (M09). Other modules import ONLY from here.
export { BuilderModule } from './builder.module';
export { ProjectService } from './internal/project.service';
export { PreviewService, newPreviewToken } from './internal/preview.service';
export { VersionArtifactService } from './internal/artifact.service';
export {
  runWebsiteQa,
  repairFindings,
  repairText,
  summarize as summarizeQa,
} from './internal/qa/runner';
export { buildWebsiteArtifact } from './internal/qa/static-build';
export type { StaticBuildInput, StaticBuildResult } from './internal/qa/static-build';
export {
  artifactManifest,
  verifyAgainstManifest,
  verifyServedArtifact,
  loadArtifactDir,
  writeArtifactDir,
} from './internal/qa/artifact';
export type { ArtifactFile, ArtifactManifest, ManifestMismatch } from './internal/qa/artifact';
export { measureEditDiff, assertMinimalEdit } from './internal/qa/edit-diff';
export type { EditDiffStats } from './internal/qa/edit-diff';
export type { QaReport, QaFinding, QaOptions, GateId } from './internal/qa/types';
export {
  validatePreviewDomainConfig,
  renderEdgeConfig,
  runPreviewDomainValidation,
} from './internal/preview-domain';
export { LivePreviewRegistry } from './internal/live-preview';
export type { LivePreview } from './internal/live-preview';
export { FormsService, FormNotifier } from './internal/forms.service';
export { CmsService } from './internal/cms.service';
export { BUILDER_CONFIG, loadBuilderConfig } from './internal/model';
export type { BuilderConfig } from './internal/model';
export { installPreviewIsolation } from './isolation';
export { ProjectDelegates } from './internal/delegates';
export type { ProjectTypeDelegate } from './internal/delegates';
export {
  MobileProjectService,
  MOBILE_MAX_FILES,
  MOBILE_BUILDER_FLAG,
} from './internal/mobile-project.service';
export type {
  MobileManifest,
  MobileProjectView,
  MobileCommit,
} from './internal/mobile-project.service';
export { ContentAccessService, ContentAccessGuard, ContentRead } from './content-access';
