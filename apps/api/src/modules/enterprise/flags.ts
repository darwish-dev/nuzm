import type { Db } from '@nuzm/platform';

export const SSO_FLAG = 'enterprise.sso';
export const SCIM_FLAG = 'enterprise.scim';

/**
 * Feature flags for the customer-facing enterprise capabilities: default OFF until acceptance (CLAUDE.md §4). An organization-level flag overrides the
 * global one (platform.feature_flags). `ENTERPRISE_ENABLED=true` forces both on for local dev stacks and tests only (never in production).
 */
export class EnterpriseFlags {
  constructor(private readonly db: Db) {}

  async enabled(orgId: string, key: typeof SSO_FLAG | typeof SCIM_FLAG): Promise<boolean> {
    if (process.env.ENTERPRISE_ENABLED === 'true' && process.env.NODE_ENV !== 'production')
      return true;
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
    const v = rows[rows.length - 1]?.value as unknown;
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }
}
