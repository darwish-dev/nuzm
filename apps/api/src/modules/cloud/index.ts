// Public surface of the cloud module (M05). Other modules import only from here.
export { CloudModule, VAULT } from './cloud.module';
export { AdapterRegistry, defaultAdapterRegistry, isProduction } from './internal/adapter-registry';
export type { AdapterEntry } from './internal/adapter-registry';
export { ProviderService } from './internal/provider.service';
export { ProviderAccountService } from './internal/account.service';
export type { AccountDto, JobDto } from './internal/account.service';
export { CatalogService } from './internal/catalog.service';
export { HealthService } from './internal/health.service';
export { OfferService } from './internal/offer.service';
export type { OfferCandidate } from './internal/offer.service';
export { RoutingService } from './internal/routing.service';
export {
  ProvisioningService,
  OP_CREATE,
  OP_DELETE,
  OP_ACTION,
  COMPUTE_OP_KINDS,
} from './internal/provisioning.service';
export { ReconcilerService, reconcileConfigFromEnv } from './internal/reconciler.service';
export type { ReconcileOutcome, ReconcileConfig } from './internal/reconciler.service';
export { InstanceService } from './internal/instance.service';
export type { InstanceDto } from './internal/instance.service';
export { ComputeMeteringSampler } from './internal/metering-sampler';
export { CloudFlags, CLOUD_FLAG } from './internal/flags';
export { ComputeQuotaGuard } from './internal/quota-guard';
