import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { DOMAINS_FLAG } from './common';

/**
 * Feature flag for every customer-facing M07 capability: default OFF until acceptance (CLAUDE.md §4). An org-level flag overrides the global one.
 * `DOMAINS_ENABLED=true` forces it on for local dev stacks only (never in production).
 */
export class DomainsFlags {
  constructor(private readonly db: Db) {}
  async enabled(orgId: string): Promise<boolean> {
    if (process.env.DOMAINS_ENABLED === 'true' && process.env.NODE_ENV !== 'production')
      return true;
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT org_id, value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2) ORDER BY org_id NULLS FIRST`,
            [DOMAINS_FLAG, orgId],
          )
        ).rows,
    );
    const v = rows[rows.length - 1]?.value as unknown;
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }
  /** The GLOBAL flag only (no organization): what the public website's domain checker depends on. */
  async enabledGlobally(): Promise<boolean> {
    if (process.env.DOMAINS_ENABLED === 'true' && process.env.NODE_ENV !== 'production')
      return true;
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND org_id IS NULL`,
            [DOMAINS_FLAG],
          )
        ).rows,
    );
    const v = rows[0]?.value as unknown;
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }
  /** The feature does not exist for an organization that does not have it (404, never 403). */
  async assert(orgId: string): Promise<void> {
    if (!(await this.enabled(orgId))) throw new ProblemException('not_found');
  }
}
