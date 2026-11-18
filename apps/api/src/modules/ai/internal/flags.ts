import type { Db } from '@nuzm/platform';
import { AI_FLAG, AI_KILLSWITCH } from './model';

const truthy = (v: unknown) =>
  v === true ||
  (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);

/**
 * `ai.enabled` (feature flag, default OFF; an org row beats the global row) and `ai.killswitch` (global OR org row ON stops every call; NOT cached, so a toggle
 * takes effect on the next call: AC "kill switch ≤ 5 s" is met by construction).
 */
export class AiFlags {
  constructor(private readonly db: Db) {}
  private async read(orgId: string, key: string): Promise<boolean> {
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
    return rows.length > 0 && truthy(rows[rows.length - 1]?.value as unknown);
  }
  enabled(orgId: string) {
    return this.read(orgId, AI_FLAG);
  }
  async killSwitch(orgId: string): Promise<boolean> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2)`,
            [AI_KILLSWITCH, orgId],
          )
        ).rows,
    );
    return rows.some((r) => truthy(r.value as unknown)); // ANY level ON stops calls
  }
}
