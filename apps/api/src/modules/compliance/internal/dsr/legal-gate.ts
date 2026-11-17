import type { Db } from '@nuzm/platform';

/**
 * The legal-hold check for erasure (M04 S13c holds, S14b use): an active hold on the organization, or on any dataset the handler touches, blocks it.
 * Reads under the admin scope (holds are platform records); never writes.
 */
export class LegalHoldGate {
  constructor(private readonly db: Db) {}
  async blocking(orgId: string, datasets: readonly string[]): Promise<string | null> {
    const r = await this.db.withPlatformScope((c) =>
      c.query(
        `SELECT id FROM audit.legal_holds WHERE status = 'active' AND (org_id = $1 OR org_id IS NULL) AND (dataset IS NULL OR dataset = ANY($2::text[])) ORDER BY created_at LIMIT 1`,
        [orgId, [...datasets]],
      ),
    );
    return (r.rows[0]?.id as string | undefined) ?? null;
  }
}
