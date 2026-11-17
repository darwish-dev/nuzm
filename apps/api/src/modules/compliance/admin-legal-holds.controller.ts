import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { LegalHoldService } from './internal/legal-hold.service';

/** Legal holds (docs/04): dual approval; create, decide and release through one POST. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/legal-holds')
export class AdminLegalHoldsController {
  constructor(private readonly holds: LegalHoldService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async handle(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:compliance:manage'))
      throw new ProblemException('forbidden', 'permission admin:compliance:manage is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.holds.handle(who.userId, key, body ?? {});
    const creating = body?.holdId === undefined;
    void reply.status(r.created && creating ? 201 : 200);
    return r.hold;
  }
}
