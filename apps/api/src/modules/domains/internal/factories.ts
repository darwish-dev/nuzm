import {
  OpenproviderAdapter,
  OPENPROVIDER_HOSTS,
  OPENPROVIDER_PRODUCTION_URL,
  OPENPROVIDER_SANDBOX_URL,
} from '@nuzm/adapter-openprovider';
import {
  RESELLERCLUB_DOMAINCHECK_URL,
  RESELLERCLUB_HOSTS,
  RESELLERCLUB_PRODUCTION_URL,
  RESELLERCLUB_TEST_URL,
  ResellerClubAdapter,
} from '@nuzm/adapter-resellerclub';
import {
  FetchHttpClient,
  VaultError,
  type SecretMaterial,
  type VaultClient,
} from '@nuzm/registrar-contracts';
import type { DomainsConfig } from './ports';
import type { AdapterFactory } from './registrar-access.service';

/** The real vault client does not exist yet (D-12 open, HG-01-02): every resolve is refused, so no adapter can ever read a credential by accident. */
export class UnavailableVault implements VaultClient {
  /** Storing a secret (a transfer auth code) is refused too: there is no vault to put it in. */
  async put(_code: string, _label: string): Promise<string> {
    throw new VaultError('blocked', 'no vault client is configured (D-12)');
  }
  async resolve(ref: string): Promise<SecretMaterial> {
    throw new VaultError(
      'blocked',
      `no vault client is configured (D-12); cannot resolve ${ref.slice(0, 14)}…`,
    );
  }
}

/**
 * Production adapter factories. Egress is limited to the vendor hosts (M05 §9 SSRF guard): the allow-lists are the documented API hosts only. Evidence is
 * labelled `live` ONLY here; the dev/CI wiring overrides these factories with mock-server ones (`mock`), so a mock can never produce LIVE-VERIFIED.
 * NOTE: there is no live path today: without a vault client nothing can be probed, and no sandbox credentials exist (HG-07-01).
 */
export function productionFactories(cfg: DomainsConfig): Record<string, AdapterFactory> {
  return {
    openprovider: (a, d) =>
      new OpenproviderAdapter({
        baseUrl:
          a.environment === 'production' ? OPENPROVIDER_PRODUCTION_URL : OPENPROVIDER_SANDBOX_URL,
        http: new FetchHttpClient({ adapterId: 'openprovider', hosts: OPENPROVIDER_HOSTS }),
        vault: d.vault,
        evidenceKind: 'live',
      }),
    resellerclub: (a, d) =>
      new ResellerClubAdapter({
        baseUrl:
          a.environment === 'production' ? RESELLERCLUB_PRODUCTION_URL : RESELLERCLUB_TEST_URL,
        domainCheckUrl: RESELLERCLUB_DOMAINCHECK_URL,
        http: new FetchHttpClient({ adapterId: 'resellerclub', hosts: RESELLERCLUB_HOSTS }),
        vault: d.vault,
        evidenceKind: 'live',
        currency: a.currency,
        defaultNameservers: cfg.defaultNameservers,
      }),
  };
}
