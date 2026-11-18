import type { Db } from '@nuzm/platform';

/**
 * Feature flags `data.<service>.<provider>` (M08 §1), default OFF. A flag is `platform.feature_flags` (a global row; an org row overrides it).
 * `DATA_LOCAL_REFERENCE=true` (never in production) switches on the flags of the dev-reference providers (`mock-*`, `local-*`) only.
 */
export const dataFlagKey = (service: string, provider: string) => `data.${service}.${provider}`;
export const localReferenceEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.DATA_LOCAL_REFERENCE === 'true' && env.NODE_ENV !== 'production';

export class DataFlags {
  constructor(private readonly db: Db) {}
  async enabled(orgId: string | null, service: string, provider: string): Promise<boolean> {
    if (localReferenceEnabled() && /^(mock|local)-/.test(provider)) return true;
    const key = dataFlagKey(service, provider);
    const rows = await this.db.withOrg(
      orgId ?? '00000000-0000-0000-0000-000000000000',
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
