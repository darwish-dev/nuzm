import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { AdminResourceService } from './internal/admin-resource.service';

/** Cross-organization resource inventory (reads are audited) and forced reconciliation. */
@RealmOnly('admin')
@Controller('v1/admin/resources')
export class AdminResourcesController {
  constructor(private readonly resources: AdminResourceService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  list(@Platform() who: PlatformContext, @Query() q: Record<string, string>) {
    return this.resources.list(who.userId, q);
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post(':id/reconciliations')
  @HttpCode(202)
  force(@Platform() who: PlatformContext, @Param('id') id: string, @Req() req: FastifyRequest) {
    return this.resources.force(who.userId, id, req.traceId);
  }
}
