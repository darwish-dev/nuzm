// Public surface of the deploy module (M09).
export { DeployModule } from './deploy.module';
export { DeployService } from './internal/deploy.service';
export {
  SitePublisherPort,
  InMemorySitePublisher,
  UnavailableSitePublisher,
  artifactHash,
} from './internal/ports';
export type {
  TargetSite,
  Artifact,
  ArtifactFile,
  SmokeResult,
  WebappDeployDelegate,
} from './internal/ports';
