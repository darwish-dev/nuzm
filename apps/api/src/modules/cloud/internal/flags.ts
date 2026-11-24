import type { Db } from '@nuzm/platform';

export const CLOUD_FLAG = 'cloud.provisioning';
/** S04: a VPS that installs HestiaCP. Default OFF until acceptance (CLAUDE.md §4). */
export const HESTIA_VPS_FLAG = 'cloud.hestia_vps';

/**
 * Feature flag for every customer-facing M05 capability (offers, compute quotes, instances): default OFF until acceptance (CLAUDE.md §4).
 * An org-level flag overrides the global one. `CLOUD_PROVISIONING_ENABLED=true` forces it on for local dev stacks only.
 */
export class CloudFlags {
  constructor(private readonly db: Db) {}
  async enabled(orgId: string): Promise<boolean> {
    if (process.env.CLOUD_PROVISIONING_ENABLED === 'true' && process.env.NODE_ENV !== 'production')
      return true;
    return this.flag(orgId, CLOUD_FLAG);
  }
  /** `cloud.hestia_vps` (`HESTIA_VPS_ENABLED=true` forces it on for local dev stacks only). */
  async hestiaVpsEnabled(orgId: string): Promise<boolean> {
    if (process.env.HESTIA_VPS_ENABLED === 'true' && process.env.NODE_ENV !== 'production')
      return true;
    return this.flag(orgId, HESTIA_VPS_FLAG);
  }
  private async flag(orgId: string, key: string): Promise<boolean> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT org_id, value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2) ORDER BY org_id NULLS FIRST`,
            [key, orgId],
          )
        ).rows,
    );
    const row = rows[rows.length - 1]; // the org row (sorted last) wins over the global row
    const v = row?.value as unknown;
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }
}
