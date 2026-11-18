import type { Db } from '@nuzm/platform';

/**
 * Reads boolean (or `{enabled: true}`) feature flags from `platform.feature_flags`: a global row, overridden by an organization row (M11 uses
 * `automation.enabled`, `webhooks.enabled`, `marketplace.enabled`, `agency.enabled`, `reseller.enabled`). Every flag defaults to OFF: a missing
 * row means disabled. `FLAG_<KEY>=true` in the environment turns a flag on for tests and local development only (never in production).
 */
export class FlagReader {
  constructor(private readonly db: Db) {}

  async enabled(orgId: string | null, key: string): Promise<boolean> {
    const v = await this.value(orgId, key);
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }

  async value(orgId: string | null, key: string): Promise<unknown> {
    if (process.env.NODE_ENV !== 'production') {
      const env = process.env[`FLAG_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
      if (env === 'true') return true;
    }
    const rows = await this.db.withOrg(
      orgId ?? '00000000-0000-0000-0000-000000000000',
      async (c) =>
        (
          await c.query(
            `SELECT org_id, value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2) ORDER BY org_id NULLS FIRST`,
            [key, orgId],
          )
        ).rows as { org_id: string | null; value: unknown }[],
    );
    return rows[rows.length - 1]?.value;
  }
}
