import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { ControlsService } from './internal/controls/controls.service';

/** The control register (docs/04): read the catalog with its mappings and evidence status; map a control to a feature. It never states a verdict. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/controls')
export class AdminControlsController {
  constructor(private readonly controls: ControlsService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Query()
    q: {
      status?: string;
      applicability?: string;
      ownerRole?: string;
      framework?: string;
      controlId?: string;
    },
  ) {
    return this.controls.list(q);
  }

  /** Needs `admin:controls:manage`, a recent MFA check and an Idempotency-Key. 201 when a mapping was written, 200 on a replay. */
  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async map(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:controls:manage'))
      throw new ProblemException('forbidden', 'permission admin:controls:manage is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.controls.map(who.userId, key, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.mapping;
  }
}
