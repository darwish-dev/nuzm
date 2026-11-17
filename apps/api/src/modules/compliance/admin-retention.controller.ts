import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { RetentionService } from './internal/retention.service';

/** Retention policies (docs/04): compliance officers and platform admins. Policies are versioned; `evaluate=true` is a DRY RUN (counts only). */
@RealmOnly('admin')
@Controller('v1/admin/compliance/retention-policies')
export class AdminRetentionController {
  constructor(private readonly retention: RetentionService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  async list(
    @Platform() who: PlatformContext,
    @Query()
    q: {
      dataClass?: string;
      dataset?: string;
      history?: string;
      evaluate?: string;
      execute?: string;
      asOf?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    if (q.execute !== undefined)
      throw new ProblemException(
        'validation_failed',
        'execution is not available through the API: archival is a break-glass procedure (docs/runbooks/retention-archival.md)',
      );
    const page = await this.retention.list({
      dataClass: q.dataClass,
      dataset: q.dataset,
      history: q.history === 'true',
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
    if (q.evaluate !== 'true') return { ...page, preview: null };
    const asOf = q.asOf ? new Date(q.asOf) : new Date();
    return { ...page, preview: await this.retention.preview(who.userId, asOf) };
  }

  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Put()
  async put(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:compliance:manage'))
      throw new ProblemException('forbidden', 'permission admin:compliance:manage is required');
    const r = await this.retention.put(who.userId, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.policy;
  }
}
