import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { DB } from '../../../common/tokens';

export const HOSTING_FLAG = 'hosting.enabled';

/** Feature flag for every new capability, default OFF until acceptance (CLAUDE.md §4): `platform.feature_flags` key `hosting.enabled`; an organization row beats the global row. */
@Injectable()
export class HostingEnabledGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const orgId = req.access?.orgId;
    if (!orgId) return true; // the access guard decides authentication; staff routes are not flag-gated
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY org_id NULLS LAST LIMIT 1`,
            [HOSTING_FLAG, orgId],
          )
        ).rows[0],
    );
    if (row?.value !== true && row?.value?.enabled !== true)
      throw new ProblemException('not_found', 'hosting is not enabled for this organization');
    return true;
  }
}
