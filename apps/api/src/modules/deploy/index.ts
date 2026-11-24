// Public surface of the deploy module (M09).
export { DeployModule } from './deploy.module';
export { DeployService } from './internal/deploy.service';
export {
  SitePublisherPort,
  InMemorySitePublisher,
  UnavailableSitePublisher,
  artifactHash,
} from './internal/ports';
export { SimulatedHealthProbe } from './internal/simulated-health';
export type { HealthProbeLike } from './internal/simulated-health';
export type {
  TargetSite,
  Artifact,
  ArtifactFile,
  SmokeResult,
  WebappDeployDelegate,
} from './internal/ports';
export {
  DeployPolicyService,
  DEFAULT_DEPLOY_POLICY,
  PUBLISH_ROLES,
} from './internal/policy.service';
export type { DeployPolicy, PublishRole } from './internal/policy.service';
export {
  TARGET_BY_PRODUCT_TYPE,
  SIMULATED_STAGING_TARGET,
  decideTarget,
  assertStagingTargetUsable,
  StagingTargetRefused,
} from './internal/targets';
export type { StagingTarget, DeployTargetKind, TargetRule, ProductType } from './internal/targets';
export {
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  InMemoryHostingSiteOps,
  UnavailableArtifactTransport,
} from './internal/hosting-target';
export type { ArtifactTransport, HostingSiteOps } from './internal/hosting-target';
