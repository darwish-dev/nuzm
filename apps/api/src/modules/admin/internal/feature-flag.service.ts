import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';

const KEY = /^[a-z][a-z0-9_.-]{1,63}$/;
const NIL = '00000000-0000-0000-0000-000000000000';

export interface FlagRow {
  key: string;
  scope: 'global' | 'org';
  orgId: string | null;
  value: unknown;
  updatedAt: string;
}

export class FeatureFlagService {
  constructor(private readonly db: Db) {}

  async list(): Promise<FlagRow[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT key, org_id, value, updated_at FROM platform.feature_flags ORDER BY key, org_id NULLS FIRST`,
        )
      ).rows.map((r) => ({
        key: r.key,
        scope: r.org_id ? ('org' as const) : ('global' as const),
        orgId: r.org_id,
        value: r.value,
        updatedAt: r.updated_at.toISOString(),
      })),
    );
  }

  /** Upsert a flag; returns the previous value (for the audit trail) and the stored row. */
  async set(
    input: { key: string; scope: 'global' | 'org'; orgId?: string; value: unknown },
    actorUserId: string,
  ): Promise<{ before: unknown; after: FlagRow }> {
    if (!KEY.test(input.key)) throw new ProblemException('validation_failed', 'invalid flag key');
    if (input.scope !== 'global' && input.scope !== 'org')
      throw new ProblemException('validation_failed', 'scope must be global or org');
    if ((input.scope === 'org') !== (input.orgId !== undefined))
      throw new ProblemException(
        'validation_failed',
        'orgId is required for org scope and forbidden for global',
      );
    if (input.value === undefined || JSON.stringify(input.value).length > 4000)
      throw new ProblemException('validation_failed', 'value must be JSON of at most 4000 bytes');
    const orgId = input.scope === 'org' ? input.orgId! : null;
    return this.db.withPlatformScope(async (c) => {
      if (orgId) {
        const ok = await c.query(
          `SELECT 1 FROM tenancy.organizations WHERE id = $1 AND deleted_at IS NULL`,
          [orgId],
        );
        if (!ok.rowCount) throw new ProblemException('not_found');
      }
      const prev = (
        await c.query(
          `SELECT value FROM platform.feature_flags WHERE key = $1 AND COALESCE(org_id, $3) = COALESCE($2, $3)`,
          [input.key, orgId, NIL],
        )
      ).rows[0];
      const row = (
        await c.query(
          `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (key, COALESCE(org_id, '${NIL}'::uuid))
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING key, org_id, value, updated_at`,
          [uuidv7(), input.key, orgId, JSON.stringify(input.value), actorUserId],
        )
      ).rows[0]!;
      return {
        before: prev?.value ?? null,
        after: {
          key: row.key,
          scope: row.org_id ? 'org' : 'global',
          orgId: row.org_id,
          value: row.value,
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }
}
