import { Body, Controller, Get, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { AuditRetentionService } from './audit-retention.service';

@RealmOnly('admin')
@Controller('v1/admin/audit-retention')
export class AuditRetentionController {
  constructor(private readonly svc: AuditRetentionService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  get(@Platform() who: PlatformContext) {
    return this.svc.get(who.userId);
  }

  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Put()
  async put(
    @Platform() who: PlatformContext,
    @Body() b: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:compliance:manage'))
      throw new ProblemException('forbidden', 'permission admin:compliance:manage is required');
    const r = await this.svc.put(who.userId, b ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.policy;
  }
}
