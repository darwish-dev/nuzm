import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { FinrecService } from './internal/finrec.service';

/**
 * Financial reconciliation (docs/04): finance and platform admins run and resolve (`admin:billing:manage`), compliance officers read
 * (`admin:billing:read`). A run is asynchronous: the POST answers 202 with the queued runs; the scheduler (or the kick after the response) runs them.
 */
@RealmOnly('admin')
@Controller('v1/admin/billing/reconciliations')
export class AdminReconciliationsController {
  constructor(private readonly finrec: FinrecService) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get()
  list(@Query() q: { limit?: string; cursor?: string; type?: string; status?: string }) {
    return this.finrec.list({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      type: q.type,
      status: q.status,
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post()
  @HttpCode(202)
  async run(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:billing:manage'))
      throw new ProblemException('forbidden', 'permission admin:billing:manage is required');
    const runs = await this.finrec.request(who.userId, body ?? {});
    void reply.header('location', `/v1/admin/billing/reconciliations/${runs[0]!.id}`);
    this.finrec.kick(runs.map((r) => r.id));
    return { runs };
  }

  @RequirePlatformPermission('admin:billing:read')
  @Get(':id')
  get(@Param('id') id: string, @Query() q: { status?: string }) {
    return this.finrec.get(id, { itemStatus: q.status });
  }

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post(':id/resolutions')
  @HttpCode(201)
  resolve(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!who.permissions.has('admin:billing:manage'))
      throw new ProblemException('forbidden', 'permission admin:billing:manage is required');
    return this.finrec.resolve(who.userId, id, body ?? {});
  }
}
