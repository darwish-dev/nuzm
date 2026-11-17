// Public surface of the cloud module (M05). Other modules import only from here.
export { CloudModule, VAULT } from './cloud.module';
export { AdapterRegistry, defaultAdapterRegistry, isProduction } from './internal/adapter-registry';
export type { AdapterEntry } from './internal/adapter-registry';
export { ProviderService } from './internal/provider.service';
export { ProviderAccountService } from './internal/account.service';
export type { AccountDto, JobDto } from './internal/account.service';
export { CatalogService } from './internal/catalog.service';
export { HealthService } from './internal/health.service';
