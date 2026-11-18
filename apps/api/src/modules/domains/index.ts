// Public surface of the domains module (M07). Other modules import only from here.
export { DomainsModule } from './domains.module';
export { RegistrarAccessService } from './internal/registrar-access.service';
export type { AdapterFactory, RegistrarAccount } from './internal/registrar-access.service';
export { EligibilityService } from './internal/eligibility.service';
export { SearchService } from './internal/search.service';
export { DomainsFlags } from './internal/flags';
export {
  ADAPTER_FACTORIES,
  DOMAINS_VAULT,
  DOMAINS_CONFIG,
  HOSTING_READ_PORT,
  InMemoryHostingReadPort,
  domainsConfigFromEnv,
} from './internal/ports';
export type { DomainsConfig, HostingSiteReadPort, HostingSiteView } from './internal/ports';
export { loadTldPolicy, parseTldPolicy } from './internal/tld-policy';
export { RegistrarAdminService } from './internal/registrar-admin.service';
