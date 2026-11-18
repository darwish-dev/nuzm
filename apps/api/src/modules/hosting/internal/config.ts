export interface HostingConfig {
  /** share of a node's measured capacity kept back for the platform (PROPOSAL, HG-05-0x / owner) */
  reservePercent: number;
  /** hard cap of sites per node (PROPOSAL) */
  maxSitesPerNode: number;
  inventoryMaxAgeSeconds: number;
  /** placement strategy among eligible nodes: spread = most free capacity first, binpack = least free first (PROPOSAL default spread) */
  strategy: 'spread' | 'binpack';
  /** suffix of the platform-hosted placeholder domain every site gets until the customer binds one */
  defaultDomainSuffix: string;
  renewBeforeDays: number;
  enrolmentTtlMinutes: number;
  /** soft / hard quota thresholds in percent (PROPOSAL) */
  softPercent: number;
  hardPercent: number;
  /** export window before an offboarded site is wiped (days, PROPOSAL; HG-04-01) */
  exportWindowDays: number;
  backupRetentionDays: number;
  downloadLinkTtlSeconds: number;
}
export function loadHostingConfig(env: NodeJS.ProcessEnv = process.env): HostingConfig {
  const n = (k: string, d: number) => {
    const v = env[k] === undefined ? d : Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    reservePercent: Math.min(n('HOSTING_RESERVE_PERCENT', 10), 90),
    maxSitesPerNode: Math.max(1, n('HOSTING_MAX_SITES_PER_NODE', 200)),
    inventoryMaxAgeSeconds: n('HOSTING_INVENTORY_MAX_AGE_SECONDS', 900),
    strategy: env.HOSTING_PLACEMENT_STRATEGY === 'binpack' ? 'binpack' : 'spread',
    defaultDomainSuffix: env.HOSTING_DEFAULT_DOMAIN_SUFFIX ?? 'sites.nuzm.invalid',
    renewBeforeDays: n('HOSTING_RENEW_BEFORE_DAYS', 30),
    enrolmentTtlMinutes: n('HOSTING_ENROLMENT_TTL_MINUTES', 15),
    softPercent: n('HOSTING_QUOTA_SOFT_PERCENT', 80),
    hardPercent: n('HOSTING_QUOTA_HARD_PERCENT', 100),
    exportWindowDays: n('HOSTING_EXPORT_WINDOW_DAYS', 14),
    backupRetentionDays: n('HOSTING_BACKUP_RETENTION_DAYS', 30),
    downloadLinkTtlSeconds: n('HOSTING_DOWNLOAD_LINK_TTL_SECONDS', 300),
  };
}
