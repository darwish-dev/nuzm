import type { VaultClient } from '@nuzm/registrar-contracts';

/**
 * Ports of the domains module. Everything the module needs from modules that are not built on this base (M05 provider framework, M06 hosting) goes
 * through one of these, so integration is mechanical (docs/reports/M07-m05-interface-assumptions.md).
 */
export const DOMAINS_VAULT = Symbol('DOMAINS_VAULT');
export const ADAPTER_FACTORIES = Symbol('DOMAINS_ADAPTER_FACTORIES');
export const HOSTING_READ_PORT = Symbol('DOMAINS_HOSTING_READ_PORT');
export const DOMAINS_CONFIG = Symbol('DOMAINS_CONFIG');
export type { VaultClient };
/** The vault as the domains module uses it: resolve references, and store one-time secrets (transfer auth codes) returning a reference. */
export interface DomainsVaultClient extends VaultClient {
  put(secret: string, label: string): Promise<string>;
}

export interface DomainsConfig {
  /** Quote currency of the platform (price books are SAR-based today). */
  currency: string;
  /** Registrar cost currency → quote currency rate as exact decimal strings (`{"SAR":"1","USD":"3.75"}`); a currency without a rate cannot be priced (never guessed). */
  fx: Record<string, string>;
  /** Markup over provider cost in basis points. D-23 (margin policy) is OPEN: the default is 0, an owner decision sets it. */
  markupBps: number;
  availabilityTtlSeconds: number;
  catalogTtlSeconds: number;
  searchRatePerMinute: number;
  quoteTtlMinutes: number;
  /** A non-live registrar account may be enabled only in non-production profiles (CLAUDE.md §5: mock results are never vendor evidence). */
  allowNonLiveRegistrars: boolean;
  webhookToleranceMs: number;
  /** Targets under these suffixes belong to Nuzm hosting (DNS takeover protection). */
  protectedTargetSuffixes: string[];
  maxRecordsPerZone: number;
  /** Per registrar account: local token bucket (docs/09 §1 rule 5). */
  accountBurst: number;
  accountRatePerSecond: number;
  defaultNameservers: string[];
}
export function domainsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DomainsConfig {
  const prod = env.NODE_ENV === 'production';
  return {
    currency: env.DOMAINS_CURRENCY ?? 'SAR',
    fx: env.DOMAINS_FX_JSON
      ? (JSON.parse(env.DOMAINS_FX_JSON) as Record<string, string>)
      : { SAR: '1', USD: '3.75' },
    markupBps: Number(env.DOMAINS_MARKUP_BPS ?? 0),
    availabilityTtlSeconds: Number(env.DOMAINS_AVAILABILITY_TTL_SECONDS ?? 60),
    catalogTtlSeconds: Number(env.DOMAINS_CATALOG_TTL_SECONDS ?? 900),
    searchRatePerMinute: Number(env.DOMAINS_SEARCH_RATE_PER_MINUTE ?? 60),
    quoteTtlMinutes: Number(env.QUOTE_TTL_MINUTES ?? 15),
    allowNonLiveRegistrars: !prod && env.DOMAINS_ALLOW_NON_LIVE_REGISTRARS === 'true',
    webhookToleranceMs: Number(env.DOMAINS_WEBHOOK_TOLERANCE_MS ?? 300_000),
    protectedTargetSuffixes: (env.DOMAINS_PROTECTED_TARGET_SUFFIXES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxRecordsPerZone: Number(env.DOMAINS_MAX_RECORDS_PER_ZONE ?? 500),
    accountBurst: Number(env.DOMAINS_ACCOUNT_BURST ?? 20),
    accountRatePerSecond: Number(env.DOMAINS_ACCOUNT_RATE_PER_SECOND ?? 10),
    defaultNameservers: (
      env.DOMAINS_DEFAULT_NAMESERVERS ?? 'ns1.nuzm-dns.invalid,ns2.nuzm-dns.invalid'
    )
      .split(',')
      .map((s) => s.trim()),
  };
}

/**
 * M06 `HostingSiteReadPort` (docs M06/M07): what the linkage needs from a hosting site. Real implementation arrives with M06; dev/CI use `InMemoryHostingReadPort`.
 * `targets` are the addresses/hosts the site's node serves from (never invented here).
 */
export interface HostingSiteView {
  id: string;
  orgId: string;
  state: 'active' | 'suspended' | 'provisioning' | 'deleted';
  targets: { ipv4: string[]; ipv6: string[]; cname: string | null };
  ssl: { state: 'none' | 'pending' | 'issued' | 'failed'; challenge: 'http-01' | 'dns-01' };
}
export interface HostingSiteReadPort {
  getSite(orgId: string, siteId: string): Promise<HostingSiteView | null>;
}
export class InMemoryHostingReadPort implements HostingSiteReadPort {
  private readonly sites = new Map<string, HostingSiteView>();
  put(site: HostingSiteView): void {
    this.sites.set(site.id, site);
  }
  async getSite(orgId: string, siteId: string): Promise<HostingSiteView | null> {
    const s = this.sites.get(siteId);
    return s && s.orgId === orgId ? s : null;
  }
}
